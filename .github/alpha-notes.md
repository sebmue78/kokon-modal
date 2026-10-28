- **New in Layout: outlines (polygonal lasso).** Next to **Rectangle**, the Layout editor now
  has an **Outline** tool. Click point by point, and the area closes when you click the first
  point again (or double-click). Then write what goes there.
  - Backspace takes back the last point; Esc stops the outline.
  - When an outline is selected, drag its points to reshape it. Drag its bar to move it, or its
    corners to stretch it.
  - Rectangles and outlines can be mixed in one layout (at most 12 areas).
- **How the models use outlines:** Qwen-Image 2.1 and Fibo 2.0 Dev see the real shape in the
  sketch they follow. FLUX.3, Krea 2 and MOSS-Image get the area around the outline (its
  bounding box), because their prompt formats only know rectangles.
- The editor remembers the tool you used last.
- This version still has to be tested on a GPU. Please report what you notice.
