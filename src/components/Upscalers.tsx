import { Download, Images, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installProgress } from "../lib/logic";
import { isMac } from "../lib/platform";
import { refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { InstallStatus, UpscalerItem } from "../lib/types";
import { Seg } from "./ui";

const img = import.meta.glob("../assets/upscalers/*.png", { eager: true, import: "default" }) as Record<string, string>;
const crop = (scenario: string, method: string) => img[`../assets/upscalers/${scenario}-${method}.png`];

/** What each upscaler is good and bad at, from an A/B on 8 images at x1.4, x2 and x4, and the
 * time on an M2 Pro (2026-10-12): Macs default to Lanczos, ESRGAN models take minutes there. */
export const UPSCALER_NOTES: Record<string, { key: string; label: string; text: string }> = {
  "4x_NMKD-Superscale-SP_178000_G": {
    key: "superscale",
    label: "Superscale-SP",
    text: isMac
      ? "Sharp and natural, but very slow on a Mac: about 6 minutes to enlarge a 1 MP image to 2K on an M2 Pro. On JPEG photos and dark areas it can draw a faint grid."
      : "The default. Sharp and natural on most photos and renders. On JPEG photos and dark areas it can draw a faint grid: lower the strength if you see one.",
  },
  "4xNomos2_hq_mosr": {
    key: "mosr",
    label: "MoSR (experimental)",
    text: isMac
      ? "Included with Kokon Modal and the fastest AI upscaler on a Mac (about half a minute per megapixel on an M2 Pro), but on clean images enlarged less than about 3× it draws a fine grid pattern."
      : "Included with Kokon Modal and the fastest. Good for big enlargements (4×), but on clean images enlarged less than about 3× it draws a fine grid pattern.",
  },
  "4x-UltraSharp": {
    key: "ultrasharp",
    label: "UltraSharp",
    text: `Very clean, never a grid. But it smooths skin and textures into an artificial look and can invent lines and shapes, especially at night. Non-commercial license.${isMac ? " Very slow on a Mac (minutes per image)." : ""}`,
  },
  lanczos: {
    key: "lanczos",
    label: "Lanczos",
    text: isMac
      ? "The default on a Mac: a plain resize in about a second. It never invents anything, but enlargements look soft."
      : "A plain resize: never invents anything, but enlargements look soft.",
  },
};

const SCENARIOS = [
  { key: "face", label: "Face, 1.4×", hint: "A 1.5K render enlarged to 2K. Look at the wrinkles and skin pores." },
  { key: "jpeg", label: "JPEG photo, 2×", hint: "A JPEG portrait. Look at the forehead: some models turn JPEG blocks into a grid." },
  { key: "night", label: "Night, 2×", hint: "Wet street with neon lights. Look for lines and squares that aren't in the scene." },
  { key: "text", label: "Text, 2×", hint: "Gold letters on a shop sign: edges should stay clean." },
  { key: "landscape", label: "Landscape, 1.4×", hint: "Rocks on a mountain, from a JPEG: fine detail without patterns." },
  { key: "x4", label: "Upscale 4×", hint: "The Upscale button at 4×: every model has to invent detail here." },
];
const METHODS = ["4x_NMKD-Superscale-SP_178000_G", "4xNomos2_hq_mosr", "4x-UltraSharp", "lanczos"];

/** Side-by-side crops of each upscaler in a few typical cases, with what each one is good at. */
export function UpscalerCompare() {
  const [scenario, setScenario] = useState(SCENARIOS[0].key);
  const close = () => setState({ compareUpscalers: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const s = SCENARIOS.find((x) => x.key === scenario)!;
  return (
    <div className="modal-scrim" style={{ zIndex: 60 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="upscaler-compare" role="dialog" aria-label="Compare upscalers">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ flex: 1, margin: 0 }}>Compare upscalers</h3>
          <button className="icon-btn" title="Close" onClick={close}>
            <X size={18} />
          </button>
        </div>
        <span className="muted">
          The upscaler enlarges results to their final size and runs the Upscale button. Same crops, enlarged by each one and shown at 2× zoom.
        </span>
        <Seg<string> value={scenario} options={SCENARIOS.map((x) => ({ value: x.key, label: x.label }))} onChange={setScenario} />
        <span className="muted">{s.hint}</span>
        <div className="upscaler-grid">
          {METHODS.map((m) => (
            <figure key={m}>
              <img src={crop(scenario, UPSCALER_NOTES[m].key)} alt={`${UPSCALER_NOTES[m].label}: ${s.label}`} />
              <figcaption>
                <strong>{UPSCALER_NOTES[m].label}</strong>
                <span>{UPSCALER_NOTES[m].text}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Upscaler model, its download, and the strength slider. Controlled: Settings binds it to its
 * draft, the Advanced menu to the saved settings. */
export function UpscalerControls(props: { model: string; blend: number; onModel: (m: string) => void; onBlend: (b: number) => void; onBlendDone?: () => void }) {
  const [items, setItems] = useState<UpscalerItem[] | null>(null);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const load = () => api.upscalers().then((r) => setItems(r.items), () => {});
  useEffect(() => {
    load();
    api.installStatus().then((i) => i.running && i.preset?.startsWith("upscaler:") && setInst(i), () => {});
  }, []);
  const running = !!inst?.running;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(
      () =>
        api.installStatus().then((i) => {
          setInst(i);
          if (!i.running) {
            load();
            refreshStatus();
            const failed = i.items.find((x) => x.state === "failed");
            if (failed) toastError(new Error(`${failed.label}: ${failed.error ?? "download failed"}`));
          }
        }, () => {}),
      500,
    );
    return () => window.clearInterval(t);
  }, [running]);

  const sel = items?.find((i) => i.name === props.model);
  const downloading = running && inst?.preset === `upscaler:${props.model}`;
  const download = async () => {
    try {
      setInst(await api.downloadUpscaler(props.model));
    } catch (e) {
      toastError(e);
    }
  };
  const note = UPSCALER_NOTES[props.model];
  return (
    <>
      <label className="field-row">
        <span>Upscaler</span>
        <select className="select" value={props.model} onChange={(e) => props.onModel(e.target.value)}>
          {(items ?? []).map((i) => (
            <option key={i.name} value={i.name}>
              {i.label}
              {i.installed ? "" : ` (download ${formatBytes(i.size ?? 0)})`}
            </option>
          ))}
          {items && !items.some((i) => i.name === props.model) && <option value={props.model}>{props.model}</option>}
        </select>
      </label>
      {note && <span className="muted" style={{ marginTop: -8 }}>{note.text}</span>}
      {sel && !sel.installed && (
        <div className="field-row">
          <span className="muted">{downloading ? `Downloading… ${Math.floor(installProgress(inst!.items).frac * 100)}%` : "Not installed yet: until then MoSR is used."}</span>
          <button className="btn" disabled={running} onClick={download}>
            {downloading ? <Loader2 className="spin" size={14} /> : <Download size={14} />} {formatBytes(sel.size ?? 0)}
          </button>
        </div>
      )}
      {props.model !== "lanczos" && (
        <label className="field">
          <span>Upscaler strength {Math.round(props.blend * 100)} %</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.blend}
            onChange={(e) => props.onBlend(Number(e.target.value))}
            onPointerUp={props.onBlendDone}
            onKeyUp={props.onBlendDone}
          />
        </label>
      )}
      {props.model !== "lanczos" && (
        <span className="muted" style={{ marginTop: -8 }}>
          How much of the upscaler's result is kept; the rest is a plain resize. Lower it if it adds texture or patterns that aren't in the image.
        </span>
      )}
      <div className="setting-card">
        <div className="setting-card-text">
          <strong>Not sure which one?</strong>
          <span className="muted">See them side by side on a face, a JPEG photo, text and a night street.</span>
        </div>
        <button className="btn" onClick={() => setState({ compareUpscalers: true })}>
          <Images size={15} /> Compare
        </button>
      </div>
    </>
  );
}

/** [`UpscalerControls`] bound to the saved settings (the Advanced menu: no Save button). */
export function UpscalerSettings() {
  const [model, setModel] = useState<string | null>(null);
  const [blend, setBlend] = useState(1);
  useEffect(() => {
    api.config().then((c) => {
      setModel(c.upscalerModel);
      setBlend(c.upscaleBlend);
    }, toastError);
  }, []);
  const save = async (patch: { upscalerModel?: string; upscaleBlend?: number }) => {
    try {
      const c = await api.config();
      await api.saveConfig({ ...c, ...patch });
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };
  const upscaling = useStore((s) => s.status?.upscaler?.model);
  if (model === null) return null;
  return (
    <div className="field" style={{ gap: 10 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        Enlarging (all images){upscaling && upscaling !== model ? ` · now using ${UPSCALER_NOTES[upscaling]?.label ?? upscaling}` : ""}
      </span>
      <UpscalerControls
        model={model}
        blend={blend}
        onModel={(m) => {
          setModel(m);
          save({ upscalerModel: m });
        }}
        onBlend={setBlend}
        onBlendDone={() => save({ upscaleBlend: blend })}
      />
    </div>
  );
}
