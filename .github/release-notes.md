- **New: Qwen-Image 2.1 in full 16-bit precision.** The model menu at the top has a new entry,
  **Qwen-Image 2.1 · 16-bit**: the same Qwen-Image 2.1 Turbo without 4-bit quantization (14.2 GB
  instead of 4.2 GB), with the 8-bit text encoder (8.7 GB, in system memory). It is downloaded the
  first time you choose it; the decoder and vision files are shared with the 4-bit Qwen.
  - Everything Qwen-Image 2.1 does works the same: edits, Colours, areas, Layout, Prompt+, and its
    LoRAs.
  - Best on a card with 16 GB or more (on a 24 GB card it fits entirely). On smaller cards, parts
    are moved to system memory and it is slower.
  - On a Mac it runs on the standard engine, not Kokon's Mac engine.
- The 4-bit Qwen-Image 2.1 stays the default; switch between both in the model menu.
