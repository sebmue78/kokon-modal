import { Activity, RotateCcw, Zap } from "lucide-react";
import { useEffect } from "react";
import { api } from "../lib/api";
import { refreshStatus, setState, toastError, toastInfo } from "../lib/store";
import { KokonMark } from "./Welcome";

const POINTS = [
  {
    icon: Zap,
    title: "About 4 times faster",
    text: "The GPU, the CPU's matrix unit and the Neural Engine work together: a new 1024 × 1024 image takes about a minute on an M2 Pro instead of four. Edits, brushed edits, extending and Prompt+ work too.",
  },
  {
    icon: RotateCcw,
    title: "Switch back any time",
    text: "Settings → Performance → Kokon's Mac engine. LoRAs and the upscaler model still need the standard engine.",
  },
  {
    icon: Activity,
    title: "Help us tune it",
    text: "Settings → Performance → Benchmark this Mac measures it in about 10 minutes and gives a report to paste on GitHub. Reports from M1, M3, M4 and M5 Macs help most.",
  },
];

/** Once, at start on a Mac (after Setup or What's new): Kokon's own engine, experimental and off by default. The
 * model loads after the answer, on the engine chosen. */
export function MacEngineOffer() {
  const answer = async (on: boolean) => {
    setState({ overlay: null });
    try {
      const cfg = await api.config();
      const ui = { ...((cfg.ui ?? {}) as Record<string, unknown>), macEngineOffered: true };
      await api.saveConfig({ ...cfg, macEngine: on || !!cfg.macEngine, ui });
      if (on) toastInfo("Kokon's Mac engine is on. Switch back any time in Settings → Performance.");
    } catch (e) {
      toastError(e);
    }
    api.startBackend().then(refreshStatus, () => refreshStatus());
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && answer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label="Try Kokon's Mac engine">
        <KokonMark size={44} />
        <h1>Try Kokon's Mac engine</h1>
        <p className="welcome-lead">Kokon Modal includes Kokon's own engine for Apple Silicon. It's experimental, so it stays off until you turn it on.</p>
        <div className="welcome-grid">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button className="btn primary big" onClick={() => answer(true)}>
            Try it
          </button>
          <button className="btn big" onClick={() => answer(false)}>
            Not now
          </button>
        </div>
        <span className="muted welcome-foot">Your images, models and settings stay as they are.</span>
      </div>
    </div>
  );
}
