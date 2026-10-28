// Fork: Layout. Rectangles the user draws on a canvas the shape of the new image, each with what
// should appear there. Coordinates are fractions of the image (0..1 from the top left). How the
// model gets them is the service's job (crates/qls-core/src/layout.rs); the app draws the sketch
// for the models that read one (Qwen-Image 2.1, Fibo 2.0 Dev).

export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** An outline drawn point by point (polygonal lasso); the box is then its bounding box. */
  points?: [number, number][];
}

export type Point = [number, number];

/** How the model in use is told about a layout (the service's `LayoutStyle`). */
export type LayoutStyle = "sketch" | "native" | "words" | "none";

export const MAX_BOXES = 12;
/** The smallest box, as a fraction of the image side. */
export const MIN_BOX = 0.03;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The area of an outline: its bounding box, with the points kept. */
export function shapeBox(points: Point[], text = ""): LayoutBox {
  const ps = points.map(([x, y]) => [clamp01(x), clamp01(y)] as Point);
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, text, points: ps };
}

/** Whether a point (fractions) is within `px` screen pixels of another, on a canvas `cw`×`ch`. */
export function near(a: Point, b: Point, cw: number, ch: number, px = 10): boolean {
  return Math.hypot((a[0] - b[0]) * cw, (a[1] - b[1]) * ch) <= px;
}

/** The outline with one point moved. */
export function moveVertex(b: LayoutBox, index: number, x: number, y: number): LayoutBox {
  const pts = (b.points ?? []).map((p, i) => (i === index ? ([x, y] as Point) : p));
  return shapeBox(pts, b.text);
}

/** The box kept inside the image and at least `MIN_BOX` in each direction. */
export function clampBox(b: LayoutBox): LayoutBox {
  if (b.points && b.points.length >= 3) return shapeBox(b.points, b.text);
  const w = Math.min(1, Math.max(MIN_BOX, clamp01(b.w)));
  const h = Math.min(1, Math.max(MIN_BOX, clamp01(b.h)));
  return { ...b, x: Math.min(clamp01(b.x), 1 - w), y: Math.min(clamp01(b.y), 1 - h), w, h };
}

/** The rectangle between two points (a drag), clamped. */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number, text = ""): LayoutBox {
  const x0 = clamp01(Math.min(ax, bx));
  const y0 = clamp01(Math.min(ay, by));
  const x1 = clamp01(Math.max(ax, bx));
  const y1 = clamp01(Math.max(ay, by));
  return clampBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, text });
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** The box after dragging one corner by (dx, dy); the opposite corner stays. */
export function resizeBox(b: LayoutBox, corner: Corner, dx: number, dy: number): LayoutBox {
  const left = corner === "nw" || corner === "sw";
  const top = corner === "nw" || corner === "ne";
  const ax = left ? b.x + b.w : b.x;
  const ay = top ? b.y + b.h : b.y;
  const mx = (left ? b.x : b.x + b.w) + dx;
  const my = (top ? b.y : b.y + b.h) + dy;
  // Not past the opposite corner: the box keeps its minimum size instead of flipping.
  const px = left ? Math.min(mx, ax - MIN_BOX) : Math.max(mx, ax + MIN_BOX);
  const py = top ? Math.min(my, ay - MIN_BOX) : Math.max(my, ay + MIN_BOX);
  const next = boxFromPoints(ax, ay, px, py, b.text);
  if (!b.points?.length) return next;
  // An outline is stretched with its box.
  const sx = b.w > 0 ? next.w / b.w : 1;
  const sy = b.h > 0 ? next.h / b.h : 1;
  return { ...next, points: b.points.map(([x, y]) => [next.x + (x - b.x) * sx, next.y + (y - b.y) * sy] as Point) };
}

/** The box moved by (dx, dy), staying inside the image. */
export function moveBox(b: LayoutBox, dx: number, dy: number): LayoutBox {
  const x = Math.min(1 - b.w, Math.max(0, b.x + dx));
  const y = Math.min(1 - b.h, Math.max(0, b.y + dy));
  return { ...b, x, y, ...(b.points?.length ? { points: b.points.map(([px, py]) => [px + x - b.x, py + y - b.y] as Point) } : {}) };
}

/** Boxes worth sending: with text, inside the image, at most `MAX_BOXES`. */
export function usableBoxes(boxes: LayoutBox[] | undefined): LayoutBox[] {
  return (boxes ?? [])
    .filter((b) => b.text.trim())
    .slice(0, MAX_BOXES)
    .map((b) => {
      const c = clampBox(b);
      const r = (v: number) => Math.round(v * 10000) / 10000;
      const out: LayoutBox = { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h), text: c.text.trim() };
      if (c.points && c.points.length >= 3) out.points = c.points.map(([x, y]) => [r(x), r(y)]);
      return out;
    });
}

/** Size of the sketch image: `long` px on the long side, the image's ratio. */
export function sketchSize(ratio: number, long = 1024): { width: number; height: number } {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return r >= 1 ? { width: long, height: Math.max(16, Math.round(long / r)) } : { width: Math.max(16, Math.round(long * r)), height: long };
}

/** Colors of the boxes, one per number (also in the editor). */
export const BOX_COLORS = ["#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6", "#12a594", "#d6409f", "#978365", "#0090ff", "#ab4aba", "#46a758", "#e54666"];

/** Wraps text into lines that fit `maxWidth` (measured by `measure`). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws the sketch: a plain background with each box outlined in its color, its number and
 * its text. The model is told to use it as a plan only. */
export function drawSketch(ctx: CanvasRenderingContext2D, width: number, height: number, boxes: LayoutBox[]) {
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(0, 0, width, height);
  const unit = Math.max(width, height) / 1024;
  boxes.forEach((b, i) => {
    const color = BOX_COLORS[i % BOX_COLORS.length];
    const x = b.x * width;
    const y = b.y * height;
    const w = b.w * width;
    const h = b.h * height;
    ctx.fillStyle = `${color}26`;
    ctx.lineWidth = 4 * unit;
    ctx.strokeStyle = color;
    if (b.points && b.points.length >= 3) {
      ctx.beginPath();
      b.points.forEach(([px, py], k) => (k ? ctx.lineTo(px * width, py * height) : ctx.moveTo(px * width, py * height)));
      ctx.closePath();
      ctx.fill();
      ctx.lineJoin = "round";
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 2 * unit, y + 2 * unit, w - 4 * unit, h - 4 * unit);
    }
    const pad = 10 * unit;
    let size = Math.max(12 * unit, Math.min(30 * unit, h / 5));
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111";
    const label = `${i + 1}. ${b.text}`;
    let lines: string[] = [];
    // Smaller type until the text fits the box (down to a minimum).
    for (; size >= 12 * unit; size -= 2 * unit) {
      ctx.font = `600 ${size}px sans-serif`;
      lines = wrapText(label, w - 2 * pad, (s) => ctx.measureText(s).width);
      if (lines.length * size * 1.2 <= h - 2 * pad) break;
    }
    const max = Math.max(1, Math.floor((h - 2 * pad) / (size * 1.2)));
    const shown = lines.slice(0, max);
    if (b.points && b.points.length >= 3) {
      // An outline: the label in the middle of its area, on a light backing.
      const tw = Math.min(w - 2 * pad, Math.max(...shown.map((l) => ctx.measureText(l).width)));
      const th = shown.length * size * 1.2;
      const tx = x + (w - tw) / 2;
      const ty = y + (h - th) / 2;
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(tx - pad / 2, ty - pad / 2, tw + pad, th + pad / 2);
      ctx.fillStyle = "#111";
      shown.forEach((l, k) => ctx.fillText(l, tx, ty + k * size * 1.2, w - 2 * pad));
    } else shown.forEach((l, k) => ctx.fillText(l, x + pad, y + pad + k * size * 1.2, w - 2 * pad));
  });
}

/** The sketch as a PNG. */
export async function sketchPng(ratio: number, boxes: LayoutBox[]): Promise<Blob> {
  const { width, height } = sketchSize(ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Can't draw the layout sketch.");
  drawSketch(ctx, width, height, boxes);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Can't draw the layout sketch."))), "image/png"));
}

/** What the editor says about the model in use. */
export function layoutHint(style: LayoutStyle | undefined, model: string): string {
  switch (style) {
    case "native":
      return `${model} reads the boxes directly.`;
    case "words":
      return `${model} gets the positions in words: placement is approximate.`;
    case "none":
      return `${model} makes no new images, so it can't follow a layout.`;
    default:
      return `${model} gets the layout as a sketch to follow.`;
  }
}
