- **New: steps and CFG for each LoRA.** Settings → LoRA has two new fields for each LoRA:
  **Steps** and **CFG**, used while that LoRA is on.
  - They are meant for speed LoRAs. A 4-step LoRA for MOSS-Image, for example, gets "4 steps, CFG 1"
    and the image is made in 4 steps instead of 20.
  - Empty ("auto") keeps the model's own settings, so nothing changes for LoRAs without them.
  - The sampler always stays the one set for the model.
  - The job notes say when a LoRA changed the steps or CFG.
  - For Qwen-Image 2.1, a step count other than 8 uses the engine's standard schedule instead of
    the 8-step Turbo schedule.
- **New: "Suggest settings" for each LoRA.** It finds trigger words, steps, CFG and strength, and
  shows each value with where it comes from. Nothing changes until you click **Use** (or **Use the
  first of each**).
  - **Read the file** (offline): the trigger word from the file's training metadata (the tag on
    every training image, or its trigger phrase), the base model it was trained for, and a step
    count in its name ("…-4steps").
  - **Look up online**:
    - **Civitai**, found by the file's fingerprint (SHA-256): its trained words, settings named in
      its description, and the steps and CFG of its example images.
    - The page you paste in the new link field: a **Hugging Face** model card (its instance prompt,
      `num_inference_steps`, `guidance_scale`/`true_cfg_scale`, "4 steps, CFG 1" and the like) or
      a **Civitai** page.
  - Only the fingerprint and the page address go out, never images or prompts. It goes online only
    when you click.
  - Training figures ("2000 steps", epochs) are skipped.
  - Civitai shows which base model a LoRA is for, so you can spot one made for another model.
  - Links to civitai.com now open from the app.
- MCP: `list_loras` now shows a LoRA's steps and CFG. It also shows trigger words again: they were
  missing because the service sends them as `triggerWords`.
