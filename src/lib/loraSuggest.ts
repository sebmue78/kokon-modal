// Fork: helpers for "Suggest settings" (Settings → LoRA).
import type { LoraItem, LoraSuggestions } from "./types";

type Value = LoraSuggestions["values"][number];
type Field = Value["field"];

const ORDER: Field[] = ["triggerWords", "steps", "cfgScale", "weight"];

export function suggestionLabel(f: Field): string {
  return { triggerWords: "Trigger words", steps: "Steps", cfgScale: "CFG", weight: "Strength" }[f];
}

/** The values per field, in the service's order (best source first), fields in a fixed order. */
export function groupSuggestions(s: LoraSuggestions): { field: Field; values: Value[] }[] {
  return ORDER.map((field) => ({ field, values: s.values.filter((v) => v.field === field) })).filter((g) => g.values.length > 0);
}

/** The LoRA change that applies one suggested value. */
export function suggestionPatch(v: Value): Partial<Pick<LoraItem, "triggerWords" | "steps" | "cfgScale" | "weight">> {
  switch (v.field) {
    case "triggerWords":
      return { triggerWords: String(v.value) };
    case "steps":
      return { steps: Math.round(Number(v.value)) };
    case "cfgScale":
      return { cfgScale: Number(v.value) };
    case "weight":
      return { weight: Number(v.value) };
  }
}
