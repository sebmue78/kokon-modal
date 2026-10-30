//! Fork: Layout. The user draws rectangles on a canvas the shape of the new image and writes in
//! each what should appear there; the prompt describes the whole scene. How the boxes reach the
//! model depends on what it understands ([`LayoutStyle`]):
//!
//! - FLUX.3 Image Klein reads boxes natively: the caption tags each element (`<box_1>`) and ends
//!   with a JSON list of `{"id", "bbox": [top, left, bottom, right] on 0..1000, "desc"}`.
//! - Qwen-Image 2.1 and Fibo 2.0 Dev get the sketch (the app draws the labelled boxes) as their
//!   first image, with an instruction to use it as a plan only, plus the positions in words.
//! - Krea 2 and MOSS-Image see no images: the positions are written into the prompt.
//! - Fibo 2.0 Edit Turbo makes no new images, so it has no layout.

use crate::error::{AppError, AppResult};
use crate::planner::{GenerationRequest, InpaintAction, Mode};
use image::{GrayImage, Luma};
use serde::{Deserialize, Serialize};

/// The most boxes a layout can have (each one is a line of the prompt).
pub const MAX_BOXES: usize = 12;

/// How a model is told about a layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LayoutStyle {
    /// The sketch as reference image 1 (Qwen-Image 2.1, Fibo 2.0 Dev).
    #[default]
    Sketch,
    /// Boxes in the caption, FLUX.3 Image Klein's own format.
    Native,
    /// Positions in words only (Krea 2, MOSS-Image).
    Words,
    /// No layout (models that make no new images).
    None,
}

/// One rectangle of a layout, in fractions of the image (0..1 from the top left).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct LayoutBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// What should appear in the box.
    pub text: String,
    /// An outline drawn point by point (fractions, like the box), when the area is not a
    /// rectangle; the box is then its bounding box. Drawn as a shape in the sketch; FLUX.3 and
    /// the words use the bounding box.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<[f32; 2]>,
}

impl LayoutBox {
    /// The box clamped into the image, with its text on one line.
    fn clean(&self) -> Option<LayoutBox> {
        let text = self.text.split_whitespace().collect::<Vec<_>>().join(" ");
        let f = |v: f32| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
        let points: Vec<[f32; 2]> = self.points.iter().map(|[px, py]| [f(*px), f(*py)]).collect();
        // An outline needs three points; its box is its bounding box.
        let points = if points.len() >= 3 { points } else { Vec::new() };
        let (x, y, w, h) = if points.is_empty() {
            let (x, y) = (f(self.x), f(self.y));
            (x, y, f(self.w).min(1.0 - x), f(self.h).min(1.0 - y))
        } else {
            let (mut x0, mut y0, mut x1, mut y1) = (1.0f32, 1.0f32, 0.0f32, 0.0f32);
            for [px, py] in &points {
                (x0, y0, x1, y1) = (x0.min(*px), y0.min(*py), x1.max(*px), y1.max(*py));
            }
            (x0, y0, x1 - x0, y1 - y0)
        };
        (!text.is_empty() && w > 0.005 && h > 0.005).then_some(LayoutBox { x, y, w, h, text, points })
    }

    /// `[top, left, bottom, right]` on 0..1000 (FLUX.3's box format).
    pub fn bbox_1000(&self) -> [u32; 4] {
        let k = |v: f32| (v * 1000.0).round().clamp(0.0, 1000.0) as u32;
        [k(self.y), k(self.x), k(self.y + self.h), k(self.x + self.w)]
    }

    /// Where the box is, in words: "in the top left, small", "across the bottom, wide".
    pub fn position_words(&self) -> String {
        let (cx, cy) = (self.x + self.w / 2.0, self.y + self.h / 2.0);
        let col = if cx < 1.0 / 3.0 { "left" } else if cx > 2.0 / 3.0 { "right" } else { "center" };
        let row = if cy < 1.0 / 3.0 { "top" } else if cy > 2.0 / 3.0 { "bottom" } else { "middle" };
        let place = if self.w >= 0.8 && self.h >= 0.8 {
            "filling the whole image".to_string()
        } else if self.w >= 0.8 {
            format!("across the {} of the image", if row == "middle" { "middle" } else { row })
        } else if self.h >= 0.8 {
            format!("down the {} of the image", if col == "center" { "center" } else { col })
        } else {
            match (row, col) {
                ("middle", "center") => "in the center of the image".to_string(),
                ("middle", c) => format!("on the {c} side of the image"),
                (r, "center") => format!("at the {r} center of the image"),
                (r, c) => format!("in the {r} {c} of the image"),
            }
        };
        let area = self.w * self.h;
        let size = if area >= 0.64 {
            ""
        } else if area >= 0.25 {
            ", large"
        } else if area >= 0.06 {
            ", medium-sized"
        } else {
            ", small"
        };
        let pct = |v: f32| (v * 100.0).round() as u32;
        format!("{place}{size} (from {}% to {}% across, {}% to {}% down)", pct(self.x), pct(self.x + self.w), pct(self.y), pct(self.y + self.h))
    }
}

/// The boxes worth sending: clamped, with text, at most [`MAX_BOXES`].
pub fn clean_boxes(boxes: &[LayoutBox]) -> Vec<LayoutBox> {
    boxes.iter().filter_map(LayoutBox::clean).take(MAX_BOXES).collect()
}

/// Checks a request with a layout and turns it into the job the model gets: a new image, from
/// the sketch for [`LayoutStyle::Sketch`] (`layout_sketch` becomes image 1, mode Compose),
/// from text alone otherwise. The prompt stays the user's scene; [`prompt`] adds the boxes when
/// the job runs (after Prompt+).
pub fn prepare_request(request: &mut GenerationRequest, style: LayoutStyle) -> AppResult<()> {
    request.layout = clean_boxes(&request.layout);
    let sketch = request.layout_sketch.take();
    if request.layout.is_empty() {
        return Ok(());
    }
    if style == LayoutStyle::None {
        return Err(AppError::invalid("This model makes no new images, so it can't follow a layout.").suggest("Choose another model in the menu at the top, or remove the layout."));
    }
    if !request.images.is_empty() || request.mask.is_some() || request.outpaint.is_some() || request.mode == Mode::Upscale {
        return Err(AppError::invalid("A layout makes a new image: remove the images, the painted area or Expand, or remove the layout."));
    }
    match (style, sketch) {
        (LayoutStyle::Sketch, Some(s)) if !s.trim().is_empty() => {
            request.images = vec![s];
            request.mode = Mode::Compose;
        }
        _ => request.mode = Mode::Generate,
    }
    Ok(())
}

/// Whether a prepared request uses the sketch as image 1.
pub fn uses_sketch(request: &GenerationRequest, style: LayoutStyle) -> bool {
    style == LayoutStyle::Sketch && !request.layout.is_empty() && request.mode == Mode::Compose && request.images.len() == 1
}

/// The prompt of a job with a layout: the scene (the user's words, or Prompt+'s), followed by
/// the boxes in the model's form. Without boxes, the scene as is.
pub fn prompt(style: LayoutStyle, scene: &str, boxes: &[LayoutBox], sketch: bool) -> String {
    let scene = scene.trim().trim_end_matches('.').trim();
    if boxes.is_empty() {
        return scene.to_string();
    }
    // "A beach. " in front of the boxes, nothing when the boxes are the whole description.
    let scene = if scene.is_empty() { String::new() } else { format!("{scene}. ") };
    let scene = scene.as_str();
    match style {
        LayoutStyle::Native => native_prompt(scene, boxes),
        LayoutStyle::Sketch if sketch => sketch_prompt(scene, boxes),
        LayoutStyle::Sketch | LayoutStyle::Words | LayoutStyle::None => words_prompt(scene, boxes),
    }
}

fn native_prompt(scene: &str, boxes: &[LayoutBox]) -> String {
    let tags = boxes.iter().enumerate().map(|(i, b)| format!("<box_{}> {}", i + 1, b.text)).collect::<Vec<_>>().join(", ");
    let list: Vec<serde_json::Value> =
        boxes.iter().enumerate().map(|(i, b)| serde_json::json!({ "id": format!("box_{}", i + 1), "bbox": b.bbox_1000(), "desc": b.text })).collect();
    format!("{scene}The image shows {tags}.\n{}", serde_json::Value::Array(list))
}

fn placements(boxes: &[LayoutBox], numbered: bool) -> String {
    boxes
        .iter()
        .enumerate()
        .map(|(i, b)| if numbered { format!("{}. {}: {}", i + 1, b.text, b.position_words()) } else { format!("{} {}", b.text, b.position_words()) })
        .collect::<Vec<_>>()
        .join("; ")
}

fn words_prompt(scene: &str, boxes: &[LayoutBox]) -> String {
    format!("{scene}Composition: {}.", placements(boxes, false))
}

fn sketch_prompt(scene: &str, boxes: &[LayoutBox]) -> String {
    format!(
        "{scene}<image1> is only a layout plan: each numbered area marks where something goes, how much space it takes and its rough shape. \
         Place each element at the position, size and shape of its area: {}. \
         Do not draw the outlines, numbers, labels or the plain background of <image1>; make a finished, natural image of the scene.",
        placements(boxes, true)
    )
}

// ---------------------------------------------------------------------------------------
// Fork: areas on a photo being edited ("regions"). The user draws areas over image 1 in the
// brushed-edit editor; each area with a text says what goes there. Qwen-Image 2.1 changes them all
// at once (each marked in its own color in the guide image, see `regions_inpaint_prompt`); the
// other models paint one area at a time (`engine`: one pass per area, chained).
// ---------------------------------------------------------------------------------------

/// The most areas with a text in one edit (each needs its own guide color).
pub const MAX_REGIONS: usize = 8;

/// Guide colors of the areas, in order, as the prompt names them; the last one marks the
/// brushed rest (the user's prompt), if any.
pub const REGION_COLORS: [(&str, [u8; 3]); MAX_REGIONS + 1] = [
    ("red", [255, 0, 0]),
    ("blue", [0, 80, 255]),
    ("green", [0, 200, 0]),
    ("yellow", [255, 230, 0]),
    ("magenta", [255, 0, 255]),
    ("cyan", [0, 230, 255]),
    ("orange", [255, 140, 0]),
    ("purple", [140, 0, 255]),
    ("white", [255, 255, 255]),
];

/// The areas worth using for an edit: clamped, with text, at most [`MAX_REGIONS`].
pub fn clean_regions(regions: &[LayoutBox]) -> Vec<LayoutBox> {
    regions.iter().filter_map(LayoutBox::clean).take(MAX_REGIONS).collect()
}

/// Checks the areas of an edit: they need image 1 and the painted mask (which covers them).
pub fn prepare_regions(request: &mut GenerationRequest) -> AppResult<()> {
    request.regions = clean_regions(&request.regions);
    if request.regions.is_empty() {
        return Ok(());
    }
    if request.images.is_empty() || request.mask.is_none() {
        return Err(AppError::invalid("Areas with a text change a photo: open one and mark the areas in Paint area."));
    }
    Ok(())
}

/// `boxes` filled white on black, `width`×`height` (fractions of the image scaled to it).
pub fn rasterize(boxes: &[&LayoutBox], width: u32, height: u32) -> GrayImage {
    let mut m = GrayImage::from_pixel(width, height, Luma([0]));
    for b in boxes {
        let pts: Vec<(f64, f64)> = if b.points.len() >= 3 {
            b.points.iter().map(|[x, y]| (*x as f64 * width as f64, *y as f64 * height as f64)).collect()
        } else {
            let (x0, y0) = (b.x as f64 * width as f64, b.y as f64 * height as f64);
            let (x1, y1) = (x0 + b.w as f64 * width as f64, y0 + b.h as f64 * height as f64);
            vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        };
        fill_polygon(&mut m, &pts);
    }
    m
}

/// Even-odd scanline fill of a closed polygon, sampled at pixel centers.
fn fill_polygon(m: &mut GrayImage, pts: &[(f64, f64)]) {
    let (w, h) = m.dimensions();
    let (lo, hi) = pts.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.1), hi.max(p.1)));
    let y0 = (lo.floor().max(0.0)) as u32;
    let y1 = (hi.ceil().min(h as f64)) as u32;
    let mut xs: Vec<f64> = Vec::new();
    for y in y0..y1 {
        let cy = y as f64 + 0.5;
        xs.clear();
        for i in 0..pts.len() {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            if (a.1 <= cy && b.1 > cy) || (b.1 <= cy && a.1 > cy) {
                xs.push(a.0 + (cy - a.1) / (b.1 - a.1) * (b.0 - a.0));
            }
        }
        xs.sort_by(|a, b| a.total_cmp(b));
        for pair in xs.chunks(2) {
            if let [l, r] = pair {
                let from = (l - 0.5).ceil().max(0.0) as u32;
                let to = ((r - 0.5).floor() + 1.0).min(w as f64).max(0.0) as u32;
                for x in from..to {
                    m.put_pixel(x, y, Luma([255]));
                }
            }
        }
    }
}

/// `mask` without the areas (where > 127 in `areas`): the brushed rest, which takes the prompt.
pub fn subtract(mask: &GrayImage, areas: &GrayImage) -> GrayImage {
    let a = crate::imaging::resize_mask(areas, mask.width(), mask.height());
    GrayImage::from_fn(mask.width(), mask.height(), |x, y| if a.get_pixel(x, y)[0] > 127 { Luma([0]) } else { *mask.get_pixel(x, y) })
}

/// One pass of an edit with areas, for the models that paint one area at a time: its prompt,
/// what to do, and where (a mask of image 1's mask size).
pub struct Pass {
    pub prompt: String,
    pub action: InpaintAction,
    pub mask: GrayImage,
}

/// An area's mask grown by a small margin (4% of its larger side): a drawn area is a rough
/// outline, and a subject that reaches just past it (a head, a shoe) is kept instead of cut off.
pub fn with_margin(mask: &GrayImage, area: &LayoutBox, w: u32, h: u32) -> GrayImage {
    let side = (area.w * w as f32).max(area.h * h as f32);
    crate::imaging::dilate(mask, ((side * 0.04).round() as u32).max(3))
}

/// The passes of an edit with areas for a plain-inpainting model (FLUX.3, Fibo 2.0, Krea 2,
/// MOSS-Image): first the brushed rest with the user's prompt (if there is a rest and a prompt),
/// then each area with its text, in order. Each pass starts from the result of the one before.
pub fn passes(request: &GenerationRequest, mask: &GrayImage) -> Vec<Pass> {
    let (w, h) = mask.dimensions();
    let all: Vec<&LayoutBox> = request.regions.iter().collect();
    let rest = subtract(mask, &rasterize(&all, w, h));
    let mut out = Vec::new();
    let action = request.inpaint_action.resolve(&request.prompt);
    if crate::imaging::mask_coverage(&rest, 127) > 0.0005 && (!request.prompt.trim().is_empty() || action == InpaintAction::Remove) {
        out.push(Pass { prompt: request.prompt.clone(), action: request.inpaint_action, mask: rest });
    }
    for r in &request.regions {
        // The area's text says what goes there: a replacement, fitted into the scene.
        out.push(Pass { prompt: r.text.clone(), action: InpaintAction::Replace, mask: with_margin(&rasterize(&[r], w, h), r, w, h) });
    }
    out
}

/// Qwen-Image 2.1's instruction for several areas at once: each marked in its own color in
/// `<image2>` (`regions`: color name and text), and the brushed rest (`rest`: color, action and
/// the user's prompt) if there is one.
pub fn regions_inpaint_prompt(regions: &[(&str, &str)], rest: Option<(&str, InpaintAction, &str)>) -> String {
    let mut parts: Vec<String> = regions.iter().map(|(color, text)| format!("inside the area marked in {color}, {}", text.trim().trim_end_matches('.'))).collect();
    if let Some((color, action, prompt)) = rest {
        let what = action.subject(prompt);
        parts.push(match action {
            InpaintAction::Remove => format!("remove what is inside the area marked in {color} and fill it with the background that would naturally be behind it"),
            InpaintAction::Edit => format!("in the area marked in {color}, {what}"),
            InpaintAction::Replace | InpaintAction::Add => format!("inside the area marked in {color}, {what}"),
        });
    }
    format!(
        "In <image1>, change only the areas marked in <image2>, each as described: {}. Match the scene's lighting, perspective, scale and style so every change looks naturally part of the image. Keep everything outside the marked areas exactly as it is.",
        parts.join("; ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f32, y: f32, w: f32, h: f32, t: &str) -> LayoutBox {
        LayoutBox { x, y, w, h, text: t.into(), points: vec![] }
    }

    #[test]
    fn areas_are_rasterized() {
        let rect = b(0.25, 0.5, 0.5, 0.25, "x");
        let m = rasterize(&[&rect], 100, 100);
        assert_eq!(m.get_pixel(50, 60)[0], 255);
        assert_eq!(m.get_pixel(20, 60)[0], 0);
        assert_eq!(m.pixels().filter(|p| p[0] == 255).count(), 50 * 25);
        // A triangle: half its box.
        let tri = LayoutBox { text: "t".into(), points: vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]], ..Default::default() };
        let n = rasterize(&[&tri], 200, 200).pixels().filter(|p| p[0] == 255).count() as f64;
        assert!((n / 40_000.0 - 0.5).abs() < 0.01, "{n}");
        // The rest of a mask without the areas.
        let full = GrayImage::from_pixel(100, 100, Luma([255]));
        assert_eq!(subtract(&full, &m).pixels().filter(|p| p[0] == 255).count(), 100 * 100 - 50 * 25);
    }

    #[test]
    fn qwen_gets_every_area_by_color() {
        let p = regions_inpaint_prompt(&[("red", "a red car."), ("blue", "a dog")], Some(("white", InpaintAction::Edit, "make the sky stormy")));
        assert!(p.starts_with("In <image1>, change only the areas marked in <image2>"), "{p}");
        assert!(p.contains("inside the area marked in red, a red car; inside the area marked in blue, a dog; in the area marked in white, make the sky stormy."), "{p}");
        assert!(regions_inpaint_prompt(&[("red", "x")], Some(("white", InpaintAction::Remove, ""))).contains("remove what is inside the area marked in white"));
        assert!(regions_inpaint_prompt(&[("red", "x")], None).contains("marked in red, x. Match"));
    }

    #[test]
    fn plain_models_paint_one_area_at_a_time() {
        let regions = vec![b(0.0, 0.0, 0.25, 0.25, "a cat"), b(0.5, 0.5, 0.25, 0.25, "a dog")];
        // The mask: both areas and a brushed stroke elsewhere.
        let mut mask = rasterize(&regions.iter().collect::<Vec<_>>(), 100, 100);
        for x in 0..100 {
            for y in 90..100 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        let r = GenerationRequest { prompt: "make the grass green".into(), regions: regions.clone(), ..Default::default() };
        let p = passes(&r, &mask);
        assert_eq!(p.iter().map(|x| x.prompt.as_str()).collect::<Vec<_>>(), ["make the grass green", "a cat", "a dog"]);
        assert_eq!(p[1].action, InpaintAction::Replace);
        assert_eq!(p[0].mask.pixels().filter(|v| v[0] > 127).count(), 1000, "the rest is the stroke only");
        assert_eq!(p[2].mask.get_pixel(60, 60)[0], 255);
        // A little past the area (25 px wide at 100 px: a 3 px margin), not much more.
        assert_eq!(p[2].mask.get_pixel(48, 60)[0], 255);
        assert_eq!(p[2].mask.get_pixel(45, 60)[0], 0);
        // Without a prompt the stroke is left out: only the areas.
        let r = GenerationRequest { regions, ..Default::default() };
        assert_eq!(passes(&r, &mask).len(), 2);
    }

    #[test]
    fn regions_need_a_photo_and_a_mask() {
        let mut r = GenerationRequest { prompt: "".into(), regions: vec![b(0.0, 0.0, 0.3, 0.3, "a cat"), b(0.5, 0.5, 0.2, 0.2, " ")], ..Default::default() };
        assert!(prepare_regions(&mut r.clone()).is_err());
        r.images = vec!["input:a".into()];
        r.mask = Some("input:m".into());
        prepare_regions(&mut r).unwrap();
        assert_eq!(r.regions.len(), 1, "the area without text is only part of the mask");
        let many = GenerationRequest { regions: vec![b(0.0, 0.0, 0.3, 0.3, "x"); 20], ..Default::default() };
        assert_eq!(clean_regions(&many.regions).len(), MAX_REGIONS);
    }

    #[test]
    fn outlines_take_their_bounding_box() {
        let shape = LayoutBox { text: "a lake".into(), points: vec![[0.2, 0.5], [0.6, 0.4], [0.7, 1.4], [0.1, 0.9]], ..Default::default() };
        let c = &clean_boxes(&[shape])[0];
        for (got, want) in [(c.x, 0.1), (c.y, 0.4), (c.w, 0.6), (c.h, 0.6)] {
            assert!((got - want).abs() < 1e-6, "{got} vs {want}");
        }
        assert_eq!(c.points[2], [0.7, 1.0], "clamped into the image");
        assert_eq!(c.bbox_1000(), [400, 100, 1000, 700]);
        // Two points are no outline: the box as given.
        let line = LayoutBox { x: 0.1, y: 0.1, w: 0.2, h: 0.2, text: "x".into(), points: vec![[0.0, 0.0], [1.0, 1.0]] };
        let c = &clean_boxes(&[line])[0];
        assert!(c.points.is_empty() && c.w == 0.2);
        // Older apps send no points.
        let old: LayoutBox = serde_json::from_str(r#"{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"text":"x"}"#).unwrap();
        assert!(old.points.is_empty());
    }

    #[test]
    fn boxes_are_clamped_and_empty_ones_dropped() {
        let c = clean_boxes(&[b(0.9, 0.5, 0.5, 0.2, "  a red\n car "), b(0.1, 0.1, 0.2, 0.2, "   "), b(0.2, 0.2, 0.001, 0.3, "too thin"), b(f32::NAN, 0.0, 0.5, 0.5, "nan")]);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].text, "a red car");
        assert!((c[0].w - 0.1).abs() < 1e-6, "kept inside the image");
        assert_eq!(c[1].x, 0.0);
        assert_eq!(clean_boxes(&vec![b(0.0, 0.0, 0.5, 0.5, "x"); 20]).len(), MAX_BOXES);
    }

    #[test]
    fn flux3_gets_its_box_format() {
        let p = prompt(LayoutStyle::Native, "A sunny street.", &[b(0.0, 0.5, 0.5, 0.5, "a red car"), b(0.25, 0.0, 0.5, 0.2, "the word \"SALE\"")], false);
        let (caption, json) = p.split_once('\n').unwrap();
        assert_eq!(caption, "A sunny street. The image shows <box_1> a red car, <box_2> the word \"SALE\".");
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v[0]["id"], "box_1");
        assert_eq!(v[0]["bbox"], serde_json::json!([500, 0, 1000, 500]));
        assert_eq!(v[1]["bbox"], serde_json::json!([0, 250, 200, 750]));
        assert_eq!(v[1]["desc"], "the word \"SALE\"");
    }

    #[test]
    fn positions_in_words() {
        assert_eq!(b(0.0, 0.0, 0.2, 0.2, "x").position_words(), "in the top left of the image, small (from 0% to 20% across, 0% to 20% down)");
        assert!(b(0.0, 0.7, 1.0, 0.3, "x").position_words().starts_with("across the bottom of the image, large"));
        assert!(b(0.3, 0.3, 0.4, 0.4, "x").position_words().starts_with("in the center of the image, medium-sized"));
        assert!(b(0.6, 0.0, 0.4, 1.0, "x").position_words().starts_with("down the right of the image, large"));
        let p = prompt(LayoutStyle::Words, "a beach", &[b(0.0, 0.0, 0.3, 0.3, "a seagull")], false);
        assert!(p.starts_with("a beach. Composition: a seagull in the top left of the image"), "{p}");
    }

    #[test]
    fn sketch_prompt_names_the_plan() {
        let boxes = [b(0.0, 0.0, 0.3, 0.3, "a seagull")];
        let p = prompt(LayoutStyle::Sketch, "a beach", &boxes, true);
        assert!(p.contains("<image1> is only a layout plan") && p.contains("1. a seagull: in the top left") && p.contains("Do not draw the outlines"), "{p}");
        // Without the sketch (an older app), the words.
        assert!(prompt(LayoutStyle::Sketch, "a beach", &boxes, false).contains("Composition:"));
        assert_eq!(prompt(LayoutStyle::Native, " a beach. ", &[], false), "a beach");
        assert!(prompt(LayoutStyle::Words, "", &boxes, false).starts_with("Composition: a seagull"));
    }

    #[test]
    fn requests_become_new_images() {
        let mut r = GenerationRequest { prompt: "a beach".into(), layout: vec![b(0.0, 0.0, 0.3, 0.3, "a seagull")], layout_sketch: Some("input:abc".into()), ..Default::default() };
        let mut s = r.clone();
        prepare_request(&mut s, LayoutStyle::Sketch).unwrap();
        assert_eq!((s.mode, s.images.clone(), s.layout_sketch.clone()), (Mode::Compose, vec!["input:abc".to_string()], None));
        assert!(uses_sketch(&s, LayoutStyle::Sketch));
        let mut n = r.clone();
        prepare_request(&mut n, LayoutStyle::Native).unwrap();
        assert!(n.mode == Mode::Generate && n.images.is_empty() && !uses_sketch(&n, LayoutStyle::Native));
        assert!(prepare_request(&mut r.clone(), LayoutStyle::None).unwrap_err().message.contains("no new images"));
        r.images = vec!["input:photo".into()];
        assert!(prepare_request(&mut r, LayoutStyle::Words).unwrap_err().message.contains("new image"));
        // Boxes without text: no layout, the request as it was.
        let mut e = GenerationRequest { prompt: "a beach".into(), layout: vec![b(0.0, 0.0, 0.3, 0.3, " ")], layout_sketch: Some("input:abc".into()), ..Default::default() };
        prepare_request(&mut e, LayoutStyle::None).unwrap();
        assert!(e.layout.is_empty() && e.images.is_empty() && e.layout_sketch.is_none() && e.mode == Mode::Auto);
    }
}
