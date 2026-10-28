- **New: Layout.** For a new image, the **Layout** button next to the aspect ratio opens a canvas
  in the image's shape. Drag to draw boxes, move them by their bar and resize them by their corners,
  and write in each box what should appear there (at most 12 boxes). The prompt describes the whole
  scene, and the boxes say where things go. How each model follows the layout:
  - **FLUX.3 Image Klein** reads the boxes directly, in its own box format.
  - **Qwen-Image 2.1 and Fibo 2.0 Dev** get the layout as a sketch to follow: a reference image
    with the numbered boxes, plus the positions in words.
  - **Krea 2 and MOSS-Image** get the positions in words, so the placement is approximate.
  - **Fibo 2.0 Edit Turbo** makes no new images, so it can't follow a layout.

  With Prompt+ on, Prompt+ first writes the scene and then the boxes are added.
- **Release notes** now list what changed, with every commit since the previous alpha.
- This version still has to be tested on a GPU, Layout above all. Please report what you notice.
