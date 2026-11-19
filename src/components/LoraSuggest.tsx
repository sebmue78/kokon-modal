// Fork: "Suggest settings" for a LoRA (Settings → LoRA). Reads what the file says and, only on
// the button "Look up online", Civitai (by the file's fingerprint) and the LoRA's linked page.
// Every value shows where it comes from; nothing changes until the user picks "Use".
import { ExternalLink, Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { refreshLoras, toastError, toastInfo } from "../lib/store";
import type { LoraItem, LoraSuggestions } from "../lib/types";
import { groupSuggestions, suggestionLabel, suggestionPatch } from "../lib/loraSuggest";

export function LoraSuggest({ l }: { l: LoraItem }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState(l.link ?? "");
  useEffect(() => setLink(l.link ?? ""), [l.link]);
  const [busy, setBusy] = useState<"file" | "online" | null>(null);
  const [res, setRes] = useState<LoraSuggestions | null>(null);

  const saveLink = async () => {
    if (link.trim() === (l.link ?? "")) return true;
    try {
      await api.updateLora(l.id, { link: link.trim() });
      refreshLoras();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  const run = async (online: boolean) => {
    if (online && !(await saveLink())) return;
    setBusy(online ? "online" : "file");
    try {
      setRes(await api.suggestLora(l.id, online));
    } catch (e) {
      toastError(e);
    }
    setBusy(null);
  };
  const use = async (patch: ReturnType<typeof suggestionPatch>, what: string) => {
    try {
      await api.updateLora(l.id, patch);
      toastInfo(`${what} set`);
    } catch (e) {
      toastError(e);
    }
    refreshLoras();
  };

  if (!open) {
    return (
      <button className="btn small lora-suggest-open" onClick={() => setOpen(true)}>
        <Search size={13} /> Suggest settings
      </button>
    );
  }
  const groups = res ? groupSuggestions(res) : [];
  return (
    <div className="lora-suggest">
      <label className="field">
        <span>Its page on Hugging Face or Civitai (optional)</span>
        <input
          className="input"
          type="text"
          spellCheck={false}
          placeholder="https://huggingface.co/… or https://civitai.com/models/…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={saveLink}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <div className="lora-suggest-actions">
        <button className="btn small" disabled={!!busy} onClick={() => run(false)}>
          {busy === "file" && <Loader2 size={13} className="spin" />} Read the file
        </button>
        <button className="btn small primary" disabled={!!busy} onClick={() => run(true)}>
          {busy === "online" && <Loader2 size={13} className="spin" />} Look up online
        </button>
      </div>
      <span className="muted lora-suggest-privacy">
        Online sends only the file's fingerprint (SHA-256) to Civitai and opens the page above. No images or prompts.
      </span>
      {res && (
        <>
          {groups.length === 0 && <span className="muted">No settings found. The values stay as they are.</span>}
          {groups.map((g) => (
            <div className="lora-suggest-field" key={g.field}>
              <span className="lora-suggest-name">{suggestionLabel(g.field)}</span>
              <div className="lora-suggest-values">
                {g.values.map((v, i) => (
                  <div className={`lora-suggest-value${i === 0 ? " best" : ""}`} key={`${v.source}-${String(v.value)}`}>
                    <strong>{String(v.value)}</strong>
                    <span className="muted" title={v.detail}>
                      {v.source}: {v.detail}
                    </span>
                    <button className="btn small" onClick={() => use(suggestionPatch(v), suggestionLabel(v.field))}>
                      Use
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {groups.length > 1 && (
            <button
              className="btn small"
              onClick={() => use(Object.assign({}, ...groups.map((g) => suggestionPatch(g.values[0]))), "Suggested settings")}
            >
              Use the first of each
            </button>
          )}
          <div className="lora-suggest-looked">
            {res.looked.map((x) => (
              <span key={x.source + x.note} className="muted">
                {x.found ? "✓" : "–"} {x.source}: {x.note}{" "}
                {x.url && (
                  <button className="link-btn" onClick={() => native.openLink(x.url!)} title={x.url}>
                    <ExternalLink size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
