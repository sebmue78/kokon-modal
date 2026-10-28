import { describe, expect, it } from "vitest";
import { boxFromPoints, clampBox, layoutHint, MAX_BOXES, MIN_BOX, moveBox, resizeBox, sketchSize, usableBoxes, wrapText } from "./layout";
import { buildRequest, composerFromRecord, emptyComposer, layoutInUse, layoutRatio, needsPrompt, type Ref } from "./logic";
import type { GenerationRecord } from "./types";

const box = (x: number, y: number, w: number, h: number, text = "a cat") => ({ x, y, w, h, text });

describe("layout boxes", () => {
  it("draws, moves and resizes inside the image", () => {
    expect(boxFromPoints(0.8, 0.9, 0.2, 0.1)).toEqual(box(0.2, 0.1, 0.6000000000000001, 0.8, ""));
    expect(boxFromPoints(-1, -1, 2, 2)).toEqual(box(0, 0, 1, 1, ""));
    expect(moveBox(box(0.5, 0.5, 0.4, 0.4), 0.5, -0.9)).toEqual(box(0.6, 0, 0.4, 0.4));
    const r = resizeBox(box(0.2, 0.2, 0.4, 0.4), "se", 0.1, 0.1);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.h).toBeCloseTo(0.5);
    // Dragging a corner past the opposite one keeps the minimum size instead of flipping.
    const f = resizeBox(box(0.2, 0.2, 0.4, 0.4), "nw", 0.9, 0.9);
    expect(f.x).toBeCloseTo(0.6 - MIN_BOX);
    expect(f.w).toBeCloseTo(MIN_BOX);
    expect(clampBox(box(0.9, 0.9, 0.5, 0.5)).x).toBeCloseTo(0.5);
  });

  it("sends only boxes with text, at most the limit", () => {
    expect(usableBoxes([box(0, 0, 0.5, 0.5, "  "), box(0.1, 0.1, 0.2, 0.2, " a dog ")])).toEqual([box(0.1, 0.1, 0.2, 0.2, "a dog")]);
    expect(usableBoxes(Array(20).fill(box(0, 0, 0.5, 0.5)))).toHaveLength(MAX_BOXES);
    expect(usableBoxes(undefined)).toEqual([]);
  });

  it("sizes the sketch and wraps its text", () => {
    expect(sketchSize(16 / 9)).toEqual({ width: 1024, height: 576 });
    expect(sketchSize(0.5)).toEqual({ width: 512, height: 1024 });
    expect(sketchSize(NaN)).toEqual({ width: 1024, height: 1024 });
    expect(wrapText("a red car on the left", 10, (s) => s.length)).toEqual(["a red car", "on the", "left"]);
  });

  it("says what the model does with it", () => {
    expect(layoutHint("native", "FLUX.3")).toContain("directly");
    expect(layoutHint("words", "Krea 2")).toContain("approximate");
    expect(layoutHint(undefined, "Qwen-Image 2.1")).toContain("sketch");
  });
});

describe("composer with a layout", () => {
  const ref: Ref = { key: "k", source: "input:a", width: 100, height: 100, name: "Image 1" };

  it("makes a new image from the prompt and the boxes", () => {
    const c = { ...emptyComposer(), prompt: "a beach", layout: [box(0, 0, 0.3, 0.3, "a seagull"), box(0.5, 0.5, 0.2, 0.2, "")] };
    expect(layoutInUse(c)).toBe(true);
    const r = buildRequest(c);
    expect(r.mode).toBe("generate");
    expect(r.images).toEqual([]);
    expect(r.layout).toEqual([box(0, 0, 0.3, 0.3, "a seagull")]);
    // Auto is drawn square.
    expect(r.aspect_ratio).toBe("1:1");
    expect(buildRequest({ ...c, aspect: "16:9" }).aspect_ratio).toBe("16:9");
    expect(layoutRatio({ ...c, aspect: "16:9" })).toBeCloseTo(16 / 9);
    expect(layoutRatio({ ...c, resolution: "custom", customWidth: 600, customHeight: 300 })).toBe(2);
    // The boxes can be the whole description.
    expect(needsPrompt({ ...c, prompt: "" })).toBe(false);
  });

  it("is not used with input images, nor without boxes", () => {
    const c = { ...emptyComposer(), prompt: "make it night", refs: [ref], layout: [box(0, 0, 0.3, 0.3)] };
    expect(layoutInUse(c)).toBe(false);
    expect(buildRequest(c).layout).toBeUndefined();
    expect(buildRequest(c).images).toEqual(["input:a"]);
    expect(buildRequest({ ...emptyComposer(), prompt: "x" }).layout).toBeUndefined();
    expect(needsPrompt({ ...emptyComposer(), layout: [box(0, 0, 0.3, 0.3, " ")] })).toBe(true);
  });

  it("reopens the layout without the sketch as a reference", () => {
    const g = {
      prompt: "a beach",
      mode: "compose",
      references: [{ input_id: "sketch", index: 0, width: 1024, height: 1024 }],
      request: { prompt: "a beach", mode: "compose", images: ["input:sketch"], layout: [box(0, 0, 0.3, 0.3, "a seagull")] },
    } as unknown as GenerationRecord;
    const c = composerFromRecord(g, emptyComposer());
    expect(c.refs).toEqual([]);
    expect(c.create).toBe(false);
    expect(c.layout).toEqual([box(0, 0, 0.3, 0.3, "a seagull")]);
  });
});
