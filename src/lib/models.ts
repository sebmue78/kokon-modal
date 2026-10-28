// Fork: the models of Kokon Modal's catalog besides Qwen-Image 2.1, by profile id (which is also
// the model id). One place for their names and what they do: the model menu, Settings → Models,
// Settings → LoRA and Setup read it. qls-core's `EXTRA_CATALOG_PROFILES` lists the same ids.

const TEXT_ONLY =
  "Text to image, plus brushed changes and Expand as plain inpainting. Whole-photo edits and combining images need Qwen-Image 2.1, FLUX.3 or Fibo 2.0.";

export interface CatalogModel {
  /** Short name for menus ("FLUX.3 Klein"). */
  name: string;
  /** Full name ("FLUX.3 Image Klein"). */
  full: string;
  /** One line on what it does (the model menu's tooltip). */
  hint: string;
  /** What it is, for Settings → Models. */
  about: string;
}

export const CATALOG_MODELS: Record<string, CatalogModel> = {
  "flux-3-image-klein": {
    name: "FLUX.3 Klein",
    full: "FLUX.3 Image Klein",
    hint: "New images, edits of a whole photo and combining images (non-commercial license)",
    about:
      "Black Forest Labs' 5.6B model, 16 steps: new images, edits of a whole photo and combining up to 10 images; brushed changes are plain inpainting. Turn on Prompt+ for best results. FLUX Kommunity License: non-commercial use, commercial outputs only for qualifying users.",
  },
  "fibo-2.0-dev": {
    name: "Fibo 2.0 Dev",
    full: "Fibo 2.0 Dev",
    hint: "New images, edits of a whole photo and combining images (non-commercial license)",
    about:
      "Bria's 8B model, 20 steps with CFG: new images, edits of a whole photo and combining up to 10 images (refer to them as <image_1>, <image_2>); brushed changes are plain inpainting. Prompt+ sees your images. CC BY-NC 4.0: non-commercial use only.",
  },
  "fibo-2.0-edit-turbo": {
    name: "Fibo 2.0 Edit Turbo",
    full: "Fibo 2.0 Edit Turbo",
    hint: "Fast edits of a photo and combining images, 4 steps; no new images from text (non-commercial license)",
    about:
      "Bria's 8B model distilled for editing, 4 steps: edits of a whole photo and combining up to 10 images, much faster than Dev. It needs a photo: for new images from text, use Fibo 2.0 Dev or another model. CC BY-NC 4.0: non-commercial use only.",
  },
  "krea-2-turbo": {
    name: "Krea 2 Turbo",
    full: "Krea 2 Turbo",
    hint: "New images from text, brushed changes and Expand",
    about: `Krea's 12.9B model, 8 steps, up to 2K (Krea 2 Community License). ${TEXT_ONLY}`,
  },
  "moss-image-sft": {
    name: "MOSS-Image",
    full: "MOSS-Image SFT",
    hint: "New images from text (with negative prompts), brushed changes and Expand",
    about: `OpenMOSS's 5B model, 20 steps with CFG, negative prompts work (Apache-2.0). ${TEXT_ONLY}`,
  },
};

/** The catalog ids, e.g. for the "<id>:<preset>" label of a running download. */
export const CATALOG_IDS = Object.keys(CATALOG_MODELS);

/** Short name and what a model does. */
export function modelLabel(p: { model: string; source: string }): { name: string; hint: string } {
  const m = CATALOG_MODELS[p.model];
  if (m) return { name: m.name, hint: m.hint };
  return { name: p.source === "user" ? "Qwen-Image 2.1 (your files)" : "Qwen-Image 2.1", hint: "Everything: new images, edits of a whole photo and combining images" };
}
