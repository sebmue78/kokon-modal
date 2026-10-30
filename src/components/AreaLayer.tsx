// Fork: areas drawn over a canvas or a photo, each with a text (Layout and Paint area). Three ways
// to draw one: Rectangle (drag), Outline (click point by point, closes on the first point or a
// double-click) and Freehand (drag a closed shape, closes on release). An area's bar moves it, its
// corners stretch it, a selected outline's points reshape it. Coordinates are fractions of the
// layer (0..1 from the top left), so the layer can be zoomed (Paint area) or sized freely (Layout).

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { BOX_COLORS, MIN_BOX, boxFromPoints, freehandOutline, moveBox, moveVertex, near, resizeBox, shapeBox, type Corner, type LayoutBox, type Point } from "../lib/layout";

export type AreaTool = "rect" | "lasso" | "free";

type Drag =
  | { kind: "draw"; ax: number; ay: number }
  | { kind: "free"; path: Point[] }
  | { kind: "move"; index: number; sx: number; sy: number; start: LayoutBox }
  | { kind: "resize"; index: number; corner: Corner; sx: number; sy: number; start: LayoutBox }
  | { kind: "vertex"; index: number; vertex: number };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const isShape = (b: LayoutBox) => (b.points?.length ?? 0) >= 3;
/** SVG points on a 0..1000 square viewBox (stretched to the layer). */
const svgPoints = (pts: Point[]) => pts.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ");
const clamp = (p: Point): Point => [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))];

export interface AreaLayerProps {
  boxes: LayoutBox[];
  setBoxes: (f: (bs: LayoutBox[]) => LayoutBox[]) => void;
  /** The drawing tool; null: the areas are shown but take no clicks (e.g. the brush is in use). */
  tool: AreaTool | null;
  /** No more areas can be drawn. */
  full?: boolean;
  /** Placeholder of each area's text field. */
  placeholder: string;
  /** Screen px per layer px (the zoom), so bars and text stay readable at any zoom. */
  zoom?: number;
  /** Shown while there is no area yet. */
  empty?: React.ReactNode;
  /** Whether an outline is being drawn (the editor shows hints). */
  onDrawing?: (points: number | null) => void;
  /** Over a photo: text fields get a light backing to stay readable. */
  onPhoto?: boolean;
}

export function AreaLayer({ boxes, setBoxes, tool, full, placeholder, zoom = 1, empty, onDrawing, onPhoto }: AreaLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const textRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [draft, setDraft] = useState<LayoutBox | null>(null);
  const [freePath, setFreePath] = useState<Point[] | null>(null);
  const [focusNew, setFocusNew] = useState<number | null>(null);
  // The outline being drawn, and where the pointer is (the line to the next point).
  const [lasso, setLasso] = useState<Point[] | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const lassoRef = useRef<Point[] | null>(null);
  lassoRef.current = lasso;

  useEffect(() => onDrawing?.(lasso ? lasso.length : null), [lasso, onDrawing]);
  // Another tool: an outline being drawn is dropped.
  useEffect(() => setLasso(null), [tool]);
  useEffect(() => {
    if (focusNew == null) return;
    textRefs.current[focusNew]?.focus();
    setFocusNew(null);
  }, [focusNew]);
  useEffect(() => {
    // Before the editor's own keys (capture): Backspace and Esc belong to the outline being drawn.
    const onKey = (e: KeyboardEvent) => {
      if (!lassoRef.current) return;
      const typing = document.activeElement instanceof HTMLTextAreaElement;
      if ((e.key === "Backspace" || e.key === "Delete") && !typing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setLasso((l) => (l && l.length > 1 ? l.slice(0, -1) : null));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setLasso(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const rect = () => rootRef.current!.getBoundingClientRect();
  /** Pointer position as fractions of the layer. */
  const at = (e: React.PointerEvent): Point => {
    const r = rect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const nearPx = (a: Point, b: Point, px: number) => {
    const r = rect();
    return near(a, b, r.width, r.height, px);
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

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== rootRef.current || full || !tool) return;
    e.stopPropagation();
    // A text field left open would take the typing (and Backspace) meant for the drawing.
    if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
    const p = clamp(at(e));
    setActive(null);
    if (tool === "lasso") {
      // No focus change on the canvas: the new area's text field keeps the focus it gets.
      e.preventDefault();
      if (!lasso) return setLasso([p]);
      // On the first point: the area is closed.
      if (lasso.length >= 3 && nearPx(p, lasso[0], 12)) return closeLasso(lasso);
      // A second click on the last point (a double-click) adds nothing.
      if (nearPx(p, lasso[lasso.length - 1], 4)) return;
      return setLasso([...lasso, p]);
    }
    rootRef.current!.setPointerCapture(e.pointerId);
    if (tool === "free") {
      drag.current = { kind: "free", path: [p] };
      setFreePath([p]);
      return;
    }
    drag.current = { kind: "draw", ax: p[0], ay: p[1] };
    setDraft(boxFromPoints(p[0], p[1], p[0], p[1]));
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
    const [x, y] = at(e);
    setActive(index);
    drag.current = corner ? { kind: "resize", index, corner, sx: x, sy: y, start: boxes[index] } : { kind: "move", index, sx: x, sy: y, start: boxes[index] };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = at(e);
    if (lasso) setHover(clamp(p));
    if (!d) return;
    e.stopPropagation();
    if (d.kind === "draw") setDraft(boxFromPoints(d.ax, d.ay, p[0], p[1]));
    else if (d.kind === "free") {
      const q = clamp(p);
      // A point every few screen pixels is plenty (the outline is simplified on release).
      if (!nearPx(q, d.path[d.path.length - 1], 3)) {
        d.path.push(q);
        setFreePath([...d.path]);
      }
    } else if (d.kind === "vertex") setBoxes((bs) => bs.map((b, i) => (i === d.index ? moveVertex(b, d.vertex, p[0], p[1]) : b)));
    else {
      const next = d.kind === "move" ? moveBox(d.start, p[0] - d.sx, p[1] - d.sy) : resizeBox(d.start, d.corner, p[0] - d.sx, p[1] - d.sy);
      setBoxes((bs) => bs.map((b, i) => (i === d.index ? next : b)));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    e.stopPropagation();
    if (d.kind === "free") {
      setFreePath(null);
      const r = rect();
      const pts = freehandOutline(d.path, r.width, r.height);
      if (pts.length) {
        const b = shapeBox(pts);
        if (b.w > MIN_BOX && b.h > MIN_BOX) addBox(b);
      }
      return;
    }
    if (d.kind !== "draw" || !draft) return;
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

  // With Outline and Freehand, clicks go through the areas to the canvas (points can be set on top
  // of them); only an area's bar, and the selected area's corners and points, still take them.
  // While an outline is being drawn, nothing does. Without a tool, nothing takes clicks.
  const through = tool === "lasso" || tool === "free";
  const cls = ["area-layer", tool ? `tool-${tool}` : "passive", through ? "through" : "", lasso || freePath ? "drawing" : "", full ? "full" : "", onPhoto ? "on-photo" : ""].filter(Boolean).join(" ");
  const nextColor = BOX_COLORS[boxes.length % BOX_COLORS.length];

  return (
    <div
      ref={rootRef}
      className={cls}
      style={{ ["--u" as string]: String(1 / Math.max(0.01, zoom)) }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => {
        if (!lasso) return;
        e.stopPropagation();
        closeLasso(lasso);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="layout-shapes" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        {boxes.map((b, i) => (isShape(b) ? <polygon key={i} className={active === i ? "active" : ""} points={svgPoints(b.points!)} style={{ ["--box" as string]: BOX_COLORS[i % BOX_COLORS.length] }} /> : null))}
        {lasso && <polyline className="layout-lasso-line" points={svgPoints(hover ? [...lasso, hover] : lasso)} style={{ ["--box" as string]: nextColor }} />}
        {freePath && <polyline className="layout-lasso-line free" points={svgPoints(freePath)} style={{ ["--box" as string]: nextColor }} />}
      </svg>
      {lasso?.map(([x, y], k) => (
        <div
          key={k}
          className={`layout-lasso-point ${k === 0 ? "first" : ""} ${k === 0 && lasso.length >= 3 && hover && nearPx(hover, lasso[0], 12) ? "closing" : ""}`}
          style={{ left: `${x * 100}%`, top: `${y * 100}%`, ["--box" as string]: nextColor }}
        />
      ))}
      {boxes.map((b, i) => (
        <div
          key={i}
          className={`layout-box ${isShape(b) ? "shape" : ""} ${active === i ? "active" : ""}`}
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, ["--box" as string]: BOX_COLORS[i % BOX_COLORS.length] }}
          onPointerDown={(e) => {
            if (!through) e.stopPropagation();
            setActive(i);
          }}
        >
          <div
            className="layout-bar"
            onPointerDown={onBoxDown(i)}
            // With Outline and Freehand the text field lets clicks through: its bar opens it.
            onClick={() => through && textRefs.current[i]?.focus()}
            title={through ? "Drag to move, click to write" : "Drag to move"}
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
            placeholder={placeholder}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setText(i, e.target.value)}
            spellCheck
          />
          {CORNERS.map((k) => (
            <div key={k} className={`layout-corner ${k}`} onPointerDown={onBoxDown(i, k)} title="Drag to resize" />
          ))}
        </div>
      ))}
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
      {draft && <div className="layout-box draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, ["--box" as string]: nextColor }} />}
      {!boxes.length && !draft && !lasso && !freePath && empty}
    </div>
  );
}
