- **New: steps and CFG for each LoRA.** Settings → LoRA has two new fields for each LoRA:
  **Steps** and **CFG**, used while that LoRA is on.
  - They are meant for speed LoRAs. A 4-step LoRA for MOSS-Image, for example, gets "4 steps, CFG 1"
    and the image is made in 4 steps instead of 20.
  - Empty ("auto") keeps the model's own settings, so nothing changes for LoRAs without them.
  - The sampler always stays the one set for the model.
  - The job notes say when a LoRA changed the steps or CFG.
  - For Qwen-Image 2.1, a step count other than 8 uses the engine's standard schedule instead of
    the 8-step Turbo schedule.
- MCP: `list_loras` now shows a LoRA's steps and CFG. It also shows trigger words again: they were
  missing because the service sends them as `triggerWords`.
