- **Kokon's Mac engine runs LoRAs.** On a Mac, Qwen-Image 2.1 and Qwen-Image 2.1 Uncensored Omni
  now use your LoRAs on the fast Mac engine. Before, the Mac engine left them out and said
  "This inference engine can't use LoRAs".
  - The engine adds each LoRA to a weight just as it unpacks it for the product. The model files
    are never changed, and nothing stays merged between images.
  - LoRAs are applied the same way as on the standard engine (strength, alpha and rank, several
    LoRAs at once).
  - Plain LoRAs only. LoHa, LoKr, DoRA and full-weight LoRAs get a clear message and still run on
    the standard engine (turn the Mac engine off for them).
- **Uncensored Omni on the Mac engine.** With its Turbo LoRA (8 steps, CFG off), Omni now runs on
  Kokon's Mac engine, about 2.5–3x faster than on the standard engine.
  - The engine reads Omni's GGUF as it is (Diffusers' tensor names, split MLP layers).
  - A job with CFG (Omni with its Turbo LoRA turned off, CFG 5) runs on the standard engine by
    itself. The job notes say so, and the next job without CFG goes back to the Mac engine.
- Qwen-Image 2.1 models now always send their sampling schedule (custom sigmas), the same one the
  standard engine uses by itself. This lets the Mac engine run step counts other than Turbo's 8
  (for example a LoRA's own steps).
