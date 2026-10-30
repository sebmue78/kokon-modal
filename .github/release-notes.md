- **Fix: FLUX.3 and Fibo 2.0 in Paint area.** Brushed changes and areas with these two models were
  plain masked inpainting: the model saw only the text, not the photo. It drew the subject as if it
  were a whole picture (an old man's head filling the area instead of an old man sitting there) and
  ignored the scene. They now edit the way Qwen-Image 2.1 does: they see the photo and a copy with the
  area marked, and get an instruction to change only that area, matching the scene's lighting,
  perspective and scale. Areas are still painted one per pass.
- Krea 2 and MOSS-Image can't see a photo (no reference images in the engine), so they stay plain
  inpainting. Give them a short description of the scene in the prompt for better fitting results.
