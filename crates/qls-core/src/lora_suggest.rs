//! Fork: "Suggest settings" for a LoRA (Settings → LoRA). Reads what the file itself says
//! (training metadata, its name) and, only when the user asks, looks it up online: on Civitai by
//! the file's SHA-256 and on the page the user linked (Hugging Face or Civitai). The values are
//! suggestions with their source; nothing is applied until the user picks one. Only the file's
//! hash and the linked page's address leave the computer, never images or prompts.

use crate::error::{AppError, AppResult};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

/// One suggested value and where it comes from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suggested {
    /// `triggerWords`, `steps`, `cfgScale` or `weight` (the LoRA's own field names).
    pub field: &'static str,
    pub value: Value,
    /// Short name of the source ("This file", "Civitai", "Hugging Face", ...).
    pub source: String,
    /// What it was read from, in a few words ("its model page: \"4 steps, cfg 1\"").
    pub detail: String,
}

/// A place that was looked at, found or not.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Looked {
    pub source: String,
    pub url: Option<String>,
    /// What it is ("Lightning 4-step for Qwen-Image"), or why nothing came from it.
    pub note: String,
    pub found: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Suggestions {
    /// Best first per field (explicit text on a page before example images before the file).
    pub values: Vec<Suggested>,
    pub looked: Vec<Looked>,
}

impl Suggestions {
    fn add(&mut self, field: &'static str, value: Value, source: &str, detail: String) {
        if !self.values.iter().any(|v| v.field == field && v.value == value) {
            self.values.push(Suggested { field, value, source: source.to_string(), detail });
        }
    }
    fn looked(&mut self, source: &str, url: Option<String>, found: bool, note: impl Into<String>) {
        self.looked.push(Looked { source: source.to_string(), url, note: note.into(), found });
    }
    /// Values of each field ordered by how trustworthy their source is.
    fn sort(&mut self) {
        // A step count in the file's own name ("…-4steps") is about this very file; a model
        // page often covers several variants (4 and 8 steps).
        let rank = |s: &Suggested| match (s.source.as_str(), s.detail.starts_with("example images")) {
            ("This file", _) if s.detail.starts_with("its name") => 0,
            ("Hugging Face", _) | ("Linked page", _) => 1,
            ("Civitai", false) => 2,
            ("Civitai", true) => 3,
            _ => 4,
        };
        self.values.sort_by_key(|v| (field_order(v.field), rank(v)));
    }
}

fn field_order(f: &str) -> u8 {
    match f {
        "steps" => 0,
        "cfgScale" => 1,
        "weight" => 2,
        _ => 3,
    }
}

// --- What a text says -------------------------------------------------------------------------

/// Steps, CFG and strength found in a model card or description, with the words they came from.
#[derive(Debug, Default, PartialEq)]
pub struct TextFindings {
    pub steps: Vec<(u32, String)>,
    pub cfg: Vec<(f32, String)>,
    pub weight: Vec<(f32, String)>,
}

static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static STEPS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)num_inference_steps\s*[=:]\s*(\d{1,3})\b",
        r"(?i)\bsteps?\s*[:=]\s*(\d{1,3})\b",
        r"(?i)\b(\d{1,3})\s*[- ]?\s*(?:sampling\s+|inference\s+|denoising\s+)?steps?\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
static CFG: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\b(?:true_cfg_scale|guidance_scale|cfg[_ ]?scale|cfg|guidance)\s*(?:of\s+|[:=]\s*|\s)?(\d{1,2}(?:[.,]\d{1,2})?)\b",
        r"(?i)\b(\d{1,2}(?:[.,]\d{1,2})?)\s*cfg\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
static WEIGHT: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)<lora:[^:>]+:(\d(?:\.\d{1,2})?)>",
        r"(?i)\b(?:lora[_ ]?scale|lora\s+(?:weight|strength)|adapter_weights\s*=\s*\[|strength|weight)\s*(?:of\s+|[:=]\s*|\s)?(\d(?:\.\d{1,2})?)\b",
        r"(?i)\b(\d(?:\.\d{1,2})?)\s*(?:lora\s+)?(?:strength|weight)\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Plain text from HTML or Markdown, entities that matter decoded.
fn plain(text: &str) -> String {
    let t = TAGS.replace_all(text, " ");
    t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

/// The words around a match, for the user to see where a value came from.
fn around(text: &str, start: usize, end: usize) -> String {
    let a = text[..start].char_indices().rev().nth(24).map(|(i, _)| i).unwrap_or(0);
    let b = text[end..].char_indices().nth(24).map(|(i, _)| end + i).unwrap_or(text.len());
    let s: String = text[a..b].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("\"…{s}…\"")
}

/// Steps, CFG and strength a text recommends. Training figures (epochs, "2000 steps of
/// training") and values outside what a sampler takes are skipped.
pub fn read_text(text: &str) -> TextFindings {
    let text = plain(text);
    let mut f = TextFindings::default();
    let training = |start: usize, end: usize| {
        let a = text[..start].char_indices().rev().nth(40).map(|(i, _)| i).unwrap_or(0);
        let b = text[end..].char_indices().nth(20).map(|(i, _)| end + i).unwrap_or(text.len());
        // Only the same sentence or line: "… 10 epochs.\nUse 4 steps" is not about training.
        let before = &text[a..start];
        let before = before.rfind(['\n', ';']).map(|i| &before[i + 1..]).unwrap_or(before);
        let before = before.rfind(". ").map(|i| &before[i + 2..]).unwrap_or(before);
        let after = &text[end..b];
        let after = after.find(['\n', ';']).map(|i| &after[..i]).unwrap_or(after);
        let after = after.find(". ").map(|i| &after[..i]).unwrap_or(after);
        let ctx = format!("{before} {after}").to_lowercase();
        ["train", "epoch", "repeat", "batch", "warmup", "save every", "checkpoint"].iter().any(|w| ctx.contains(w))
    };
    let num = |s: &str| s.replace(',', ".").parse::<f32>().ok();
    for re in STEPS.iter() {
        for c in re.captures_iter(&text) {
            let m = c.get(1).unwrap();
            let whole = c.get(0).unwrap();
            if training(whole.start(), whole.end()) {
                continue;
            }
            if let Ok(n) = m.as_str().parse::<u32>() {
                if (1..=100).contains(&n) && !f.steps.iter().any(|(_, w)| w == &around(&text, whole.start(), whole.end())) {
                    f.steps.push((n, around(&text, whole.start(), whole.end())));
                }
            }
        }
    }
    for re in CFG.iter() {
        for c in re.captures_iter(&text) {
            let whole = c.get(0).unwrap();
            if let Some(v) = num(c.get(1).unwrap().as_str()) {
                if (0.0..=20.0).contains(&v) && !training(whole.start(), whole.end()) {
                    f.cfg.push((v.max(1.0), around(&text, whole.start(), whole.end())));
                }
            }
        }
    }
    for re in WEIGHT.iter() {
        for c in re.captures_iter(&text) {
            let whole = c.get(0).unwrap();
            if let Some(v) = num(c.get(1).unwrap().as_str()) {
                if (0.05..=2.0).contains(&v) && !training(whole.start(), whole.end()) {
                    f.weight.push((v, around(&text, whole.start(), whole.end())));
                }
            }
        }
    }
    f
}

/// The value named most often (the first on a tie), with the words of its first mention.
fn most_common<T: Copy + PartialEq>(found: &[(T, String)]) -> Option<(T, String, usize)> {
    let mut best: Option<(T, String, usize)> = None;
    for (v, w) in found {
        let n = found.iter().filter(|(x, _)| x == v).count();
        if best.as_ref().is_none_or(|b| n > b.2) {
            best = Some((*v, w.clone(), n));
        }
    }
    best
}

fn add_text(out: &mut Suggestions, text: &str, source: &str, what: &str) -> bool {
    let f = read_text(text);
    let mut any = false;
    if let Some((v, w, _)) = most_common(&f.steps) {
        out.add("steps", Value::from(v), source, format!("{what}: {w}"));
        any = true;
    }
    if let Some((v, w, _)) = most_common(&f.cfg) {
        out.add("cfgScale", Value::from(round1(v)), source, format!("{what}: {w}"));
        any = true;
    }
    if let Some((v, w, _)) = most_common(&f.weight) {
        out.add("weight", Value::from(round2(v)), source, format!("{what}: {w}"));
        any = true;
    }
    any
}

fn round1(v: f32) -> f64 {
    ((v as f64) * 10.0).round() / 10.0
}
fn round2(v: f32) -> f64 {
    ((v as f64) * 100.0).round() / 100.0
}

// --- What the file says -----------------------------------------------------------------------

static NAME_STEPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z0-9])(\d{1,2})[-_ ]?(?:steps?|stp)(?:[^a-z]|$)").unwrap());

/// What the file's own training metadata and name say: trigger words (kohya's tag counts,
/// `modelspec.trigger_phrase`), steps in the name ("…-4steps"), and the base model it was
/// trained on (shown, not suggested).
pub fn read_file(meta: &serde_json::Map<String, Value>, file_name: &str) -> Suggestions {
    let mut out = Suggestions::default();
    let s = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    let mut notes = Vec::new();
    if let Some(t) = s("modelspec.trigger_phrase") {
        out.add("triggerWords", Value::from(t), "This file", "its trigger phrase (modelspec)".into());
    }
    if let Some(freq) = s("ss_tag_frequency").and_then(|j| serde_json::from_str::<HashMap<String, HashMap<String, u64>>>(j).ok()) {
        // Tags on (nearly) every training image are the trigger; style words come and go.
        let mut all: HashMap<String, u64> = HashMap::new();
        for tags in freq.values() {
            for (t, n) in tags {
                *all.entry(t.trim().to_string()).or_default() += n;
            }
        }
        let max = all.values().copied().max().unwrap_or(0);
        let mut top: Vec<(&String, &u64)> = all.iter().filter(|(t, n)| !t.is_empty() && max > 0 && **n * 10 >= max * 9).collect();
        top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        if !top.is_empty() && top.len() <= 3 {
            let words = top.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>().join(", ");
            out.add("triggerWords", Value::from(words), "This file", format!("the tag on every training image ({max} images)"));
        }
    }
    if let Some(c) = NAME_STEPS.captures(file_name) {
        if let Ok(n) = c[1].parse::<u32>() {
            if (1..=50).contains(&n) {
                out.add("steps", Value::from(n), "This file", format!("its name: \"{file_name}\""));
            }
        }
    }
    if let Some(b) = s("modelspec.architecture").or(s("ss_base_model_version")).or(s("ss_sd_model_name")) {
        notes.push(format!("trained for {b}"));
    }
    if let Some(r) = s("modelspec.resolution").or(s("ss_resolution")) {
        notes.push(format!("at {r}"));
    }
    let found = !out.values.is_empty();
    let note = match (found, notes.is_empty()) {
        (_, false) => format!("Metadata: {}.", notes.join(" ")),
        (true, true) => "Its metadata.".to_string(),
        (false, true) => "No training metadata with settings in this file.".to_string(),
    };
    out.looked("This file", None, found, note);
    out
}

/// SHA-256 of a file, as Civitai lists it.
pub fn sha256(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| AppError::io("open", path, e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| AppError::io("read", path, e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// --- Online -----------------------------------------------------------------------------------

/// The page a user links: a Hugging Face repo or a Civitai model (optionally a version).
#[derive(Debug, Clone, PartialEq)]
pub enum Link {
    HuggingFace { repo: String },
    Civitai { model: Option<u64>, version: Option<u64> },
}

static HF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://(?:www\.)?(?:huggingface\.co|hf\.co)/([A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+)").unwrap());
static CIVITAI_MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://(?:www\.)?civitai\.(?:com|green)/models/(\d+)").unwrap());
static CIVITAI_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?&]modelVersionId=(\d+)").unwrap());

pub fn parse_link(url: &str) -> Option<Link> {
    let url = url.trim();
    if let Some(c) = HF.captures(url) {
        let repo = c[1].to_string();
        // Not a user's page or a dataset/space listing.
        if ["datasets", "spaces", "models", "docs", "blog"].contains(&repo.split('/').next().unwrap_or("")) {
            return None;
        }
        return Some(Link::HuggingFace { repo });
    }
    if let Some(c) = CIVITAI_MODEL.captures(url) {
        return Some(Link::Civitai { model: c[1].parse().ok(), version: CIVITAI_VERSION.captures(url).and_then(|v| v[1].parse().ok()) });
    }
    None
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("kokon-modal/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(AppError::internal)
}

async fn get_json(c: &reqwest::Client, url: &str) -> Result<Option<Value>, String> {
    let r = c.get(url).send().await.map_err(|e| format!("could not reach it ({})", e.without_url()))?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !r.status().is_success() {
        return Err(format!("it answered {}", r.status()));
    }
    r.json::<Value>().await.map(Some).map_err(|e| format!("unexpected answer ({})", e.without_url()))
}

async fn get_text(c: &reqwest::Client, url: &str) -> Result<Option<String>, String> {
    let r = c.get(url).send().await.map_err(|e| format!("could not reach it ({})", e.without_url()))?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !r.status().is_success() {
        return Err(format!("it answered {}", r.status()));
    }
    r.text().await.map(Some).map_err(|e| e.to_string())
}

const CIVITAI: &str = "https://civitai.com/api/v1";

/// What a Civitai model version says: trigger words, steps/CFG/strength in its and its model's
/// description, and the settings its example images were made with.
pub fn read_civitai(out: &mut Suggestions, version: &Value, model: Option<&Value>) -> String {
    let words: Vec<&str> = version["trainedWords"].as_array().map(|a| a.iter().filter_map(|w| w.as_str()).map(|w| w.trim().trim_matches([',', ' '])).filter(|w| !w.is_empty()).collect()).unwrap_or_default();
    if !words.is_empty() {
        out.add("triggerWords", Value::from(words.join(", ")), "Civitai", "its trained words".into());
    }
    if let Some(d) = version["description"].as_str() {
        add_text(out, d, "Civitai", "the version's description");
    }
    if let Some(d) = model.and_then(|m| m["description"].as_str()) {
        add_text(out, d, "Civitai", "the model page");
    }
    // The example images' generation settings (when the API still lists them).
    let metas: Vec<&Value> = version["images"].as_array().map(|a| a.iter().map(|i| &i["meta"]).filter(|m| m.is_object()).collect()).unwrap_or_default();
    let steps: Vec<(u32, String)> = metas.iter().filter_map(|m| m["steps"].as_u64()).filter(|n| (1..=100).contains(n)).map(|n| (n as u32, String::new())).collect();
    let cfg: Vec<(f32, String)> = metas.iter().filter_map(|m| m["cfgScale"].as_f64()).filter(|v| (0.0..=20.0).contains(v)).map(|v| ((v as f32).max(1.0), String::new())).collect();
    if let Some((v, _, n)) = most_common(&steps) {
        out.add("steps", Value::from(v), "Civitai", format!("example images: {n} of {} made with it", steps.len()));
    }
    if let Some((v, _, n)) = most_common(&cfg) {
        out.add("cfgScale", Value::from(round1(v)), "Civitai", format!("example images: {n} of {} made with it", cfg.len()));
    }
    let name = model.and_then(|m| m["name"].as_str()).or(version["model"]["name"].as_str()).unwrap_or("a LoRA");
    let base = version["baseModel"].as_str().map(|b| format!(" for {b}")).unwrap_or_default();
    format!("{name} ({}){base}", version["name"].as_str().unwrap_or("version"))
}

/// Looks the LoRA up online: Civitai by `hash`, then the `link` the user gave.
pub async fn lookup(out: &mut Suggestions, hash: &str, link: Option<&str>) -> AppResult<()> {
    let c = client()?;
    // Civitai by the file's SHA-256 (its docs spell the path both ways over time).
    let mut found_version: Option<Value> = None;
    let mut civ_err = None;
    for path in ["model-versions", "models-versions"] {
        match get_json(&c, &format!("{CIVITAI}/{path}/by-hash/{hash}")).await {
            Ok(Some(v)) if v.get("id").is_some() => {
                found_version = Some(v);
                break;
            }
            Ok(_) => {}
            Err(e) => {
                civ_err = Some(e);
                break;
            }
        }
    }
    match (found_version, civ_err) {
        (Some(v), _) => {
            let model = match v["modelId"].as_u64() {
                Some(id) => get_json(&c, &format!("{CIVITAI}/models/{id}")).await.ok().flatten(),
                None => None,
            };
            let url = v["modelId"].as_u64().map(|m| format!("https://civitai.com/models/{m}?modelVersionId={}", v["id"]));
            let before = out.values.len();
            let what = read_civitai(out, &v, model.as_ref());
            let found = out.values.len() > before;
            out.looked("Civitai", url, found, if found { what } else { format!("{what}: no settings in its description.") });
        }
        (None, Some(e)) => out.looked("Civitai", None, false, format!("Civitai: {e}.")),
        (None, None) => out.looked("Civitai", None, false, "Not on Civitai (no file with this fingerprint)."),
    }
    let Some(link) = link.map(str::trim).filter(|l| !l.is_empty()) else { return Ok(()) };
    match parse_link(link) {
        Some(Link::HuggingFace { repo }) => {
            let mut card = None;
            let mut err = None;
            for branch in ["main", "master"] {
                match get_text(&c, &format!("https://huggingface.co/{repo}/raw/{branch}/README.md")).await {
                    Ok(Some(t)) => {
                        card = Some(t);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                }
            }
            let url = Some(format!("https://huggingface.co/{repo}"));
            match (card, err) {
                (Some(t), _) => {
                    let before = out.values.len();
                    if let Some(p) = front_matter(&t, "instance_prompt") {
                        out.add("triggerWords", Value::from(p), "Hugging Face", "its model card (instance_prompt)".into());
                    }
                    add_text(out, &t, "Hugging Face", "its model card");
                    let found = out.values.len() > before;
                    out.looked("Hugging Face", url, found, if found { format!("Model card of {repo}.") } else { format!("Model card of {repo}: no settings in it.") });
                }
                (None, Some(e)) => out.looked("Hugging Face", url, false, format!("{repo}: {e}.")),
                (None, None) => out.looked("Hugging Face", url, false, format!("{repo} has no model card (or is private).")),
            }
        }
        Some(Link::Civitai { model, version }) => {
            let v = match version {
                Some(id) => get_json(&c, &format!("{CIVITAI}/model-versions/{id}")).await.ok().flatten(),
                None => None,
            };
            let m = match model {
                Some(id) => get_json(&c, &format!("{CIVITAI}/models/{id}")).await.ok().flatten(),
                None => None,
            };
            // Without a version: the model's newest one.
            let v = v.or_else(|| m.as_ref().and_then(|m| m["modelVersions"].get(0).cloned()));
            match v {
                Some(v) => {
                    let before = out.values.len();
                    let what = read_civitai(out, &v, m.as_ref());
                    let found = out.values.len() > before;
                    out.looked("Linked page", Some(link.to_string()), found, if found { what } else { format!("{what}: no settings in its description.") });
                }
                None => out.looked("Linked page", Some(link.to_string()), false, "Civitai did not return this model."),
            }
        }
        None => out.looked("Linked page", Some(link.to_string()), false, "Not a Hugging Face or Civitai model link."),
    }
    Ok(())
}

/// A value from a model card's YAML front matter (`key: value` or `key: "value"`).
fn front_matter(card: &str, key: &str) -> Option<String> {
    let rest = card.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    rest[..end].lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key).then(|| v.trim().trim_matches(['"', '\'']).trim().to_string()).filter(|v| !v.is_empty() && v != "null")
    })
}

/// Orders the values (best source first per field).
pub fn finish(mut s: Suggestions) -> Suggestions {
    s.sort();
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_steps_cfg_and_strength_from_a_card() {
        let card = r#"---
instance_prompt: "ohwx style"
---
# Lightning LoRA
Use **4 steps** with CFG 1.0 and a LoRA strength of 0.8. Trained for 2000 steps, 10 epochs.
```py
image = pipe(prompt, num_inference_steps=4, true_cfg_scale=1.0).images[0]
```"#;
        let f = read_text(card);
        assert_eq!(f.steps.iter().map(|s| s.0).collect::<Vec<_>>(), [4, 4]);
        assert!(f.cfg.iter().all(|c| c.0 == 1.0) && f.cfg.len() == 2, "{:?}", f.cfg);
        assert_eq!(f.weight.iter().map(|w| w.0).collect::<Vec<_>>(), [0.8]);
        assert_eq!(front_matter(card, "instance_prompt").as_deref(), Some("ohwx style"));
        let mut s = Suggestions::default();
        assert!(add_text(&mut s, card, "Hugging Face", "its model card"));
        assert_eq!(s.values[0].value, Value::from(4));
        assert!(s.values[0].detail.starts_with("its model card: \"…") && s.values[0].detail.contains("steps"), "{}", s.values[0].detail);
    }

    #[test]
    fn html_and_a1111_syntax() {
        let f = read_text("<p>Recommended: <b>8-step</b>, cfg: 3.5, use &lt;lora:inkstyle:0.75&gt;</p>");
        assert_eq!(f.steps[0].0, 8);
        assert_eq!(f.cfg[0].0, 3.5);
        assert_eq!(f.weight[0].0, 0.75);
        // Nothing that looks like a setting: nothing.
        assert_eq!(read_text("A watercolour style trained on 40 images."), TextFindings::default());
    }

    #[test]
    fn reads_the_files_metadata_and_name() {
        let mut meta = serde_json::Map::new();
        meta.insert("ss_tag_frequency".into(), Value::from(r#"{"10_ohwx": {"ohwx": 40, "woman": 12, "smiling": 5}}"#));
        meta.insert("ss_base_model_version".into(), Value::from("qwen_image"));
        let s = read_file(&meta, "qwen-lightning-4steps-v1.safetensors");
        assert_eq!(s.values.iter().map(|v| (v.field, v.value.clone())).collect::<Vec<_>>(), [("triggerWords", Value::from("ohwx")), ("steps", Value::from(4))]);
        assert!(s.looked[0].note.contains("trained for qwen_image"));
        // Its name beats a page that covers several variants.
        let mut both = s.clone();
        both.add("steps", Value::from(8), "Hugging Face", "its model card".into());
        let both = finish(both);
        assert_eq!(both.values.iter().filter(|v| v.field == "steps").map(|v| v.value.clone()).collect::<Vec<_>>(), [Value::from(4), Value::from(8)]);
        let none = read_file(&serde_json::Map::new(), "ink.safetensors");
        assert!(none.values.is_empty() && !none.looked[0].found);
    }

    #[test]
    fn reads_civitai_answers() {
        let version = serde_json::json!({
            "id": 22, "modelId": 11, "name": "v1.0", "baseModel": "Qwen",
            "trainedWords": ["ink style", " "],
            "description": "<p>Best at 0.9 strength.</p>",
            "images": [{"meta": {"steps": 8, "cfgScale": 1}}, {"meta": {"steps": 8, "cfgScale": 1}}, {"meta": {"steps": 20}}, {"meta": null}]
        });
        let model = serde_json::json!({"name": "Ink", "description": "<p>Works with 8 steps.</p>"});
        let mut s = Suggestions::default();
        let what = read_civitai(&mut s, &version, Some(&model));
        assert_eq!(what, "Ink (v1.0) for Qwen");
        let s = finish(s);
        let get = |f: &str| s.values.iter().filter(|v| v.field == f).map(|v| (v.value.clone(), v.detail.clone())).collect::<Vec<_>>();
        assert_eq!(get("triggerWords")[0].0, Value::from("ink style"));
        assert_eq!(get("steps")[0].0, Value::from(8));
        assert!(get("steps")[0].1.starts_with("the model page"));
        assert_eq!(get("cfgScale")[0], (Value::from(1.0), "example images: 2 of 2 made with it".to_string()));
        assert_eq!(get("weight")[0].0, Value::from(0.9));
    }

    #[test]
    fn understands_links() {
        assert_eq!(parse_link("https://huggingface.co/lightx2v/Qwen-Image-Lightning/blob/main/x.safetensors"), Some(Link::HuggingFace { repo: "lightx2v/Qwen-Image-Lightning".into() }));
        assert_eq!(parse_link("https://civitai.com/models/123/ink?modelVersionId=456"), Some(Link::Civitai { model: Some(123), version: Some(456) }));
        assert_eq!(parse_link("https://huggingface.co/datasets/a/b"), None);
        assert_eq!(parse_link("https://example.com/lora"), None);
    }
}

/// Online check against the real sites (`cargo test -p qls-core online_lookup -- --ignored`).
#[cfg(test)]
mod online {
    use super::*;
    #[tokio::test]
    #[ignore]
    async fn online_lookup() {
        let mut s = Suggestions::default();
        let hash = std::env::var("CIVITAI_SHA").unwrap_or_default().to_lowercase();
        lookup(&mut s, &hash, Some("https://huggingface.co/lightx2v/Qwen-Image-Lightning")).await.unwrap();
        let s = finish(s);
        println!("{}", serde_json::to_string_pretty(&s).unwrap());
        assert!(s.looked.iter().any(|l| l.source == "Civitai" && l.found == !hash.is_empty() || l.source == "Civitai" && !l.found), "{:?}", s.looked);
    }
}
