// Fork: Layout editor. Areas on a canvas the shape of the new image (the composer's aspect
// ratio); each says what should appear there. Rectangle: drag on the canvas. Outline (polygonal
// lasso): click point by point, and the area closes when a click lands on the first point (or on
// a double-click). Drag an area's bar to move it, its corners to resize it, an outline's points
// to reshape it.

import { Check, ChevronDown, Lasso, LayoutTemplate, Square, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BOX_COLORS, MAX_BOXES, MIN_BOX, boxFromPoints, layoutHint, moveBox, moveVertex, near, resizeBox, shapeBox, type Corner, type LayoutBox, type Point } from "../lib/layout";
import { aspectLabel, layoutRatio } from "../lib/logic";
import { modelLabel } from "../lib/models";
import { focusPrompt, setState, updateComposer, useStore } from "../lib/store";
import { AspectGrid, pickAspect, RatioIcon } from "./SizeMenus";
import { IconButton, Popover } from "./ui";

type Drag =
  | { kind: "draw"; ax: number; ay: number }
  | { kind: "move"; index: number; sx: number; sy: number; start: LayoutBox }
  | { kind: "resize"; index: number; corner: Corner; sx: number; sy: number; start: LayoutBox }
  | { kind: "vertex"; index: number; vertex: number };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Tool = "rect" | "lasso";
const TOOL_KEY = "kokonModal.layoutTool";
const loadTool = (): Tool => {
  try {
    return localStorage.getItem(TOOL_KEY) === "lasso" ? "lasso" : "rect";
  } catch {
    return "rect";
  }
};
const isShape = (b: LayoutBox) => (b.points?.length ?? 0) >= 3;
const svgPoints = (pts: Point[], cw: number, ch: number) => pts.map(([x, y]) => `${x * cw},${y * ch}`).join(" ");

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
  const [tool, setToolState] = useState<Tool>(loadTool);
  // The outline being drawn, and where the pointer is (the line to the next point).
  const [lasso, setLasso] = useState<Point[] | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const lassoRef = useRef<Point[] | null>(null);
  lassoRef.current = lasso;
  const setTool = (t: Tool) => {
    setToolState(t);
    setLasso(null);
    try {
      localStorage.setItem(TOOL_KEY, t);
    } catch {
      // the tool just isn't remembered
    }
  };

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth - 48, h: el.clientHeight - 32 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLTextAreaElement;
      // Backspace takes back the last point of an outline being drawn.
      if ((e.key === "Backspace" || e.key === "Delete") && lassoRef.current && !typing) {
        e.preventDefault();
        setLasso((l) => (l && l.length > 1 ? l.slice(0, -1) : null));
        return;
      }
      if (e.key !== "Escape") return;
      // Esc stops an outline being drawn, leaves a text field, then closes.
      if (lassoRef.current) setLasso(null);
      else if (typing) (document.activeElement as HTMLElement).blur();
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

  const addBox = (b: LayoutBox) => {
    setBoxes((bs) => [...bs, b]);
    setActive(boxes.length);
    setFocusNew(boxes.length);
  };
  /** Closes the outline being drawn into an area (three points at least). */
  const closeLasso = (pts: Point[]) => {
    setLasso(null);
    if (pts.length < 3) return;
    const b = shapeBox(pts);
    if (b.w > MIN_BOX && b.h > MIN_BOX) addBox(b);
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== areaRef.current || full || none) return;
    const p = at(e);
    if (tool === "lasso") {
      // No focus change on the canvas: the new area's text field keeps the focus it gets.
      e.preventDefault();
      // A text field left open would take the typing (and Backspace) meant for the outline.
      if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
      const pt: Point = [p.x, p.y];
      setActive(null);
      if (!lasso) return setLasso([pt]);
      // On the first point: the area is closed.
      if (lasso.length >= 3 && near(pt, lasso[0], cw, ch, 12)) return closeLasso(lasso);
      // A second click on the last point (a double-click) adds nothing.
      if (near(pt, lasso[lasso.length - 1], cw, ch, 4)) return;
      return setLasso([...lasso, pt]);
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: "draw", ax: p.x, ay: p.y };
    setActive(null);
    setDraft(boxFromPoints(p.x, p.y, p.x, p.y));
  };
  const onVertexDown = (index: number, vertex: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActive(index);
    drag.current = { kind: "vertex", index, vertex };
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
    const p = at(e);
    if (lasso) setHover([Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]);
    if (!d) return;
    if (d.kind === "draw") setDraft(boxFromPoints(d.ax, d.ay, p.x, p.y));
    else if (d.kind === "vertex") setBoxes((bs) => bs.map((b, i) => (i === d.index ? moveVertex(b, d.vertex, p.x, p.y) : b)));
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
    addBox(draft);
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
        <span className="muted">
          {none
            ? layoutHint(style, model)
            : tool === "lasso"
              ? "Click point by point; click the first point again (or double-click) to close the area, then write what goes there."
              : "Drag on the canvas to draw a box, then write what goes there. The prompt describes the whole scene."}
        </span>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="editor-stage" ref={stageRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div
          // With the outline tool, clicks go through the areas to the canvas (points can be set on
          // top of them); only an area's bar, and the selected area's corners and points, still
          // take them. While an
          // outline is being drawn, nothing does.
          className={`layout-area ${full || none ? "" : "drawable"} ${tool === "lasso" ? "lasso" : ""} ${lasso ? "drawing" : ""}`}
          ref={areaRef}
          style={{ width: cw, height: ch }}
          onPointerDown={onCanvasDown}
          onDoubleClick={() => lasso && closeLasso(lasso)}
          onPointerLeave={() => setHover(null)}
        >
          <svg className="layout-shapes" width={cw} height={ch} viewBox={`0 0 ${cw} ${ch}`}>
            {boxes.map((b, i) =>
              isShape(b) ? <polygon key={i} className={active === i ? "active" : ""} points={svgPoints(b.points!, cw, ch)} style={{ ["--box" as string]: BOX_COLORS[i % BOX_COLORS.length] }} /> : null,
            )}
            {lasso && (
              <g className="layout-lasso" style={{ ["--box" as string]: BOX_COLORS[boxes.length % BOX_COLORS.length] }}>
                <polyline points={svgPoints(hover ? [...lasso, hover] : lasso, cw, ch)} />
                {lasso.map(([x, y], k) => (
                  <circle key={k} cx={x * cw} cy={y * ch} r={k === 0 ? 6 : 3.5} className={k === 0 && lasso.length >= 3 && hover && near(hover, lasso[0], cw, ch, 12) ? "closing" : ""} />
                ))}
              </g>
            )}
          </svg>
          {boxes.map((b, i) => {
            const color = BOX_COLORS[i % BOX_COLORS.length];
            return (
              <div
                key={i}
                className={`layout-box ${isShape(b) ? "shape" : ""} ${active === i ? "active" : ""}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, ["--box" as string]: color }}
                onPointerDown={() => setActive(i)}
              >
                <div
                  className="layout-bar"
                  onPointerDown={onBoxDown(i)}
                  // With the outline tool the text field lets clicks through: its bar opens it.
                  onClick={() => tool === "lasso" && textRefs.current[i]?.focus()}
                  title={tool === "lasso" ? "Drag to move, click to write" : "Drag to move"}
                >
                  <span className="layout-num">{i + 1}</span>
                  <span className="spacer" />
                  <button className="layout-del" title="Delete this area" onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(i)}>
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
          {active != null &&
            boxes[active] &&
            isShape(boxes[active]) &&
            boxes[active].points!.map(([x, y], k) => (
              <div
                key={k}
                className="layout-vertex"
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, ["--box" as string]: BOX_COLORS[active % BOX_COLORS.length] }}
                onPointerDown={onVertexDown(active, k)}
                title="Drag to move this point"
              />
            ))}
          {draft && <div className="layout-box draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, ["--box" as string]: BOX_COLORS[boxes.length % BOX_COLORS.length] }} />}
          {!boxes.length && !draft && !lasso && !none && (
            <div className="layout-empty">
              {tool === "lasso" ? <Lasso size={28} /> : <LayoutTemplate size={28} />}
              <span>{tool === "lasso" ? "Click to set the first point" : "Drag to draw a box"}</span>
            </div>
          )}
        </div>
      </div>
      <div className="editor-tools layout-tools">
        <div className="group layout-toolset" role="radiogroup" aria-label="Drawing tool">
          <button className={`pill ${tool === "rect" ? "on" : ""}`} role="radio" aria-checked={tool === "rect"} onClick={() => setTool("rect")} title="Rectangle: drag on the canvas">
            <Square size={14} /> Rectangle
          </button>
          <button className={`pill ${tool === "lasso" ? "on" : ""}`} role="radio" aria-checked={tool === "lasso"} onClick={() => setTool("lasso")} title="Outline: click point by point, close on the first point">
            <Lasso size={14} /> Outline
          </button>
        </div>
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
          <IconButton title="Delete all areas" onClick={() => (setBoxes([]), setActive(null), setLasso(null))}>
            <Trash2 size={17} />
          </IconButton>
        </div>
        <span className="muted layout-hint">
          {full ? `At most ${MAX_BOXES} areas. ` : ""}
          {lasso ? (lasso.length < 3 ? "An outline needs at least 3 points. " : "Click the first point to close the area (Backspace: undo a point, Esc: stop). ") : ""}
          {empty ? `${empty === 1 ? "An area" : `${empty} areas`} without text will be left out. ` : ""}
          {!none && layoutHint(style, model)}
        </span>
        <button className="btn primary" disabled={none} onClick={done}>
          <Check size={15} /> Done
        </button>
      </div>
    </div>
  );
}
