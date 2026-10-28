// Sign-in for Kokon opened in a browser on another device: the password set in the desktop app
// (Settings → Other devices) or with `kokon-service --set-password`. Once per browser; the
// session lasts 90 days or until the password changes.

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { KokonMark } from "./Welcome";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noPassword, setNoPassword] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.session().then((s) => setNoPassword(!s.password_set), () => {});
    input.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : "Kokon Modal is not reachable.");
      setPassword("");
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <KokonMark size={48} />
      <strong>Sign in to Kokon Modal</strong>
      {noPassword ? (
        <span className="muted">No password is set yet. On the computer running Kokon Modal, open Settings → Other devices and set one.</span>
      ) : (
        <>
          <span className="muted">Enter the password set on the computer running Kokon Modal. This browser stays signed in.</span>
          <input
            ref={input}
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <span className="login-error" role="alert">
              {error}
            </span>
          )}
          <button className="btn primary" type="submit" disabled={!password || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </>
      )}
    </form>
  );
}
