// Fork: the model in use, always visible in the top bar, and a menu to switch between
// Qwen-Image 2.1, FLUX.3 Image Klein, Krea 2 Turbo and MOSS-Image (and the user's own files). A model that is not
// downloaded yet starts its download in the Models screen.
import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { openModelSetup, refreshStatus, toastError, toastInfo, useStore } from "../lib/store";

type Entry = { id: string; display_name: string; model: string; source: string; installed: boolean };

/** Short name and what the model does, for the menu and its tooltip. */
export function modelLabel(p: { id: string; model: string; source: string }): { name: string; hint: string } {
  if (p.model === "flux-3-image-klein") return { name: "FLUX.3 Klein", hint: "New images, edits of a whole photo and combining images (non-commercial license)" };
  if (p.model === "krea-2-turbo") return { name: "Krea 2 Turbo", hint: "New images from text, brushed changes and Expand" };
  if (p.model === "moss-image-sft") return { name: "MOSS-Image", hint: "New images from text (with negative prompts), brushed changes and Expand" };
  return { name: p.source === "user" ? "Qwen-Image 2.1 (your files)" : "Qwen-Image 2.1", hint: "Everything: new images, edits of a whole photo and combining images" };
}

/** Install target of a catalog model that is not downloaded yet. */
function installTarget(p: Entry): "official" | "flux3" | "krea2" | "moss" | null {
  if (p.model === "flux-3-image-klein") return "flux3";
  if (p.model === "krea-2-turbo") return "krea2";
  if (p.model === "moss-image-sft") return "moss";
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
