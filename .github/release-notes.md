- **Prompt+ instructions per model and per kind of text.** Settings → General → Prompt+ → "Instructions
  per model" now has a second choice, "For", with five kinds of text:
  - new images;
  - edits;
  - new images from references;
  - painted areas;
  - Expand.

  Each model only lists the kinds it can do. Instructions you saved for a model in 0.12.1036 stay as its
  instructions for new images.
- **Built-in instructions from the models' own prompting guides.** Models with built-in instructions use
  them instead of the general ones, including any general instructions you wrote in Settings. You can
  still replace them per model.
  - **Juggernaut Moss Turbo:** new instructions for painted areas and Expand, written from KandooAI's
    guide:
    - a painted area gets a short caption of what the area shows after the change;
    - Expand gets one caption of the whole wider picture.
  - **FLUX.3 Image Klein** (Black Forest Labs' guides):
    - framing first, then the subject with its action, the background, the light, and a short closing
      style line;
    - plain surfaces are described as plain, because the model has no negative prompt;
    - each text in quotes, with its size, weight and place.
  - **Krea 2 Turbo** (Krea's own expansion prompt and guide): one cohesive, faithful paragraph that
    names the medium early.
  - **Fibo 2.0** (Bria's own prompt-to-JSON instructions): Prompt+ writes the structured JSON caption
    Fibo was trained on. With a layout, the boxes go into its summary.
  - **MOSS-Image** (OpenMOSS's guide): an English caption that gives visible text exactly, with its
    layout and line breaks.
  - **Qwen-Image 2.1** keeps Kokon's general instructions. They were tested for it and already follow
    Qwen's own prompt rewriter.
- **Prompt+ for painted areas and Expand on MOSS-Image and Juggernaut Moss.** These models cannot
  write text themselves, so Kokon borrows the text encoder of another installed model (Qwen-Image 2.1
  first). That model looks at the painted area or the wider picture and writes the text, then the
  image is made with the model in use.
- **Changed for Krea 2 Turbo:** Prompt+ on a painted area now keeps your words and says so in the
  notes, because the model cannot see the area. Before, it wrote an editing instruction, which these
  models do not use.
