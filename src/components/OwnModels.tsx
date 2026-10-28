import { Check, CircleAlert, Download, FileSearch, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/logic";
import { native } from "../lib/native";
import { toastError } from "../lib/store";
import type { GpuBackend, InstallItem, ModelFileInfo, ModelRole, ModelScan, ModelSlot, ModelsStatus } from "../lib/types";

const ROLES: { role: ModelRole; label: string; official: string }[] = [
  { role: "diffusion", label: "Image model", official: "turbo_q4_k" },
  { role: "vae", label: "VAE", official: "vae" },
  { role: "text_encoder", label: "Text encoder", official: "text_encoder" },
  { role: "vision_projector", label: "Vision projector", official: "vision_projector" },
];

/** A file of the user's, the official file downloaded into `downloadDir`, or (vision projector
 * only) nothing because the text encoder has the vision weights. */
type Choice = { kind: "path"; path: string } | { kind: "download" } | { kind: "none" };

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function describe(f: ModelFileInfo): string {
  return [f.weights, formatBytes(f.size), f.official ? "official file" : null].filter(Boolean).join(" · ");
}

/** Setup's "Use models I already have", as a guided flow: choose the folder (e.g. ComfyUI's
 * models folder), check what was found (one row per piece, changed only where needed), use
 * them. Pieces the user lacks are the official files, downloaded into a folder of their choice.
 * Files are used where they are. */
export function OwnModels(props: {
  models: ModelsStatus;
  /** The chosen preset's official model files (sizes of what can be downloaded). */
  officialFiles: InstallItem[];
  vramMib: number | null;
  /** The engine chosen in Setup (FP8 files are slow on Vulkan). */
  backend?: GpuBackend | null;
  /** A scan to start from (Setup's "Search another folder"). */
  initialScan: ModelScan | null;
  /** Resolves once Setup has checked the new files (the button spins until then). */
  onSaved: (s: ModelsStatus) => Promise<void>;
}) {
  const { models } = props;
  const inUse = models.active.source === "user";
  const [scan, setScan] = useState<ModelScan | null>(props.initialScan);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  // Pick each file without a folder scan.
  const [manual, setManual] = useState(false);
  // Changing files that are in use (otherwise their summary is shown).
  const [editing, setEditing] = useState(!inUse || models.missing.length > 0 || !!props.initialScan);
  // The row whose options are open.
  const [open, setOpen] = useState<ModelRole | null>(null);
  // Files chosen with "Choose a file…" (not in the scan), and the current profile's own files.
  const [extra, setExtra] = useState<ModelFileInfo[]>([]);
  const [downloadDir, setDownloadDir] = useState(models.default_download_dir);
  const [choice, setChoice] = useState<Record<ModelRole, Choice>>(() => {
    const c: Record<ModelRole, Choice> = { diffusion: { kind: "download" }, vae: { kind: "download" }, text_encoder: { kind: "download" }, vision_projector: { kind: "download" } };
    if (inUse) {
      for (const s of models.slots) if (s.role) c[s.role] = { kind: "path", path: s.path };
      if (!models.slots.some((s) => s.role === "vision_projector")) c.vision_projector = { kind: "none" };
    }
    return c;
  });

  // The user profile's files, with what they are (missing ones are shown as such).
  useEffect(() => {
    if (inUse) setExtra(models.slots.filter((s) => s.info).map((s) => s.info!));
  }, [models]);

  const known = useMemo(() => {
    const all = [...(scan?.files ?? []), ...extra];
    return all.filter((f, i) => all.findIndex((g) => g.path === f.path) === i);
  }, [scan, extra]);
  const info = (path: string) => known.find((f) => f.path === path) ?? null;

  const applyPicks = (s: ModelScan) => {
    const te = s.picks.text_encoder ? s.files.find((f) => f.path === s.picks.text_encoder) : null;
    setChoice(() => {
      const n = {} as Record<ModelRole, Choice>;
      for (const { role } of ROLES) {
        const p = s.picks[role];
        n[role] = p ? { kind: "path", path: p } : { kind: "download" };
      }
      // A text encoder with the vision weights: no projector needed.
      if (te?.has_vision) n.vision_projector = { kind: "none" };
      return n;
    });
  };

  // A search from the missing-files card that did not find everything: continue from it.
  useEffect(() => {
    if (!props.initialScan) return;
    setScan(props.initialScan);
    applyPicks(props.initialScan);
    setEditing(true);
  }, [props.initialScan]);

  const chooseFolder = async () => {
    const dir = await native.pickFolder(scan?.dir ?? models.scan_dir ?? models.user_scan_dir ?? undefined);
    if (!dir) return;
    setScanning(true);
    try {
      const s = await api.scanModels(dir);
      setScan(s);
      applyPicks(s);
      setEditing(true);
      setOpen(null);
    } catch (e) {
      toastError(e);
    } finally {
      setScanning(false);
    }
  };

  const browse = async (role: ModelRole) => {
    const cur = choice[role];
    const p = await native.pickFile(["gguf", "safetensors"], cur.kind === "path" ? cur.path : scan?.dir);
    if (!p) return;
    try {
      const f = await api.inspectModel(p);
      setExtra((x) => [...x.filter((g) => g.path !== f.path), f]);
      pick(role, { kind: "path", path: p }, f);
    } catch (e) {
      toastError(e);
    }
  };

  const pick = (role: ModelRole, c: Choice, f: ModelFileInfo | null = c.kind === "path" ? info(c.path) : null) => {
    setChoice((x) => ({ ...x, [role]: c, ...(role === "text_encoder" && f?.has_vision ? { vision_projector: { kind: "none" } } : {}) }));
    setOpen(null);
  };

  const teInfo = choice.text_encoder.kind === "path" ? info(choice.text_encoder.path) : null;
  const teHasVision = !!teInfo?.has_vision;
  const officialSize = (role: ModelRole) => {
    const id = ROLES.find((r) => r.role === role)!.official;
    // By family: the text encoder of the preset, the image model the official files use.
    return props.officialFiles.find((f) => f.id === id || f.id.startsWith(`${id}_`))?.size ?? 0;
  };

  // What each row says, and whether the set can be used.
  const rows = ROLES.map(({ role, label }) => {
    const c = role === "vision_projector" && teHasVision ? ({ kind: "none" } as Choice) : choice[role];
    let state: "ok" | "download" | "bad";
    let text: string;
    let detail: string | null = null;
    if (c.kind === "none" && teHasVision) [state, text] = ["ok", "Not needed: included in your text encoder"];
    else if (c.kind === "none") [state, text] = ["bad", "Needed for editing: this text encoder has no vision weights"];
    else if (c.kind === "download") [state, text] = ["download", `${scan ? "Not found in this folder: " : ""}the official file will be downloaded (${formatBytes(officialSize(role))})`];
    else {
      const f = info(c.path);
      const slot = models.slots.find((s) => s.path === c.path);
      detail = c.path;
      if (slot && !slot.exists) [state, text] = ["bad", "Not found"];
      else if (!f) [state, text] = ["ok", fileName(c.path)];
      else if (f.role !== role) [state, text] = ["bad", f.role ? `${fileName(c.path)} is a ${f.role.replace("_", " ")} file` : f.problem ?? "Not a Qwen-Image 2.1 file"];
      else if (!f.compatible) [state, text] = ["bad", f.problem ?? "Not usable with Qwen-Image 2.1"];
      else [state, text] = ["ok", `${fileName(c.path)} · ${describe(f)}`];
    }
    const candidates = known.filter((f) => f.role === role && f.compatible);
    return { role, label, c, state, text, detail, candidates };
  });
  const canSave = rows.every((r) => r.state !== "bad");
  const downloads = rows.filter((r) => r.c.kind === "download");
  const found = rows.filter((r) => r.c.kind === "path").length;
  const dit = choice.diffusion.kind === "path" ? info(choice.diffusion.path) : null;
  const tooLarge = !!dit && props.vramMib != null && dit.size / 2 ** 20 > props.vramMib - 4096;
  // RX 9070 XT (#38): FP8 safetensors 3.07 s/it on Vulkan, the Q4_K GGUF 1.75 s/it.
  const slowFp8 = !!dit && dit.role === "diffusion" && dit.weights === "FP8" && props.backend === "vulkan";
  const skipped = scan ? scan.files.filter((f) => !f.compatible).length : 0;

  const save = async () => {
    const slot = (c: Choice): ModelSlot | null => (c.kind === "path" ? { path: c.path } : c.kind === "download" ? { download: downloadDir } : null);
    setSaving(true);
    try {
      const s = await api.setUserModels({
        diffusion_model: slot(rows[0].c)!,
        vae: slot(rows[1].c)!,
        text_encoder: slot(rows[2].c)!,
        vision_projector: slot(rows[3].c),
        scan_dir: scan?.dir ?? models.scan_dir ?? models.user_scan_dir,
      });
      await props.onSaved(s);
      setEditing(false);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const icon = (state: "ok" | "download" | "bad") => (state === "ok" ? <Check size={16} /> : state === "download" ? <Download size={16} /> : <CircleAlert size={16} />);

  // Step 1: where are the models?
  if (editing && !scan && !manual && !inUse) {
    return (
      <div className="own-start">
        <FolderOpen size={26} strokeWidth={1.6} />
        <strong>Choose the folder with your models</strong>
        <span className="muted">
          For example <code>ComfyUI\models</code>. Kokon Modal finds the Qwen-Image 2.1 files in it and in its sub-folders, as GGUF or safetensors. Nothing is copied or moved.
        </span>
        <button className="btn primary big" onClick={chooseFolder} disabled={scanning}>
          {scanning ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />} {scanning ? "Looking for models…" : "Choose folder…"}
        </button>
        <button className="link-btn" onClick={() => setManual(true)}>
          or pick each file yourself
        </button>
      </div>
    );
  }

  return (
    <div className="own-models">
      <div className="own-head">
        <div>
          <strong>{!editing ? "Using your own files" : scan ? `In ${folderName(scan.dir)}` : "Your files"}</strong>
          <span className="muted">
            {!editing
              ? "Not tested by Kokon Modal. Change them at any time, or switch back to the official files above."
              : scan
                ? `Found ${found} of 4${downloads.length ? `; ${downloads.length === 1 ? "1 piece" : `${downloads.length} pieces`} will be downloaded` : ""}${skipped ? ` · ${skipped} file${skipped === 1 ? "" : "s"} of other models skipped` : ""}`
                : "Choose a file for each piece, or download the official one."}
          </span>
        </div>
        {editing ? (
          <button className="btn" onClick={chooseFolder} disabled={scanning}>
            {scanning ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />} {scan || inUse ? "Another folder…" : "Search a folder…"}
          </button>
        ) : (
          <button className="btn" onClick={() => setEditing(true)}>
            Change files
          </button>
        )}
      </div>

      <div className="own-list">
        {rows.map((r) => (
          <div className={`own-row ${r.state}`} key={r.role}>
            <div className="own-row-main">
              {icon(r.state)}
              <div className="own-row-text">
                <span className="own-row-label">{r.label}</span>
                <span className="own-row-value">{r.text}</span>
                {r.detail && <span className="own-row-path">{r.detail}</span>}
              </div>
              {editing && (
                <button className="btn small" onClick={() => setOpen(open === r.role ? null : r.role)} aria-expanded={open === r.role}>
                  Change
                </button>
              )}
            </div>
            {editing && open === r.role && (
              <div className="own-options">
                {r.candidates.map((f) => (
                  <button key={f.path} className={`own-option ${r.c.kind === "path" && r.c.path === f.path ? "on" : ""}`} onClick={() => pick(r.role, { kind: "path", path: f.path }, f)}>
                    <span>{fileName(f.path)}</span>
                    <span className="muted">{describe(f)}</span>
                  </button>
                ))}
                {r.role === "vision_projector" && teHasVision && (
                  <button className={`own-option ${r.c.kind === "none" ? "on" : ""}`} onClick={() => pick(r.role, { kind: "none" })}>
                    <span>Not needed</span>
                    <span className="muted">your text encoder includes the vision weights</span>
                  </button>
                )}
                <button className={`own-option ${r.c.kind === "download" ? "on" : ""}`} onClick={() => pick(r.role, { kind: "download" })}>
                  <span>
                    <Download size={13} /> Download the official file
                  </span>
                  <span className="muted">{formatBytes(officialSize(r.role))}</span>
                </button>
                <button className="own-option" onClick={() => browse(r.role)}>
                  <span>
                    <FileSearch size={13} /> Choose a file…
                  </span>
                  <span className="muted">.gguf or .safetensors</span>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && downloads.length > 0 && (
        <div className="own-download">
          <span className="muted">
            Downloads go to <strong>{downloadDir}</strong>
          </span>
          <button
            className="link-btn"
            onClick={async () => {
              const d = await native.pickFolder(downloadDir);
              if (d) setDownloadDir(d);
            }}
          >
            Change
          </button>
        </div>
      )}

      {editing && tooLarge && (
        <div className="setup-note">
          This image model is {formatBytes(dit!.size)}, probably too large for {Math.round((props.vramMib ?? 0) / 1024)} GB of VRAM. Kokon Modal makes smaller images to fit, but it may still run out of memory
          or be slow. A 4-bit or 8-bit version (GGUF Q4_K or Q8_0, or INT8) works better on this card.
        </div>
      )}

      {dit?.role === "diffusion" && dit.compatible && dit.warning && <div className="setup-note">{dit.warning}</div>}

      {editing && slowFp8 && (
        <div className="setup-note">FP8 files run much slower on AMD and Intel cards with Vulkan than the GGUF (Q4_K) file Kokon Modal downloads. For speed, download the official file or choose a GGUF.</div>
      )}

      {editing && (
        <div className="own-actions">
          <button className="btn primary" disabled={!canSave || saving} onClick={save}>
            {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />} {saving ? "Checking the files…" : "Use these files"}
          </button>
          {inUse && models.missing.length === 0 && (
            <button className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          {!tooLarge && <span className="muted">Your own files are not tested by Kokon Modal: quality and speed may differ.</span>}
        </div>
      )}
    </div>
  );
}
