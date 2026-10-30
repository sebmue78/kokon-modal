import { Brush, Check, Contrast, Eraser, Hand, Redo2, Trash2, Undo2, X } from "lucide-react";
import { MAX_REGIONS_UI, type LayoutBox } from "../lib/layout";
import { AreaLayer, type AreaTool } from "./AreaLayer";
import { AreaToolPicker, toolHint } from "./LayoutEditor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { inBrowser, shortcut } from "../lib/platform";
import { focusPrompt, getState, setState, toastError, updateComposer, useStore } from "../lib/store";
import { IconButton } from "./ui";
import { isTyping } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

type Op =
  | { kind: "stroke"; erase: boolean; size: number; points: [number, number][] }
  | { kind: "invert" }
  | { kind: "clear" };

/** Mask canvas resolution cap (the backend resizes the mask to the source anyway). */
const MAX_MASK_SIDE = 2048;
/** Soft edge of the exported mask, in mask px. Brush strokes are never exactly binary, so the
 * service keeps this softness for the blend instead of adding its own. */
const FEATHER = 8;

export function InpaintEditor() {
  const ref0 = useStore((s) => s.composer.refs[0]);
  const existingMask = useStore((s) => s.composer.mask);
  const [ops, setOps] = useState<Op[]>([]);
  const [redo, setRedo] = useState<Op[]>([]);
  const [tool, setTool] = useState<"brush" | "eraser" | "pan" | AreaTool>("brush");
  // Fork: areas drawn with the Layout tools: part of the mask; with a text, what goes there.
  const [areas, setAreasState] = useState<LayoutBox[]>(() => (existingMask && ref0 && existingMask.refKey === ref0.key ? existingMask.areas ?? [] : []));
  const setAreas = useCallback((f: (bs: LayoutBox[]) => LayoutBox[]) => setAreasState(f), []);
  const areaTool: AreaTool | null = tool === "rect" || tool === "lasso" || tool === "free" ? tool : null;
  const [spacePressed, setSpacePressed] = useState(false);
  // Right button held: the other tool is in use, and the toolbar shows it.
  const [swapped, setSwapped] = useState(false);
  const [brush, setBrush] = useState(48); // in screen px
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const current = useRef<Op | null>(null);

  const srcW = ref0?.width ?? 1;
  const srcH = ref0?.height ?? 1;
  const scale = Math.min(1, MAX_MASK_SIDE / Math.max(srcW, srcH));
  const mw = Math.max(1, Math.round(srcW * scale));
  const mh = Math.max(1, Math.round(srcH * scale));
  const src = ref0 ? urls.source(ref0.source) : "";
  // In a browser the picture is drawn flat (ZoomPan `flat`: no image-sized layer, which cost an
  // iPhone ~300 MB on a 4K image) and is the preview until the zoom needs the full image; the
  // mask keeps its own resolution either way, and strokes map through the canvas's on-screen box.
  const preview = ref0 && inBrowser ? urls.sourcePreview(ref0.source) : undefined;

  const isPanningActive = spacePressed || tool === "pan";
  const erase = tool === "eraser";

  // Load an existing mask for re-editing (as a base raster op).
  const baseMask = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!existingMask || !ref0 || existingMask.refKey !== ref0.key) return;
    // Fork: with areas, only the brushed strokes are a raster (the areas are drawn again as shapes).
    const base = existingMask.areas?.length ? existingMask.brushInputId : existingMask.inputId;
    if (!base) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      baseMask.current = img;
      redraw(ops);
    };
    img.src = urls.input(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Base mask (if re-editing) + every operation after the last "clear". */
  const redraw = useCallback(
    (list: Op[]) => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, mw, mh);
      const lastClear = list.map((o) => o.kind).lastIndexOf("clear");
      if (baseMask.current && lastClear < 0) {
        // Stored masks are grayscale (white = edit): convert luminance to alpha.
        const tmp = document.createElement("canvas");
        tmp.width = mw;
        tmp.height = mh;
        const t = tmp.getContext("2d");
        if (t) {
          t.drawImage(baseMask.current, 0, 0, mw, mh);
          const d = t.getImageData(0, 0, mw, mh);
          for (let i = 0; i < d.data.length; i += 4) {
            const v = d.data[i];
            d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
            d.data[i + 3] = v;
          }
          t.putImageData(d, 0, 0);
          ctx.drawImage(tmp, 0, 0);
        }
      }
      for (const op of list.slice(lastClear + 1)) render2(ctx, op, mw, mh);
    },
    [mw, mh],
  );

  useEffect(() => redraw(ops), [ops, redraw]);

  const toMask = (e: React.PointerEvent): [number, number] => {
    const c = canvasRef.current;
    if (!c) return [0, 0];
    const r = c.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return [0, 0];
    const x = Math.min(mw, Math.max(0, ((e.clientX - r.left) / r.width) * mw));
    const y = Math.min(mh, Math.max(0, ((e.clientY - r.top) / r.height) * mh));
    return [x, y];
  };

  const maskBrush = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return (brush * mw) / Math.max(1, srcW);
    return (brush / r.width) * mw;
  };

  const onDown = (e: React.PointerEvent) => {
    // If middle click or pan mode active, let event bubble to ZoomPan for panning
    if (e.button === 1 || isPanningActive || areaTool) return;
    if (e.button !== 0 && e.button !== 2) return;

    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    // Right button: the other tool (erases with the brush, paints with the eraser), as in mask editors.
    const isErasing = e.button === 2 ? !erase : erase;
    setSwapped(e.button === 2);
    current.current = { kind: "stroke", erase: isErasing, size: maskBrush(), points: [toMask(e)] };
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) render2(ctx, current.current, mw, mh);
  };

  const onMove = (e: React.PointerEvent, transformScale: number) => {
    if (isPanningActive) {
      setCursor(null);
      return;
    }

    const c = canvasRef.current;
    if (c) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCursor({
          x: (e.clientX - r.left) / transformScale,
          y: (e.clientY - r.top) / transformScale,
        });
      }
    }

    const op = current.current;
    if (!op || op.kind !== "stroke") return;
    e.stopPropagation();
    op.points.push(toMask(e));
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) render2(ctx, { ...op, points: op.points.slice(-2) }, mw, mh);
  };

  const onUp = (e: React.PointerEvent) => {
    if (current.current) {
      e.stopPropagation();
      try {
        if ((e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }
      } catch {}
      const op = current.current;
      current.current = null;
      setSwapped(false);
      setOps((o) => [...o, op]);
      setRedo([]);
    }
  };

  const undo = () => {
    setOps((o) => {
      if (!o.length) return o;
      setRedo((r) => [...r, o[o.length - 1]]);
      return o.slice(0, -1);
    });
  };

  const redoOp = () => {
    setRedo((r) => {
      if (!r.length) return r;
      setOps((o) => [...o, r[r.length - 1]]);
      return r.slice(0, -1);
    });
  };

  const push = (op: Op) => {
    setOps((o) => [...o, op]);
    setRedo([]);
  };

  // Keyboard navigation, shortcuts, and spacebar-hold pan detection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redoOp() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoOp();
      } else if (e.key === "Escape") {
        setState({ overlay: null });
      } else if (e.key === "[") {
        setBrush((b) => Math.max(4, b - 8));
      } else if (e.key === "]") {
        setBrush((b) => Math.min(400, b + 8));
      } else if (e.key.toLowerCase() === "b") {
        setTool("brush");
      } else if (e.key.toLowerCase() === "e") {
        setTool((t) => (t === "eraser" ? "brush" : "eraser"));
      } else if (e.key.toLowerCase() === "h") {
        setTool((t) => (t === "pan" ? "brush" : "pan"));
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpacePressed(false);
      }
    };

    const onBlur = () => {
      setSpacePressed(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const done = async () => {
    const c = canvasRef.current;
    if (!c || !ref0) return;

    // Export: white = edit on black, feathered.
    const out = document.createElement("canvas");
    out.width = mw;
    out.height = mh;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, mw, mh);
    ctx.filter = `blur(${FEATHER / 2}px)`;
    ctx.drawImage(c, 0, 0);
    ctx.filter = "none";

    // Detect empty mask.
    const data = c.getContext("2d")!.getImageData(0, 0, mw, mh).data;
    let brushed = false;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 16) {
        brushed = true;
        break;
      }
    }
    // Fork: the strokes alone (to edit the areas again later), then the areas added to the mask.
    const strokes = brushed && areas.length ? await toPng(out) : null;
    ctx.filter = `blur(${FEATHER / 2}px)`;
    ctx.fillStyle = "#fff";
    for (const a of areas) fillArea(ctx, a, mw, mh);
    ctx.filter = "none";
    const any = brushed || areas.length > 0;

    if (!any) {
      updateComposer({ mask: null });
      setState({ overlay: null });
      return;
    }

    setBusy(true);
    try {
      const rec = await api.upload(await toPng(out), "mask.png");
      const brush = strokes ? await api.upload(strokes, "mask-strokes.png") : null;
      const refKey = getState().composer.refs[0]?.key;
      if (refKey) updateComposer({ mask: { inputId: rec.id, refKey, ...(areas.length ? { areas, brushInputId: brush?.id ?? null } : {}) }, outpaint: null, mode: "auto" });
      setState({ overlay: null });
      focusPrompt();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!ref0) setState({ overlay: null });
  }, [ref0]);

  const contentSize = useMemo(() => ({ width: srcW, height: srcH }), [srcW, srcH]);

  if (!ref0) return null;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Paint the area to change</h2>
        <span className="muted">
          {areaTool
            ? toolHint(areaTool, "what goes there (or leave it empty: then your prompt changes it)")
            : "Paint over what should change, or mark areas with the Rectangle, Outline or Freehand tool and say what goes in each."}
        </span>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="editor-stage">
        <ZoomPan
          contentSize={contentSize}
          resetKey={src}
          enableToggleZoom={false}
          enablePan={isPanningActive}
          className="inpaint-zoom-viewport"
          minimapSrc={ref0 && inBrowser ? urls.sourceThumb(ref0.source) : src}
          flat={inBrowser}
        >
          {({ transform, isPanning, flat, wantsFull }) => {
            // Content px per screen px: the box is laid out at its drawn size when flat.
            const k = flat ? 1 : transform.scale;
            return (
            <div
              className="mask-wrap"
              style={{
                width: flat ? "100%" : srcW,
                height: flat ? "100%" : srcH,
                cursor: isPanningActive ? (isPanning ? "grabbing" : "grab") : "none",
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <img
                ref={imgRef}
                src={preview && !wantsFull ? preview : src}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
              <canvas
                ref={canvasRef}
                width={mw}
                height={mh}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  cursor: isPanningActive ? (isPanning ? "grabbing" : "grab") : "none",
                }}
                onPointerDown={onDown}
                onPointerMove={(e) => onMove(e, k)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => setCursor(null)}
              />
              <AreaLayer
                boxes={areas}
                setBoxes={setAreas}
                tool={areaTool && !isPanningActive ? areaTool : null}
                full={areas.length >= MAX_REGIONS_UI}
                zoom={k}
                onPhoto
                placeholder="What goes here (empty: your prompt)"
              />
              {cursor && !isPanningActive && !areaTool && (
                <div
                  className="brush-cursor"
                  style={{
                    left: cursor.x,
                    top: cursor.y,
                    width: brush / k,
                    height: brush / k,
                  }}
                />
              )}
            </div>
            );
          }}
        </ZoomPan>
      </div>

      <div className="editor-tools">
        <div className="group">
          <IconButton
            title="Brush (B) · right-click erases"
            active={(swapped ? tool === "eraser" : tool === "brush") && !spacePressed}
            onClick={() => setTool("brush")}
          >
            <Brush size={17} />
          </IconButton>
          <IconButton
            title="Eraser (E) · right-click paints"
            active={(swapped ? tool === "brush" : tool === "eraser") && !spacePressed}
            onClick={() => setTool("eraser")}
          >
            <Eraser size={17} />
          </IconButton>
          <IconButton
            title="Move (H) · or drag with the middle button, or hold Space"
            active={tool === "pan" || spacePressed}
            onClick={() => setTool((t) => (t === "pan" ? "brush" : "pan"))}
          >
            <Hand size={17} />
          </IconButton>
        </div>

        <AreaToolPicker tool={areaTool} setTool={setTool} />

        <div className="group">
          <label className="slider" title="Brush size ( [ and ] )">
            Size
            <input type="range" min={4} max={400} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          </label>
        </div>

        <div className="group">
          <IconButton title={`Undo (${shortcut("Z")})`} onClick={undo} disabled={!ops.length}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton title={`Redo (${shortcut("Y")})`} onClick={redoOp} disabled={!redo.length}>
            <Redo2 size={17} />
          </IconButton>
          <IconButton title="Invert mask" onClick={() => push({ kind: "invert" })}>
            <Contrast size={17} />
          </IconButton>
          <IconButton title="Clear the mask and the areas" onClick={() => (push({ kind: "clear" }), setAreasState([]))}>
            <Trash2 size={17} />
          </IconButton>
        </div>

        <button className="btn primary" onClick={done} disabled={busy}>
          <Check size={15} /> Done
        </button>
      </div>
    </div>
  );
}

/** The canvas as a PNG. */
function toPng(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));
}

/** Fills an area (fractions of the image) on a `w`×`h` mask canvas. */
function fillArea(ctx: CanvasRenderingContext2D, a: LayoutBox, w: number, h: number) {
  ctx.beginPath();
  if (a.points && a.points.length >= 3) a.points.forEach(([x, y], k) => (k ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
  else ctx.rect(a.x * w, a.y * h, a.w * w, a.h * h);
  ctx.closePath();
  ctx.fill();
}

/** Draws a single operation incrementally (no clearing). */
function render2(ctx: CanvasRenderingContext2D, op: Op, w: number, h: number) {
  if (op.kind === "clear") {
    ctx.clearRect(0, 0, w, h);
    return;
  }
  if (op.kind === "invert") {
    ctx.globalCompositeOperation = "xor";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  ctx.globalCompositeOperation = op.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = op.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const p = op.points;
  ctx.beginPath();
  if (p.length === 1) {
    ctx.arc(p[0][0], p[0][1], op.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}
