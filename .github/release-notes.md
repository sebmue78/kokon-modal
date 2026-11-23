- **New model: Qwen-Image 2.1 Uncensored Omni.** chatrlabs' uncensored version of the full
  Qwen-Image 2.1, in the model menu and in Settings → Models.
  - It does everything Qwen-Image 2.1 does: new images, edits of a whole photo, combining images,
    brushed changes and Expand.
  - Its image model is downloaded in Q8_0 on cards with 14 GB or more (7.7 GB), else in Q4_K_M
    (4.5 GB). It uses Qwen-Image 2.1's text encoder, vision projector and VAE, so only the image
    model and the LoRA are new.
  - **Its Turbo LoRA comes with it:** chatrlabs' 8-step Turbo LoRA is downloaded with the model and
    added to Settings → LoRA as "Omni Turbo (8 steps)", on by default, with 8 steps and CFG off.
    Turned off, Omni runs 35 steps at CFG 5, as on its model card.
  - With the Turbo LoRA, Kokon sends Qwen-Image 2.1's schedule without the terminal stretch, which
    is what the LoRA was distilled for (Diffusers' `shift_terminal=None`).
  - Omni has its own LoRA list: its Turbo LoRA is never offered for Qwen-Image 2.1 Turbo, and Qwen
    LoRAs are loaded for Omni separately.
  - On a Mac, Omni runs on the standard engine, since Kokon's Mac engine has no LoRAs and no CFG.
  - Qwen Research License: research and evaluation, non-commercial.
- LoRAs: a speed LoRA with fewer steps than its model (on a full Qwen-Image 2.1 model) now uses the
  model's schedule without the terminal stretch.
- MCP: the model guide knows Omni (`qwen-image-2.1-omni`) and tells agents to pass its Turbo LoRA.
