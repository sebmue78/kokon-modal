- **New: Freehand.** Layout has a third tool next to Rectangle and Outline: hold the mouse and draw
  around an area; it closes when you let go and becomes an outline whose points you can still move.
- **New: areas in Paint area.** When you edit a photo, Paint area now has Rectangle, Outline and
  Freehand next to the brush. Every area you draw is changed. Write in an area what goes there, or
  leave it empty and your prompt changes it, like a brushed stroke. With areas that have a text, the
  prompt is optional. At most 8 areas.
  - **Qwen-Image 2.1** changes all areas at once: each is marked in its own color in the image it
    follows, with the text for that color.
  - **FLUX.3, Fibo 2.0, Krea 2 and MOSS-Image** change one area at a time: one pass per area, each
    starting from the result of the one before, saved as one image. Three areas take about three
    times as long; the progress card says which pass is running.
- Reopening an edit from the gallery brings its areas back.
- Not tried on a GPU yet: how well each model follows several areas. Please report what you notice.
