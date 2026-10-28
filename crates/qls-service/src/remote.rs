//! Access from other devices: the browser UI, the password login and the network listener.
//! The rules (hashing, sessions, attempt limit, what a browser may call) are in
//! `qls_core::remote`; this file is the HTTP side.
//!
//! Two listeners serve the same router: loopback (`service_port`, the desktop app, the MCP
//! server and scripts, with the token) and, only while access is on *and* a password is set,
//! all interfaces (`remote_port`), where the token is refused and only a signed-in browser
//! gets in. Both serve the UI at `/`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime};

use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use qls_core::{
    error::{AppError, ErrorCode},
    remote::{self, Limiter, SESSION_COOKIE, SESSION_TTL, Sessions},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;

/// Who is calling: the token (desktop app, MCP, scripts on this computer) or a browser
/// signed in with the password.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    Local,
    Browser,
}

/// Header a browser adds to every request that changes something. Another site cannot send
/// it (it would need a CORS preflight, which only the desktop origins pass), so together with
/// the `SameSite=Strict` cookie it stops cross-site requests.
pub const CSRF_HEADER: &str = "x-kokon-csrf";

pub struct RemoteState {
    file: PathBuf,
    hash: RwLock<Option<String>>,
    /// Modification time of the password file when last read (a `--set-password` from a
    /// terminal is picked up without a restart).
    seen: Mutex<Option<SystemTime>>,
    pub sessions: Sessions,
    pub limiter: Limiter,
    /// `--remote`: on for this run whatever the setting says (headless, Docker).
    pub forced: bool,
    listener: Mutex<Option<Lan>>,
    error: Mutex<Option<String>>,
    /// Bumped when every session ends, so open event streams of browsers close too.
    pub epoch: tokio::sync::watch::Sender<u64>,
}

struct Lan {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl RemoteState {
    pub fn new(data_dir: &std::path::Path, forced: bool) -> Self {
        let file = remote::password_file(data_dir);
        let seen = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
        let hash = remote::load_hash(&file);
        // Sign-ins from before a restart stay, as long as the password is the same.
        let sessions = Sessions::open(remote::sessions_file(data_dir), hash.as_deref(), SystemTime::now());
        Self {
            hash: RwLock::new(hash),
            seen: Mutex::new(seen),
            file,
            sessions,
            limiter: Limiter::default(),
            forced,
            listener: Mutex::new(None),
            error: Mutex::new(None),
            epoch: tokio::sync::watch::channel(0).0,
        }
    }

    pub fn password_set(&self) -> bool {
        self.hash.read().unwrap().is_some()
    }

    fn end_sessions(&self) {
        self.sessions.clear(self.hash().as_deref());
        self.epoch.send_modify(|e| *e += 1);
    }

    /// Reads the password file again if it changed; returns whether it did.
    pub fn reload_if_changed(&self) -> bool {
        let mtime = std::fs::metadata(&self.file).and_then(|m| m.modified()).ok();
        let mut seen = self.seen.lock().unwrap();
        if *seen == mtime {
            return false;
        }
        *seen = mtime;
        let new = remote::load_hash(&self.file);
        let mut h = self.hash.write().unwrap();
        if *h == new {
            return false;
        }
        *h = new;
        drop(h);
        self.end_sessions();
        true
    }

    pub fn set_password(&self, password: &str) -> Result<(), AppError> {
        let hash = remote::set_password(&self.file, password)?;
        *self.hash.write().unwrap() = Some(hash);
        *self.seen.lock().unwrap() = std::fs::metadata(&self.file).and_then(|m| m.modified()).ok();
        self.end_sessions();
        Ok(())
    }

    pub fn clear_password(&self) -> Result<(), AppError> {
        remote::clear_password(&self.file)?;
        *self.hash.write().unwrap() = None;
        *self.seen.lock().unwrap() = None;
        self.end_sessions();
        Ok(())
    }

    fn hash(&self) -> Option<String> {
        self.hash.read().unwrap().clone()
    }
}

/// Opens or closes the network listener to match the setting (or `--remote`) and the
/// password: it listens only while both say so.
pub fn sync_listener(state: &Arc<AppState>) {
    let cfg = state.engine.config();
    let r = &state.remote;
    let want = (cfg.remote_access || r.forced) && r.password_set();
    let mut cur = r.listener.lock().unwrap();
    if let Some(l) = cur.as_ref()
        && (!want || l.port != cfg.remote_port)
    {
        l.task.abort();
        tracing::info!("access from other devices closed (port {})", l.port);
        crate::say("  Other devices:     closed");
        *cur = None;
        // Browsers signed in over the network sign in again next time.
        r.end_sessions();
    }
    if !want || cur.is_some() {
        if (cfg.remote_access || r.forced) && !r.password_set() {
            *r.error.lock().unwrap() = Some("Set a password first.".into());
        } else if !want {
            *r.error.lock().unwrap() = None;
        }
        return;
    }
    let port = cfg.remote_port;
    let bound = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .and_then(|l| l.set_nonblocking(true).map(|_| l))
        .and_then(tokio::net::TcpListener::from_std);
    match bound {
        Ok(listener) => {
            let app = crate::api::router(state.clone(), true).into_make_service_with_connect_info::<SocketAddr>();
            let task = tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, app).await {
                    tracing::error!("network listener error: {e}");
                }
            });
            tracing::info!("access from other devices open on port {port} (all interfaces)");
            let here = format!("http://localhost:{port}");
            if crate::in_container() {
                crate::say(&format!("  Open in a browser: {here} on the computer running Docker, or http://<its address>:{port} from other devices (password required)"));
            } else {
                match lan_address() {
                Some(ip) => crate::say(&format!("  Other devices:     http://{ip}:{port}  (password required; {here} here)")),
                None => crate::say(&format!("  Other devices:     port {port} of this computer's address  (password required; {here} here)")),
                }
            }
            *r.error.lock().unwrap() = None;
            *cur = Some(Lan { port, task });
        }
        Err(e) => {
            tracing::error!("cannot open port {port} for other devices: {e}");
            *r.error.lock().unwrap() = Some(format!("Port {port} cannot be opened: {e}"));
        }
    }
}

/// This computer's address on the local network, as other devices reach it: the address the
/// system would send from (no packet is sent).
fn lan_address() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    s.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    s.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

pub fn status_json(state: &AppState) -> Value {
    let cfg = state.engine.config();
    let r = &state.remote;
    let listening = r.listener.lock().unwrap().as_ref().map(|l| l.port);
    let url = listening.and_then(|p| lan_address().map(|ip| format!("http://{ip}:{p}")));
    json!({
        "enabled": cfg.remote_access || r.forced, "forced": r.forced, "port": cfg.remote_port,
        "password_set": r.password_set(), "listening": listening.is_some(), "url": url,
        "error": r.error.lock().unwrap().clone(), "min_password_chars": remote::MIN_PASSWORD_CHARS,
    })
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == SESSION_COOKIE).then(|| v.to_string())
    })
}

/// A signed-in browser (valid session cookie).
pub fn browser_session(state: &AppState, headers: &HeaderMap) -> bool {
    cookie_value(headers).is_some_and(|id| state.remote.sessions.valid(&id, SystemTime::now()))
}

fn peer_ip(req: &Request) -> IpAddr {
    let ext = req.extensions();
    ext.get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .or_else(|| ext.get::<axum::extract::connect_info::MockConnectInfo<SocketAddr>>().map(|c| c.0.ip()))
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

pub fn has_csrf_header(headers: &HeaderMap) -> bool {
    headers.get(CSRF_HEADER).is_some_and(|v| v == "1")
}

fn err(code: ErrorCode, msg: &str) -> Response {
    let e = AppError::new(code, msg);
    (StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(json!({ "error": e }))).into_response()
}

/// `GET /api/v1/auth/session`: whether this browser is signed in and a password exists.
pub async fn session(State(s): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    Json(json!({ "signed_in": browser_session(&s, &headers), "password_set": s.remote.password_set() }))
}

#[derive(Deserialize)]
pub struct LoginBody {
    password: String,
}

/// `POST /api/v1/auth/login`: the password for a session cookie. 5 wrong passwords in a row
/// from one address lock it (1 min, doubling up to 15); a locked address gets 429 whatever
/// it sends, so the lock tells nothing about the password.
pub async fn login(State(s): State<Arc<AppState>>, req: Request) -> Response {
    if !has_csrf_header(req.headers()) {
        return err(ErrorCode::Forbidden, "Requests from other sites are not allowed.");
    }
    let ip = peer_ip(&req);
    let bytes = match axum::body::to_bytes(req.into_body(), 64 * 1024).await {
        Ok(b) => b,
        Err(_) => return err(ErrorCode::InvalidInput, "The request was too large."),
    };
    let Ok(body) = serde_json::from_slice::<LoginBody>(&bytes) else {
        return err(ErrorCode::InvalidInput, "Send the password as JSON: {\"password\": \"...\"}.");
    };
    let Some(hash) = s.remote.hash() else {
        return err(ErrorCode::Forbidden, "No password is set. Set one in Kokon Modal on the computer it runs on.");
    };
    if let Err(wait) = s.remote.limiter.check(ip, Instant::now()) {
        return locked(wait);
    }
    let ok = tokio::task::spawn_blocking(move || remote::verify(&hash, &body.password)).await.unwrap_or(false);
    if !ok {
        let wait = s.remote.limiter.fail(ip, Instant::now());
        tracing::warn!("wrong password from {ip}");
        if wait > 0 {
            tracing::warn!("{ip} waits {wait} s after too many wrong passwords");
            return locked(wait);
        }
        return err(ErrorCode::LoginRequired, "Wrong password.");
    }
    s.remote.limiter.succeed(ip);
    let id = s.remote.sessions.create(SystemTime::now());
    tracing::info!("browser signed in from {ip}");
    let cookie = format!("{SESSION_COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}", SESSION_TTL.as_secs());
    let mut r = Json(json!({ "signed_in": true })).into_response();
    r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    r
}

fn locked(wait: u64) -> Response {
    let mins = wait.div_ceil(60);
    let e = AppError::new(ErrorCode::TooManyAttempts, format!("Too many wrong passwords. Try again in {mins} minute{}.", if mins == 1 { "" } else { "s" }));
    let mut r = (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e, "retry_after_s": wait }))).into_response();
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(wait));
    r
}

/// `POST /api/v1/auth/logout`.
pub async fn logout(State(s): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !has_csrf_header(&headers) {
        return err(ErrorCode::Forbidden, "Requests from other sites are not allowed.");
    }
    if let Some(id) = cookie_value(&headers) {
        s.remote.sessions.remove(&id);
    }
    let mut r = Json(json!({ "signed_in": false })).into_response();
    r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")).unwrap());
    r
}

/// The built UI (`dist/`, from `npm run build`), compiled into the binary for release builds.
#[derive(rust_embed::Embed)]
#[folder = "../../dist"]
#[allow_missing = true]
struct Ui;

/// `GET /` and the UI's files. Public: the page itself holds no data; it asks for the
/// password before anything else.
pub async fn ui(method: Method, req: Request<Body>) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(file) = Ui::get(path) else {
        if Ui::get("index.html").is_none() {
            return (StatusCode::NOT_FOUND, "The Kokon Modal UI is not part of this build (run npm run build, then build kokon-service).").into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut r = Response::new(Body::from(file.data.into_owned()));
    let h = r.headers_mut();
    if let Ok(v) = HeaderValue::from_str(file.metadata.mimetype()) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // Hashed asset names never change; the page itself is checked every time.
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}
