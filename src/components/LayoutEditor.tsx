// Fork: Layout editor. Areas on a canvas the shape of the new image (the composer's aspect
// ratio); each says what should appear there. The areas are drawn with `AreaLayer`: Rectangle,
// Outline (point by point) or Freehand.

import { Check, ChevronDown, Lasso, LayoutTemplate, PenTool, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_BOXES, layoutHint, type LayoutBox } from "../lib/layout";
import { aspectLabel, layoutRatio } from "../lib/logic";
import { modelLabel } from "../lib/models";
import { focusPrompt, setState, updateComposer, useStore } from "../lib/store";
import { AreaLayer, type AreaTool } from "./AreaLayer";
import { AspectGrid, pickAspect, RatioIcon } from "./SizeMenus";
import { IconButton, Popover } from "./ui";

const TOOL_KEY = "kokonModal.layoutTool";
const loadTool = (): AreaTool => {
  try {
    const t = localStorage.getItem(TOOL_KEY);
    return t === "lasso" || t === "free" ? t : "rect";
  } catch {
    return "rect";
  }
};
const saveTool = (t: AreaTool) => {
  try {
    localStorage.setItem(TOOL_KEY, t);
  } catch {
    // the tool just isn't remembered
  }
};

export const AREA_TOOLS: { value: AreaTool; label: string; title: string; icon: typeof Square }[] = [
  { value: "rect", label: "Rectangle", title: "Rectangle: drag on the canvas", icon: Square },
  { value: "lasso", label: "Outline", title: "Outline: click point by point, close on the first point", icon: PenTool },
  { value: "free", label: "Freehand", title: "Freehand: drag around the area, it closes when you let go", icon: Lasso },
];

/** What to do with the tool in use, for the editor's header. */
export function toolHint(tool: AreaTool, what: string): string {
  if (tool === "lasso") return `Click point by point; click the first point again (or double-click) to close the area, then write ${what}.`;
  if (tool === "free") return `Hold the mouse and draw around the area; it closes when you let go. Then write ${what}.`;
  return `Drag to draw a box, then write ${what}.`;
}

export function LayoutEditor() {
  const c = useStore((s) => s.composer);
  const style = useStore((s) => s.status?.profile.layout);
  const profile = useStore((s) => s.status?.profile);
  const model = modelLabel({ model: profile?.model ?? "", source: profile?.source ?? "official" }).name;
  const [boxes, setBoxesState] = useState<LayoutBox[]>(() => c.layout ?? []);
  const setBoxes = useCallback((f: (bs: LayoutBox[]) => LayoutBox[]) => setBoxesState(f), []);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const [tool, setToolState] = useState<AreaTool>(loadTool);
  const [drawing, setDrawing] = useState<number | null>(null);
  const setTool = (t: AreaTool) => (setToolState(t), saveTool(t));

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth - 48, h: el.clientHeight - 32 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    // Esc leaves a text field, then closes (an outline being drawn takes it first, in AreaLayer).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement instanceof HTMLTextAreaElement) (document.activeElement as HTMLElement).blur();
      else setState({ overlay: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ratio = layoutRatio(c);
  const scale = Math.max(1, Math.min(stage.w / ratio, stage.h));
  const ch = Math.round(scale);
  const cw = Math.round(scale * ratio);
  const full = boxes.length >= MAX_BOXES;
  const none = style === "none";

  const done = () => {
    updateComposer({ layout: boxes.filter((b) => b.text.trim()) });
    setState({ overlay: null });
    focusPrompt();
  };
  const empty = boxes.filter((b) => !b.text.trim()).length;
  const aspect = c.resolution === "custom" ? aspectLabel(c.customWidth, c.customHeight) : c.aspect === "auto" ? "1:1" : c.aspect;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Layout</h2>
        <span className="muted">{none ? layoutHint(style, model) : `${toolHint(tool, "what goes there")} The prompt describes the whole scene.`}</span>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="editor-stage" ref={stageRef}>
        <div className="layout-area" style={{ width: cw, height: ch }}>
          <AreaLayer
            boxes={boxes}
            setBoxes={setBoxes}
            tool={none ? null : tool}
            full={full}
            placeholder="What goes here…"
            onDrawing={setDrawing}
            empty={
              !none && (
                <div className="layout-empty">
                  {tool === "rect" ? <LayoutTemplate size={28} /> : <Lasso size={28} />}
                  <span>{tool === "lasso" ? "Click to set the first point" : tool === "free" ? "Draw around an area" : "Drag to draw a box"}</span>
                </div>
              )
            }
          />
        </div>
      </div>
      <div className="editor-tools layout-tools">
        <AreaToolPicker tool={tool} setTool={setTool} />
        <div className="group">
          <Popover
            className="wide"
            trigger={(open, toggle) => (
              <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Aspect ratio of the new image">
                <RatioIcon ratio={ratio} size={15} />
                {aspect}
                <ChevronDown size={13} />
              </button>
            )}
          >
            {(close) => <AspectGrid value={aspect} onPick={(r) => (pickAspect(r === "auto" ? "1:1" : r), close())} />}
          </Popover>
          <IconButton title="Delete all areas" onClick={() => setBoxesState([])}>
            <Trash2 size={17} />
          </IconButton>
        </div>
        <span className="muted layout-hint">
          {full ? `At most ${MAX_BOXES} areas. ` : ""}
          {drawing != null ? (drawing < 3 ? "An outline needs at least 3 points. " : "Click the first point to close the area (Backspace: undo a point, Esc: stop). ") : ""}
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

/** Rectangle, Outline, Freehand. */
export function AreaToolPicker({ tool, setTool, compact }: { tool: AreaTool | null; setTool: (t: AreaTool) => void; compact?: boolean }) {
  return (
    <div className="group layout-toolset" role="radiogroup" aria-label="Area tool">
      {AREA_TOOLS.map((t) => (
        <button key={t.value} className={`pill ${tool === t.value ? "on" : ""}`} role="radio" aria-checked={tool === t.value} onClick={() => setTool(t.value)} title={t.title} aria-label={t.label}>
          <t.icon size={14} />
          {!compact && ` ${t.label}`}
        </button>
      ))}
    </div>
  );
}
