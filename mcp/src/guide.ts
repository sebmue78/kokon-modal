// Fork: the server instructions (kept apart from index.ts so they can be tested without
// starting the server). Keep them in line with MODEL_INFO and TASK_PICKS in tools.ts.

// How to choose a model. MCP clients show this to the agent with the tool list.
export const INSTRUCTIONS = `Kokon Modal makes and edits images on this computer with several models; one is "in use" at a time (the same choice as the app's model menu, so switching also changes it for the user, and the next image waits about a minute while the new model loads).

Choosing a model:
- If the user names a model, use it (select_model). Otherwise keep the model in use: do not switch just because another might be a little better.
- Switch only when the model in use cannot do the task (the image tools then say so and name the best downloaded model), or the user asks for "the best model" for something. Call list_models: it shows what each model can do and the best downloaded model per task. Tell the user which model you switched to.
- Never download a model (select_model with download: true, several GB) without asking the user first.

What the models do (best first):
- New image from text: Qwen-Image 2.1 (all-rounder, best for text in images), Krea 2 Turbo (up to 2K), FLUX.3 Klein, Fibo 2.0 Dev, MOSS-Image. Fibo 2.0 Edit Turbo cannot.
- New image with layout areas: FLUX.3 Klein (follows the areas exactly); the others follow them only approximately.
- Edit a whole photo, combine images, new scene from reference images: Qwen-Image 2.1, FLUX.3 Klein, Fibo 2.0 Edit Turbo (fastest), Fibo 2.0 Dev. Krea 2 and MOSS-Image cannot.
- Remove an object or change part of a photo (inpaint_image): Qwen-Image 2.1 first (it sees the marked area in context and does several areas in one pass), then FLUX.3 Klein and Fibo 2.0 (one area per pass). Krea 2 and MOSS-Image only refill the area from a description (plain inpainting): fine for simple backgrounds, weaker for removals in busy scenes.
- Expand beyond the borders (outpaint_image): every model.
- Licenses: Qwen-Image 2.1, FLUX.3 Klein and Fibo 2.0 are for non-commercial use; MOSS-Image is Apache-2.0; Krea 2 has its own community license. If the user says the images are for commercial use, mention this.`;
