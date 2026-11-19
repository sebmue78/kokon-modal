- **AI agents (MCP) now know which model fits which task.** If no model is named in the request,
  the agent keeps the model in use. It only switches when that model cannot do the task, and then
  tells you which model it chose.
  - When the model in use cannot do something (for example Krea 2 or MOSS-Image asked to edit a
    whole photo, or Fibo 2.0 Edit Turbo asked for a new image from text), the tool now stops before
    anything runs. It names the best model that is already downloaded.
  - **list_models** now shows, per model, what it is best for and its license. It also lists the
    best downloaded model per task: new image, new image with layout, edit a whole photo, combine
    images, change part of a photo, remove an object, expand.
  - The recommendations follow what the models can do:
    - Qwen-Image 2.1 is the all-rounder and comes first for edits, removals and changing parts.
    - FLUX.3 Klein for layouts.
    - Fibo 2.0 Edit Turbo for fast edits.
    - Krea 2 and MOSS-Image for new images from text.
  - The agent mentions the non-commercial licenses (Qwen-Image 2.1, FLUX.3, Fibo 2.0) when you say
    the images are for commercial use.
  - Models are still only downloaded after the agent asks you.
