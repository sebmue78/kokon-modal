import { describe, expect, it } from "vitest";
import { groupSuggestions, suggestionPatch } from "./loraSuggest";

describe("LoRA suggestions", () => {
  const s = {
    values: [
      { field: "steps" as const, value: 4, source: "Hugging Face", detail: "card" },
      { field: "steps" as const, value: 8, source: "Civitai", detail: "example images" },
      { field: "triggerWords" as const, value: "ink style", source: "This file", detail: "tags" },
      { field: "cfgScale" as const, value: 1, source: "Civitai", detail: "x" },
    ],
    looked: [],
  };
  it("groups per field, best first, trigger words on top", () => {
    const g = groupSuggestions(s);
    expect(g.map((x) => x.field)).toEqual(["triggerWords", "steps", "cfgScale"]);
    expect(g[1].values.map((v) => v.value)).toEqual([4, 8]);
  });
  it("turns a value into the LoRA's field", () => {
    expect(suggestionPatch(s.values[0])).toEqual({ steps: 4 });
    expect(suggestionPatch(s.values[2])).toEqual({ triggerWords: "ink style" });
    expect(suggestionPatch({ field: "weight", value: 0.8, source: "", detail: "" })).toEqual({ weight: 0.8 });
  });
});
