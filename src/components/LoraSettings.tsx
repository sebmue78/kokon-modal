import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, loraModel, MAX_LORAS, QWEN_MODEL } from "../lib/logic";
import { modelLabel } from "./ModelPicker";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { refreshLoras, toastError, toastInfo, useStore } from "../lib/store";
import type { LoraItem } from "../lib/types";
import { Switch } from "./ui";

type Patch = Parameters<typeof api.updateLora>[1];

async function update(id: string, patch: Patch) {
  try {
    await api.updateLora(id, patch);
  } catch (e) {
    toastError(e);
  }
  refreshLoras();
}

/** A text field saved when it loses focus (or on Enter). */
function BlurField(props: { value: string; placeholder?: string; label: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <input
      className="input"
      type="text"
      spellCheck={false}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function LoraRow({ l }: { l: LoraItem }) {
  const [weight, setWeight] = useState(l.weight);
  useEffect(() => setWeight(l.weight), [l.weight]);
  const timer = useRef<number | undefined>(undefined);
  const setStrength = (w: number) => {
    setWeight(w);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => update(l.id, { weight: w }), 400);
  };
  const remove = async () => {
    if (!(await native.confirm(`Remove "${l.name}" from Kokon Modal? Your own file stays where it is.`, "Remove LoRA"))) return;
    try {
      await api.removeLora(l.id);
    } catch (e) {
      toastError(e);
    }
    refreshLoras();
  };
  return (
    <div className="lora-card">
      <div className="lora-head">
        <BlurField label="Name" value={l.name} onSave={(name) => update(l.id, { name })} />
        <button className="icon-btn" onClick={remove} title="Remove" aria-label={`Remove ${l.name}`}>
          <Trash2 size={16} />
        </button>
      </div>
      {!l.available && (
        <span className="lora-warn">
          <CircleAlert size={13} /> Kokon Modal's copy of this LoRA is missing. Remove it and load the file again.
        </span>
      )}
      {l.warning && (
        <span className="lora-warn">
          <CircleAlert size={13} /> {l.warning}
        </span>
      )}
      <label className="field-row">
        <span>Strength</span>
        <span className="lora-strength">
          <input type="range" min={0} max={2} step={0.05} value={weight} onChange={(e) => setStrength(Number(e.target.value))} aria-label="Strength" />
          <span className="muted">{Math.round(weight * 100)} %</span>
        </span>
      </label>
      <label className="field">
        <span>Trigger words (added in front of the prompt when the LoRA is on)</span>
        <BlurField label="Trigger words" placeholder="none" value={l.triggerWords} onSave={(triggerWords) => update(l.id, { triggerWords })} />
      </label>
      <div className="field-row">
        <span>On by default in new projects</span>
        <Switch on={l.onByDefault} label="On by default" onChange={(onByDefault) => update(l.id, { onByDefault })} />
      </div>
      <span className="muted lora-meta">
        {[...l.notes, `${formatBytes(l.size)} · from ${l.source}`].join(" ")}
      </span>
    </div>
  );
}

/** Fork: a model id's short name ("FLUX.3 Klein"). */
const nameOf = (model: string) => modelLabel({ id: "", model, source: "official" }).name;

/** Settings → LoRA: the user's own LoRA files, grouped by the model each is for (the model in use
 * first). A LoRA is loaded for the model in use and only used with it. */
export function LoraSettings() {
  const loras = useStore((s) => s.loras);
  const active = useStore((s) => s.status?.profile.model) || QWEN_MODEL;
  const models = [active, ...new Set(loras.map(loraModel).filter((m) => m !== active))];
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refreshLoras();
  }, []);
  const add = async () => {
    const path = await native.pickFile(["safetensors"], undefined, "LoRA");
    if (!path) return;
    setBusy(true);
    try {
      const l = await api.addLora(path);
      toastInfo(l.warning ? `Loaded "${l.name}", with a warning` : `Loaded "${l.name}"`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      refreshLoras();
    }
  };
  return (
    <>
      <div className="setting-card">
        <div className="setting-card-text">
          <strong>Your LoRA files (beta)</strong>
          <span className="muted">
            Each LoRA belongs to one model. Load a LoRA here for the model in use, <strong>{nameOf(active)}</strong>: to load one for another model, choose
            that model in the model menu at the top first. Kokon Modal checks each file and keeps its own copy (.safetensors); your file is not changed. Next
            to the prompt, the LoRA button shows the LoRAs of the model in use; turn them on or off for each project, up to {MAX_LORAS} at a time.
          </span>
        </div>
        {!inBrowser && (
          <button className="btn primary" disabled={busy} onClick={add}>
            <Plus size={15} /> {busy ? "Checking…" : `Load a LoRA for ${nameOf(active)}…`}
          </button>
        )}
      </div>
      <span className="muted">
        Beta: tested on Windows with an NVIDIA card. It should work the same on Mac and Linux, but it hasn't been tested there yet: please tell us how it goes on GitHub.
      </span>
      <span className="muted">
        Qwen-Image 2.1 and Krea 2: most LoRAs are trained on the full base model (Qwen-Image 2.1, Krea 2 Raw), while Kokon Modal runs the faster Turbo model, so
        compare with the LoRA on and off. FLUX.3 Image Klein uses LoRAs trained on Klein Base. LoRAs for FLUX.3, Krea 2 and MOSS-Image are not tested yet. A LoRA
        makes each image about 20 % slower.
      </span>
      {models.map((m) => {
        const mine = loras.filter((l) => loraModel(l) === m);
        if (mine.length === 0) return null;
        return (
          <div className="lora-group" key={m}>
            <div className="lora-group-title">
              For {nameOf(m)}
              {m === active ? <span className="muted"> · the model in use</span> : <span className="muted"> · used when you switch to it</span>}
            </div>
            {mine.map((l) => (
              <LoraRow key={l.id} l={l} />
            ))}
          </div>
        );
      })}
    </>
  );
}
