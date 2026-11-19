- **Fixed: Prompt+ with Qwen-Image 2.1 on a Mac.** Prompt+ did nothing on a Mac when the Qwen3-VL
  text model was a Q8_0 file (for example Qwen3VL-8B-Instruct-Q8_0). The Mac engine's text writer
  only read Q4_K and Q6_K weights. It stopped with "unsupported GGUF content: output.weight: Q8_0",
  and the image was made from the prompt as written.
  - The Mac engine now reads Q8_0 weights too, so Prompt+ works with these files.
  - Nothing changes for Q4_K_M files or on Windows.
