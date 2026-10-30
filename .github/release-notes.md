- **New: a second GPU.** On a PC with more than one graphics card, Settings → Performance → **Second
  GPU** puts the text encoder and the image decoder (VAE) on another card. The image model then
  has the first card to itself.
  - Prompts are read faster, and Prompt+ writes faster: the text encoder no longer has to come
    from system memory every time.
  - The image model has more room for large images.
  - One image is still computed on one card: each step runs on the first GPU, so a single image
    gets only a little faster. Off by default; the engine restarts when you change it. Not
    available on a Mac.
- Not tried on a PC with several GPUs yet. Please report whether it starts and how fast it is.
