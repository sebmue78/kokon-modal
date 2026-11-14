- **Based on Kokon 0.12.1.** This version brings in Kokon 0.12.0 and 0.12.1:
  - **Layers lab** (experimental): split an image into layers, move, scale and edit them one by
    one, export a PSD.
  - **Colours in Paint area**: one colour per thing, fill its area, say what goes there; the model
    changes them in one go. **Select** fills an object with one click.
  - **More like this**: a new version of a result that keeps its layout (Subtle or Strong).
  - **AI marking** (EU AI Act): every result says in its file information that it was made with
    AI, and carries an invisible watermark. Settings → General → Check an image reads both.
  - The GPU is freed after 10 idle minutes, an optional folder for each project, a faster Mac
    engine on the M5, Prompt+ for painted areas and Expand, and many fixes.
- **Paint area has both ways now.** Kokon's Colours, and under **One area** our Rectangle, Outline
  and Freehand tools next to the brush and Select. Areas with a text still say what goes there.
- **What works with which model:**
  - Colours needs a model that sees the photo: Qwen-Image 2.1, FLUX.3 and Fibo 2.0. With Krea 2
    and MOSS-Image it is switched off and One area is used.
  - Prompt+ for a painted area needs a model whose text encoder sees images: Qwen-Image 2.1 and
    Fibo 2.0. With FLUX.3 and Krea 2 your own words are used.
  - The Layers lab and More like this were made for Qwen-Image 2.1 and have not been tried with
    the other models.
- Layout for new images, the extra models, LoRAs per model, the second GPU and updates from this
  repository are unchanged.
- Versions now count from Kokon 0.12.1: 0.12.1024 is Kokon 0.12.1, build 24.
- Not tried on a GPU yet. Please report what you notice.
