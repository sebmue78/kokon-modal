- **Fixed: a LoRA with its own CFG stopped Turbo models.** A LoRA whose CFG was set above 1 (for
  example CFG 4, the value for the full Qwen-Image model) made every image with Qwen-Image 2.1
  Turbo fail with "The inference server rejected the request". Turbo models run without CFG.
  - A LoRA's CFG is now left out on models that run at CFG 1 (the Turbo models). Its steps
    still apply.
  - The job notes say so: "The LoRA … asks for CFG 4, but this model runs without CFG, so that is
    not used."
  - On models with CFG (MOSS-Image, Fibo 2.0 Dev), a LoRA's CFG is used as before.
- MCP: when a job fails, the error text now includes the engine's own reason (for example
  "txt_cfg 4.0: … runs at CFG 1 only"), not only "The inference server rejected the request."
