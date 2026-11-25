- **Fixed: black images from the Mac engine with LoRAs.** In 0.12.1035, every image made on the Mac
  engine with a LoRA came out black, for example Uncensored Omni with its Turbo LoRA. With a LoRA, two
  of the engine's combined steps looked up the Neural Engine's scaling values under the wrong name,
  found none and computed with zeros. They now find them. The same image made on the graphics card
  alone was always fine.
- **No more black images when the Mac engine's numbers overflow.** The engine checks its in-between
  values after every step. If they are no longer valid, it stops with a clear error instead of saving
  a black image. Kokon then makes the image again on the standard engine and says so in the job notes.
- **New model: Juggernaut Moss Turbo** (KandooAI, Apache-2.0, commercial use allowed). A fine-tune of
  MOSS-Image for photography and film stills, with KandooAI's own Turbo built in: 6 steps without CFG.
  - Choose it in the model menu at the top. The first time, it downloads KandooAI's GGUF: Q8_0
    (5.7 GB) on cards with 14 GB or more, Q4_0 (3.3 GB) below that.
  - It shares MOSS-Image's text encoder, tokenizer and decoder. With MOSS-Image installed, only the
    image model is downloaded.
  - Settings from its model card: euler_ancestral with ComfyUI's "simple" schedule at shift 5. Kokon
    sends that schedule itself, because the engine's own schedule loses the last of the 6 steps.
  - Image sizes start at about 1.6 MP (Fast) and go up to 2.4 MP (Quality). The author advises
    1.5 to 2.4 MP and never 1 MP.
  - Like MOSS-Image, it makes new images from text, plus brushed changes and Expand. It does not
    edit a whole photo.
- **Prompt+ instructions per model.** Settings → General → Prompt+ has a new part: "New images, per
  model". Choose a model and write instructions that apply to it alone. Models without their own
  instructions keep using the general ones, as before.
- **Juggernaut Moss gets its own Prompt+ instructions**, written from KandooAI's 24-page prompting
  guide. Prompt+ writes the prompt the way the model was trained:
  - in a fixed order: image type, subject, surroundings, light and colours, camera and focus, text in
    quotes, then an optional look sentence;
  - signs and labels are described, so the model does not invent gibberish text;
  - nothing is named that should not appear;
  - no quality tags or camera names.
- **Prompt+ for MOSS-Image and Juggernaut Moss.** Their text encoder (Qwen3.5) cannot write text in
  the engine, so until now Prompt+ was missing for both.
  - Prompt+ now borrows another installed model's text encoder for them, Qwen-Image 2.1 first. The
    engine loads only that text encoder, writes the prompt with the instructions of the model in use,
    then loads the model in use.
  - This adds a model load before the image. The job notes say which model wrote the prompt.
