// Fork: the model in use, always visible in the top bar, and a menu to switch between
// Qwen-Image 2.1 and the models of `lib/models.ts` (and the user's own files). A model that is not
// downloaded yet starts its download in the Models screen.
import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { CATALOG_MODELS, modelLabel } from "../lib/models";
import { openModelSetup, refreshStatus, toastError, toastInfo, useStore } from "../lib/store";

type Entry = { id: string; display_name: string; model: string; source: string; installed: boolean };

export { modelLabel };

/** Install target of a model that is not downloaded yet: a catalog model by its id. */
function installTarget(p: Entry): string | null {
  if (CATALOG_MODELS[p.model]) return p.id;
  return p.source === "official" ? "official" : null;
}

export function ModelPicker() {
  const profiles = useStore((s) => s.status?.profiles);
  const active = useStore((s) => s.status?.profile.id);
  const serverState = useStore((s) => s.status?.server.state);
  const busy = useStore((s) => Object.values(s.jobs).some((j) => !["done", "failed", "cancelled"].includes(j.status)));
  const [switching, setSwitching] = useState(false);
  if (!profiles || profiles.length < 2 || !active) return null;
  const current = profiles.find((p) => p.id === active);
  const label = current ? modelLabel(current) : null;

  const choose = async (id: string) => {
    const p = profiles.find((q) => q.id === id);
    if (!p || id === active) return;
    const { name } = modelLabel(p);
    try {
      if (!p.installed) {
        const target = installTarget(p);
        if (!target) {
          openModelSetup("own");
          return;
        }
        if (!(await native.confirm(`${name} is not downloaded yet. Download it now? Kokon Modal switches to it when the download is done.`, `Download ${name}`))) return;
        const cfg = await api.config();
        await api.install(cfg.hardwarePreset, cfg.gpuBackend, true, undefined, target);
        openModelSetup(null);
        return;
      }
      setSwitching(true);
      await api.useModels(id);
      toastInfo(`${name} is loading. The first image takes a little longer.`);
      refreshStatus();
      // Load the new model right away (in the background), so the next image does not wait for it.
      api.startBackend().then(refreshStatus, toastError);
    } catch (e) {
      toastError(e);
    } finally {
      setSwitching(false);
    }
  };

  const disabled = busy || switching || serverState === "starting";
  return (
    <label
      className="model-picker"
      title={
        busy
          ? "Wait for the current images to finish before switching models"
          : label
            ? `Model in use: ${current?.display_name}. ${label.hint}.`
            : "Choose the image model"
      }
    >
      <Layers size={14} aria-hidden />
      <span className="model-picker-name">{label?.name ?? "Model"}</span>
      <ChevronDown size={13} aria-hidden />
      <select aria-label="Image model" value={active} disabled={disabled} onChange={(e) => choose(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {modelLabel(p).name}
            {p.installed ? "" : " · not downloaded"}
          </option>
        ))}
      </select>
    </label>
  );
}
