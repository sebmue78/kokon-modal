import { AppWindow, CircleAlert, Cpu, Hourglass, Layers, LayoutTemplate, MousePointerClick, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installProgress, installStep, installTimeLeft, modelChoiceUi, modelOfferDue, whatsNewDue as due } from "../lib/logic";
import { inBrowser } from "../lib/platform";
import { afterStartScreens, refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { GpuBackend, InstallItem, InstallStatus, ModelsStatus } from "../lib/types";
import { KokonMark } from "./Welcome";

/** The release these notes describe. Shown once to people updating from an earlier version. */
export const WHATS_NEW_VERSION = "0.11.2";

const MAC_NEWS = {
  icon: Cpu,
  title: "A faster Mac engine",
  text: "Kokon's Mac engine 0.1.1: on macOS 26 the CPU's matrix unit and the Neural Engine now work beside the GPU too (about a fifth faster on an M5 Pro), and on M3, M4 and M5 Macs each step is 8–18 % faster. Still experimental, in Settings → Performance.",
};

const NEWS = [
  {
    icon: LayoutTemplate,
    title: "Layout: say where things go",
    text: "For a new image, Layout (next to the aspect ratio) opens a canvas in the image's shape: draw rectangles, outlines point by point or freehand, and write in each what goes there. Paint area has the same tools for a photo you edit. FLUX.3 reads the areas directly, Qwen-Image 2.1 and Fibo 2.0 Dev follow them as a sketch, Krea 2 and MOSS-Image get the positions in words.",
  },
  {
    icon: Layers,
    title: "More models: FLUX.3, Fibo 2.0, Krea 2 and MOSS-Image",
    text: "Kokon Modal adds FLUX.3 Image Klein, Fibo 2.0 (Dev and the fast Edit Turbo), Krea 2 Turbo and MOSS-Image SFT next to Qwen-Image 2.1: pick one in the model menu at the top, which also downloads it the first time. FLUX.3 and Fibo edit and combine photos like Qwen; Krea 2 and MOSS make new images from text and do brushed changes and Expand.",
  },
  {
    icon: AppWindow,
    title: "Its own app, based on Kokon 0.11.2",
    text: "Kokon Modal installs next to Kokon with its own folders, models and settings, so both can run at the same time. It is built on Kokon by Gabriele Lozupone and now includes Kokon 0.11.2.",
  },
  {
    icon: Hourglass,
    title: "The progress card keeps its place",
    text: "Look at another version while an image is being made, then come back: the card goes on from where it is instead of starting over, and the Prompt+ text you already read stays on screen.",
  },
  {
    icon: Save,
    title: "Settings ask before closing",
    text: "Close Settings with changes you haven't saved and Kokon Modal asks whether to save them, instead of dropping them.",
  },
  {
    icon: MousePointerClick,
    title: "Smaller fixes",
    text: "Setup keeps its buttons in view and shows every file name while downloading, selected text is visible on Linux with WebKitGTK, and the page draws properly after leaving full screen on Android phones.",
  },
];

/** Remembers that these notes were read and what was postponed (the engine update for its release, the model step),
 * so neither is offered again at the next start. */
async function markSeen(engineSkipped: string | null, model: Record<string, unknown>) {
  try {
    const cfg = await api.config();
    const ui: Record<string, unknown> = { ...((cfg.ui ?? {}) as Record<string, unknown>), whatsNewSeen: WHATS_NEW_VERSION, ...model };
    if (engineSkipped) ui.engineUpdateSkipped = engineSkipped;
    await api.saveConfig({ ...cfg, ui });
  } catch (e) {
    toastError(e);
  }
}

/** Whether to show the notes at start (see `logic.whatsNewDue`). */
export function whatsNewDue(ui: Record<string, unknown>, engine: { release: string; update_needed: boolean } | undefined): boolean {
  return due(ui, engine, WHATS_NEW_VERSION);
}

type Step = "engine" | "vae" | "model";

/** What's new in this release, plus the downloads it offers, each chosen separately: the engine when the release needs
 * a newer stable-diffusion.cpp (only the files that changed), the new VAE (#21) and the Q4_K_M image model, which
 * replace the old files only if the user accepts. Own model files are never switched: the model step is a suggestion. */
export function WhatsNew() {
  const engine = useStore((s) => s.status?.engine);
  const macEngine = useStore((s) => !!s.status?.mac_engine?.available) && !inBrowser;
  const needsEngine = !!engine?.update_needed;
  const [missing, setMissing] = useState<InstallItem[] | null>(null);
  const [target, setTarget] = useState<{ preset: string; backend: GpuBackend } | null>(null);
  const [ms, setMs] = useState<ModelsStatus | null>(null);
  const [ui, setUi] = useState<Record<string, unknown> | null>(null);
  // With several offered, each can be left out.
  const [wantEngine, setWantEngine] = useState(true);
  const [wantVae, setWantVae] = useState(true);
  const [wantModel, setWantModel] = useState(true);
  const [queue, setQueue] = useState<Step[]>([]);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    api.models().then(setMs, () => {});
    api.config().then((c) => setUi((c.ui ?? {}) as Record<string, unknown>), () => setUi({}));
    api.installStatus().then((i) => i.running && setInst(i), () => {});
    if (!needsEngine) return;
    api.hardware().then((h) => {
      const preset = h.presets.find((p) => p.id === h.current) ?? h.presets.find((p) => p.id === h.recommended);
      setTarget(preset ? { preset: preset.id, backend: h.backend } : null);
      // With the user's own model files, the update downloads the engine, not official models.
      const files = h.active_source === "user" ? h.user_files?.files ?? [] : preset?.files ?? [];
      setMissing(files.filter((f) => f.state !== "present"));
    }, toastError);
  }, [needsEngine]);

  const offerVae = !!ms && !ms.vae.improved;
  const offerModel = !!ui && modelOfferDue(ms?.dit, ui, WHATS_NEW_VERSION);
  const ownModel = ms?.dit.update === "own";
  const engineBytes = (missing ?? []).reduce((a, i) => a + Math.max(0, i.size - i.received), 0);
  const vaeBytes = ms?.vae.download_bytes ?? 0;
  const modelBytes = ms?.dit.download_bytes ?? 0;

  const begin = async (step: Step) => {
    try {
      if (step === "engine") {
        if (!target) return false;
        setInst(await api.install(target.preset, target.backend, false));
      } else if (step === "vae") {
        setInst(await api.improveVae());
      } else {
        setInst(await api.newImageModel());
      }
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  // One download at a time: the next step starts when the previous one completed.
  const running = inst?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(
      () =>
        api.installStatus().then((i) => {
          setInst(i);
          if (i.running || !i.complete) return;
          const [next, ...rest] = queue;
          setQueue(rest);
          if (next) begin(next);
          else {
            setFinished(true);
            api.models().then(setMs, () => {});
          }
        }, () => {}),
      500,
    );
    return () => window.clearInterval(t);
  }, [running, queue]);

  const items = inst?.items ?? [];
  const failed = items.filter((i) => i.state === "failed");
  const prog = installProgress(items);
  // Smallest first; the image model last.
  const steps: Step[] = [
    ...(needsEngine && wantEngine ? ["engine" as const] : []),
    ...(offerVae && wantVae ? ["vae" as const] : []),
    ...(offerModel && wantModel ? ["model" as const] : []),
  ];
  const size = (steps.includes("engine") ? engineBytes : 0) + (steps.includes("vae") ? vaeBytes : 0) + (steps.includes("model") ? modelBytes : 0);
  const offering = (needsEngine || offerVae || offerModel) && !finished;
  // Macs default to Lanczos: their update has no Superscale-SP download.
  const getsSuperscale = (missing ?? []).some((i) => i.id === "upscaler_superscale");
  const several = [needsEngine, offerVae, offerModel].filter(Boolean).length > 1;
  const modelOnly = offerModel && !several;

  const update = async () => {
    const [first, ...rest] = steps;
    if (!first) return;
    setQueue(rest);
    await begin(first);
  };
  /** `keep`: an own-files user chose to keep their image model (never asked again). */
  const close = (postponed: boolean, keep = false) => {
    if (running) api.cancelInstall().catch(() => {});
    setState({ overlay: null });
    // A model step that did not happen (postponed or left out) waits for the next release.
    const modelUi = offerModel && (postponed || !wantModel) ? modelChoiceUi(keep ? "keep" : "later", WHATS_NEW_VERSION) : {};
    markSeen(postponed && engine && needsEngine ? engine.release : null, modelUi);
    refreshStatus();
    afterStartScreens();
  };

  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label={`What's new in Kokon Modal ${WHATS_NEW_VERSION}`}>
        <KokonMark size={44} />
        <h1>What's new in Kokon Modal {WHATS_NEW_VERSION}</h1>
        <div className="welcome-grid">
          {(macEngine ? [MAC_NEWS, ...NEWS] : NEWS).map(({ icon: Icon, title, text }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>

        {offering && !running && (
          <div className="update-offers">
            {offerModel && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantModel} onChange={(e) => setWantModel(e.target.checked)} aria-label="Include the new image model file" />}
                <div>
                  <strong>
                    {ownModel ? "A newer image model file" : "New image model file"}
                    {modelBytes ? ` · ${formatBytes(modelBytes)}` : ""}
                  </strong>
                  <span>
                    {ownModel
                      ? "Your image model is the Q4_K file Kokon Modal used before. Kokon Modal now uses unsloth's Q4_K_M: better supported, slightly better, the same 4-bit size. Kokon Modal can download it into its own folder and use it; your file stays where it is, untouched."
                      : "Kokon Modal now uses unsloth's Q4_K_M of Qwen-Image 2.1 Turbo: better supported, slightly better, the same 4-bit size. The old file is deleted once the new one is downloaded and checked."}{" "}
                    You can also switch later in Settings → Models.
                  </span>
                  <details className="model-files">
                    <summary>Why change it?</summary>
                    <span className="update-detail">
                      Both are 4-bit copies of Qwen's Turbo model and look much the same. The Q4_K_M comes from unsloth, one of the most used sources of
                      GGUF models, and it is the file Kokon Modal's tests and its Mac engine are checked against. Same license as the model.
                    </span>
                  </details>
                </div>
              </div>
            )}
            {offerVae && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantVae} onChange={(e) => setWantVae(e.target.checked)} aria-label="Include the new decoder" />}
                <div>
                  <strong>New image decoder{vaeBytes ? ` · ${formatBytes(vaeBytes)}` : ""}</strong>
                  <span>
                    For the cleaner images above, Kokon Modal needs to replace the decoder it installed. The old file is deleted once the new one is in place.
                    {ms?.active.source === "user" && " Your own VAE file stays where it is: Kokon Modal uses its own copy."} If you keep the current one, you can switch any time in
                    Settings → Models.
                  </span>
                  <details className="model-files">
                    <summary>What is it?</summary>
                    <span className="update-detail">
                      The decoder (VAE, variational autoencoder) turns the model's result into pixels. Qwen's original decoder leaves a faint 2-pixel checkerboard on fine
                      texture. This version, retrained by madebyollin (the author of TAESD), removes it: the image, its colours and the time stay the same. Same license as
                      the model.
                    </span>
                  </details>
                </div>
              </div>
            )}
            {needsEngine && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantEngine} onChange={(e) => setWantEngine(e.target.checked)} aria-label="Include the engine update" />}
                <div>
                  <strong>Engine update{engineBytes ? ` · ${formatBytes(engineBytes)}` : ""}</strong>
                  <span>
                    A newer stable-diffusion.cpp is ready, the engine that runs the models on your graphics chip{getsSuperscale ? ", plus the Superscale-SP model" : ""}.
                    Your images, models and settings stay as they are.
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {(running || (inst && !finished && !failed.length && !inst.complete)) && (
          <div className="setup-card setup-progress" style={{ width: "100%", textAlign: "left" }}>
            <div className="setup-progress-head">
              <span className="pct">{Math.floor(prog.frac * 100)}%</span>
              <span className="muted">
                {formatBytes(prog.received)} of {formatBytes(prog.total)}
                {installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0) ? ` · ${installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0)}` : ""}
              </span>
            </div>
            <div className="progress thick">
              <i style={{ width: `${prog.frac * 100}%` }} />
            </div>
            <span className="muted">{installStep(items) ?? "Starting…"}</span>
          </div>
        )}
        {failed.length > 0 && !running && (
          <div className="setup-note" style={{ width: "100%", textAlign: "left" }}>
            <CircleAlert size={14} /> {failed.map((f) => `${f.label}: ${f.error}`).join(" · ")}
            <div className="muted">Try again, or open Settings → Models to do it later.</div>
          </div>
        )}

        {!offering ? (
          <button className="btn primary big" onClick={() => close(false)}>
            {finished ? "Start creating" : "Got it"}
          </button>
        ) : (
          <div className="welcome-actions">
            <div className="welcome-buttons">
              <button className="btn primary big" disabled={running || !steps.length || (steps.includes("engine") && (!target || missing === null))} onClick={update}>
                {failed.length
                  ? "Try again"
                  : running
                    ? "Updating…"
                    : `${modelOnly ? (ownModel ? "Download Q4_K_M and use it" : "Update now and remove the old file") : "Update now"}${size ? ` · ${formatBytes(size)}` : ""}`}
              </button>
              <button className="btn big" onClick={() => close(true, modelOnly && ownModel)}>
                {modelOnly && ownModel ? "Keep using my file" : offerVae && !needsEngine && !offerModel ? "Keep the current one" : "Later"}
              </button>
            </div>
            <span className="muted welcome-foot">You can update later from Settings → Models.</span>
          </div>
        )}
      </div>
    </div>
  );
}
