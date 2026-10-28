// Fork: Layout editor. Rectangles on a canvas the shape of the new image (the composer's aspect
// ratio); each says what should appear there. Drag on the canvas to draw one, drag its bar to
// move it, its corners to resize it.

import { Check, ChevronDown, LayoutTemplate, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BOX_COLORS, MAX_BOXES, MIN_BOX, boxFromPoints, layoutHint, moveBox, resizeBox, type Corner, type LayoutBox } from "../lib/layout";
import { aspectLabel, layoutRatio } from "../lib/logic";
import { modelLabel } from "../lib/models";
import { focusPrompt, setState, updateComposer, useStore } from "../lib/store";
import { AspectGrid, pickAspect, RatioIcon } from "./SizeMenus";
import { IconButton, Popover } from "./ui";

type Drag =
  | { kind: "draw"; ax: number; ay: number }
  | { kind: "move"; index: number; sx: number; sy: number; start: LayoutBox }
  | { kind: "resize"; index: number; corner: Corner; sx: number; sy: number; start: LayoutBox };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

export function LayoutEditor() {
  const c = useStore((s) => s.composer);
  const style = useStore((s) => s.status?.profile.layout);
  const profile = useStore((s) => s.status?.profile);
  const model = modelLabel({ model: profile?.model ?? "", source: profile?.source ?? "official" }).name;
  const [boxes, setBoxes] = useState<LayoutBox[]>(() => c.layout ?? []);
  const [active, setActive] = useState<number | null>(null);
  const [draft, setDraft] = useState<LayoutBox | null>(null);
  const [focusNew, setFocusNew] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const drag = useRef<Drag | null>(null);
  const textRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth - 48, h: el.clientHeight - 32 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc in a text field leaves the field first.
      if (document.activeElement instanceof HTMLTextAreaElement) (document.activeElement as HTMLElement).blur();
      else setState({ overlay: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (focusNew == null) return;
    textRefs.current[focusNew]?.focus();
    setFocusNew(null);
  }, [focusNew]);

  const ratio = layoutRatio(c);
  const scale = Math.max(1, Math.min(stage.w / ratio, stage.h));
  const ch = Math.round(scale);
  const cw = Math.round(scale * ratio);
  const full = boxes.length >= MAX_BOXES;
  const none = style === "none";

  /** Pointer position as fractions of the canvas. */
  const at = (e: React.PointerEvent) => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== areaRef.current || full || none) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = at(e);
    drag.current = { kind: "draw", ax: p.x, ay: p.y };
    setActive(null);
    setDraft(boxFromPoints(p.x, p.y, p.x, p.y));
  };
  const onBoxDown = (index: number, corner?: Corner) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = at(e);
    setActive(index);
    drag.current = corner ? { kind: "resize", index, corner, sx: p.x, sy: p.y, start: boxes[index] } : { kind: "move", index, sx: p.x, sy: p.y, start: boxes[index] };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    if (d.kind === "draw") setDraft(boxFromPoints(d.ax, d.ay, p.x, p.y));
    else {
      const next = d.kind === "move" ? moveBox(d.start, p.x - d.sx, p.y - d.sy) : resizeBox(d.start, d.corner, p.x - d.sx, p.y - d.sy);
      setBoxes((bs) => bs.map((b, i) => (i === d.index ? next : b)));
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind !== "draw" || !draft) return;
    setDraft(null);
    // A click without a drag draws nothing.
    if (draft.w <= MIN_BOX * 1.5 && draft.h <= MIN_BOX * 1.5) return;
    setBoxes((bs) => [...bs, draft]);
    setActive(boxes.length);
    setFocusNew(boxes.length);
  };

  const setText = (index: number, text: string) => setBoxes((bs) => bs.map((b, i) => (i === index ? { ...b, text } : b)));
  const remove = (index: number) => {
    setBoxes((bs) => bs.filter((_, i) => i !== index));
    setActive(null);
  };
  const done = () => {
    updateComposer({ layout: boxes.filter((b) => b.text.trim()) });
    setState({ overlay: null });
    focusPrompt();
  };
  const empty = boxes.filter((b) => !b.text.trim()).length;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Layout</h2>
        <span className="muted">{none ? layoutHint(style, model) : "Drag on the canvas to draw a box, then write what goes there. The prompt describes the whole scene."}</span>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="editor-stage" ref={stageRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className={`layout-area ${full || none ? "" : "drawable"}`} ref={areaRef} style={{ width: cw, height: ch }} onPointerDown={onCanvasDown}>
          {boxes.map((b, i) => {
            const color = BOX_COLORS[i % BOX_COLORS.length];
            return (
              <div
                key={i}
                className={`layout-box ${active === i ? "active" : ""}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, ["--box" as string]: color }}
                onPointerDown={() => setActive(i)}
              >
                <div className="layout-bar" onPointerDown={onBoxDown(i)} title="Drag to move">
                  <span className="layout-num">{i + 1}</span>
                  <span className="spacer" />
                  <button className="layout-del" title="Delete this box" onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(i)}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <textarea
                  ref={(el) => {
                    textRefs.current[i] = el;
                  }}
                  className="layout-text"
                  value={b.text}
                  placeholder="What goes here…"
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setText(i, e.target.value)}
                  spellCheck
                />
                {CORNERS.map((k) => (
                  <div key={k} className={`layout-corner ${k}`} onPointerDown={onBoxDown(i, k)} title="Drag to resize" />
                ))}
              </div>
            );
          })}
          {draft && <div className="layout-box draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, ["--box" as string]: BOX_COLORS[boxes.length % BOX_COLORS.length] }} />}
          {!boxes.length && !draft && !none && (
            <div className="layout-empty">
              <LayoutTemplate size={28} />
              <span>Drag to draw a box</span>
            </div>
          )}
        </div>
      </div>
      <div className="editor-tools layout-tools">
        <div className="group">
          <Popover
            className="wide"
            trigger={(open, toggle) => (
              <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Aspect ratio of the new image">
                <RatioIcon ratio={ratio} size={15} />
                {c.resolution === "custom" ? aspectLabel(c.customWidth, c.customHeight) : c.aspect === "auto" ? "1:1" : c.aspect}
                <ChevronDown size={13} />
              </button>
            )}
          >
            {(close) => <AspectGrid value={c.resolution === "custom" ? aspectLabel(c.customWidth, c.customHeight) : c.aspect === "auto" ? "1:1" : c.aspect} onPick={(r) => (pickAspect(r === "auto" ? "1:1" : r), close())} />}
          </Popover>
          <IconButton title="Delete all boxes" onClick={() => (setBoxes([]), setActive(null))}>
            <Trash2 size={17} />
          </IconButton>
        </div>
        <span className="muted layout-hint">
          {full ? `At most ${MAX_BOXES} boxes. ` : ""}
          {empty ? `${empty === 1 ? "A box" : `${empty} boxes`} without text will be left out. ` : ""}
          {!none && layoutHint(style, model)}
        </span>
        <button className="btn primary" disabled={none} onClick={done}>
          <Check size={15} /> Done
        </button>
      </div>
    </div>
  );
}
