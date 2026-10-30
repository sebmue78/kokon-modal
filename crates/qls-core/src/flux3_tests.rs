//! Fork: FLUX.3 Image Klein as a fourth model. Unlike Krea 2 and MOSS-Image it edits from
//! reference images (whole-photo edits, combines, new images from references), but with plain
//! masked inpainting and its own prompts instead of Qwen-Image 2.1's instruction formats.

use image::{GrayImage, Luma, Rgba, RgbaImage};

use crate::catalog;
use crate::config::{AppConfig, FLUX3_PROFILE_ID, GpuBackend, KREA2_PROFILE_ID, RecommendedSettings};
use crate::geometry::{ExpansionUnits, Size};
use crate::imaging::{self, LoadedImage};
use crate::pipeline::{BackendOptions, prepare};
use crate::planner::{GenerationRequest, InpaintAction, OutpaintSpec, PlanInputs, ResolvedMode, plan};

fn photo(w: u32, h: u32) -> LoadedImage {
    let pixels = RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]));
    LoadedImage { pixels, format: "png", exif_orientation: 1, icc_profile: None, has_transparency: false, text: vec![] }
}

fn req(p: &str) -> GenerationRequest {
    GenerationRequest { prompt: p.into(), preserve_dimensions: true, ..Default::default() }
}

fn inputs(sizes: Vec<Size>) -> PlanInputs {
    PlanInputs { image_sizes: sizes, vram_total_mib: Some(24 * 1024), ..Default::default() }
}

fn flux_cfg(dir: &std::path::Path, preset: &str) -> AppConfig {
    let mut c = AppConfig { sdcpp_dir: dir.to_path_buf(), gpu_backend: GpuBackend::Cuda, ..Default::default() };
    c.apply_preset(catalog::preset(preset).unwrap());
    c.use_extra_catalog(FLUX3_PROFILE_ID);
    c
}

#[test]
fn flux_profile_shares_the_text_encoder_and_vae() {
    let dir = tempfile::tempdir().unwrap();
    let c = flux_cfg(dir.path(), "24gb");
    let p = c.profile();
    assert_eq!(p.id, FLUX3_PROFILE_ID);
    assert!(p.from_catalog() && !p.is_qwen() && !p.is_official());
    assert_eq!(p.diffusion_model, catalog::FLUX3_KLEIN_Q8_0.path(dir.path()));
    assert_eq!(p.vision_projector, Some(catalog::QWEN3VL_4B_VISION.path(dir.path())));
    assert_eq!(p.tokenizer, None);
    // The same files as Krea 2's text encoder and MOSS-Image's VAE: downloaded once.
    let krea = c.profiles.iter().find(|q| q.id == KREA2_PROFILE_ID).unwrap();
    assert_eq!(p.text_encoder, krea.text_encoder);
    assert_eq!(p.vae, catalog::MOSS_VAE.path(dir.path()));
    assert!(p.capabilities.edit && p.capabilities.multi_reference && p.capabilities.inpaint && !p.capabilities.alpha);
}

#[test]
fn flux_downloads_are_pinned_and_follow_the_preset() {
    assert_eq!(catalog::flux3_files(catalog::preset("12gb").unwrap()).0.id, catalog::FLUX3_KLEIN_Q4_K.id);
    assert_eq!(catalog::flux3_files(catalog::preset("16gb").unwrap()).0.id, catalog::FLUX3_KLEIN_Q8_0.id);
    for d in catalog::FLUX3_DOWNLOADS {
        assert_eq!(d.sha256.len(), 64, "{} is pinned", d.id);
        assert!(d.url.starts_with("https://huggingface.co/") && d.size > 0 && d.dest.starts_with(catalog::FLUX3_SUBDIR));
    }
    let dir = tempfile::tempdir().unwrap();
    let c = flux_cfg(dir.path(), "16gb");
    let ids: Vec<&str> = catalog::profile_model_downloads(c.profile()).iter().map(|d| d.id).collect();
    assert_eq!(ids, vec!["flux3_klein_q8_0", "moss_vae", "krea2_text_encoder_q8_0", "qwen3vl_4b_vision"]);
    // With Krea 2's text encoder already there, it is not downloaded again.
    let te = &c.profile().text_encoder;
    std::fs::create_dir_all(te.parent().unwrap()).unwrap();
    std::fs::write(te, b"x").unwrap();
    assert!(!catalog::profile_model_downloads(c.profile()).iter().any(|d| d.id == "krea2_text_encoder_q8_0"));
}

#[test]
fn flux_launch_args() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = flux_cfg(dir.path(), "16gb");
    c.prefix_cache_type = "q8_0".into();
    let s = crate::process::build_server_args(&c, c.profile()).join(" ");
    assert!(s.contains(&format!("--llm_vision {}", catalog::QWEN3VL_4B_VISION.path(dir.path()).display())), "{s}");
    assert!(!s.contains("qwen_image_2_1_prefix_cache") && !s.contains("--tokenizer"), "{s}");
    c.gpu_backend = GpuBackend::Metal;
    c.mac_engine = true;
    assert!(!c.uses_mac_engine(), "the Mac engine runs Qwen-Image 2.1 only");
}

#[test]
fn flux_plans_sixteen_steps_without_cfg() {
    let rec = RecommendedSettings::flux3_klein();
    let p = plan(&req("a lighthouse at dusk"), &inputs(vec![]), &rec).unwrap();
    assert_eq!(p.mode, ResolvedMode::Generate);
    assert_eq!((p.steps, p.cfg), (16, 1.0));
    assert!(p.custom_sigmas.is_empty() && p.reference_edits && !p.qwen_prompts);
    assert!(!rec.prompt_vision && RecommendedSettings::default().prompt_vision, "the engine shows images to Qwen's text encoder only");
    assert!(p.working.is_aligned(16));
}

#[test]
fn flux_edits_a_photo_with_its_reference() {
    let rec = RecommendedSettings::flux3_klein();
    let img = photo(1200, 800);
    let r = req("make it a snowy winter evening");
    let p = plan(&r, &inputs(vec![img.size()]), &rec).unwrap();
    assert_eq!(p.mode, ResolvedMode::Edit);
    let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.ref_images.len(), 1);
    assert_eq!(j.request.prompt, "make it a snowy winter evening", "the prompt as written");
}

#[test]
fn flux_combines_several_images() {
    let rec = RecommendedSettings::flux3_klein();
    let imgs = [photo(800, 600), photo(640, 640), photo(600, 900)];
    let r = req("the cat from image 2 sitting on the sofa from image 1, painted like image 3");
    let p = plan(&r, &inputs(imgs.iter().map(|i| i.size()).collect()), &rec).unwrap();
    assert!(matches!(p.mode, ResolvedMode::MultiReference | ResolvedMode::Compose), "{:?}", p.mode);
    let j = prepare(&p, &r.prompt, 1, &imgs, None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.ref_images.len(), 3);
    let eleven: Vec<Size> = (0..11).map(|_| Size::new(512, 512)).collect();
    assert!(plan(&r, &inputs(eleven), &rec).is_err(), "at most 10 references");
}

#[test]
fn flux_brushed_edits_see_the_photo_and_the_marked_area() {
    let rec = RecommendedSettings::flux3_klein();
    let mut img = photo(900, 700);
    let mut m = GrayImage::new(900, 700);
    for y in 300..360 {
        for x in 400..480 {
            m.put_pixel(x, y, Luma([255]));
            img.pixels.put_pixel(x, y, Rgba([255, 255, 255, 255]));
        }
    }
    let mut r = req("replace it with a red apple");
    r.mask = Some("input:m".into());
    r.inpaint_action = InpaintAction::Replace;
    let pi = PlanInputs {
        image_sizes: vec![img.size()],
        mask: Some((Size::new(900, 700), imaging::mask_bbox(&m, 127), imaging::mask_coverage(&m, 127))),
        vram_total_mib: Some(24 * 1024),
        ..Default::default()
    };
    let p = plan(&r, &pi, &rec).unwrap();
    let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
    // The photo and a guide with the area marked, as for Qwen-Image 2.1 (plain inpainting drew the
    // subject at the scale of a whole picture), with the images named as FLUX.3's prompts do.
    assert_eq!(j.request.ref_images.len(), 2, "region + guide");
    assert!(j.request.mask_image.is_some() && j.request.init_image.is_some());
    let pr = &j.request.prompt;
    assert!(pr.contains("In image 1, replace what is inside the area marked in") && pr.contains("in image 2 with a red apple"), "{pr}");
    assert!(!pr.contains("<image"), "{pr}");
    // The whole area, and where it is in FLUX.3's box format (the box 300..360 × 400..480 of 900×700).
    assert!(pr.contains("Make it fit completely inside the marked area, nothing cut off at its edges."), "{pr}");
    let json = pr.split('\n').nth(1).expect("a box line");
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(v[0]["desc"], "a red apple");
    let bb: Vec<u64> = v[0]["bbox"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
    assert!(bb[0] < bb[2] && bb[1] < bb[3] && bb[2] - bb[0] < 400 && bb[3] - bb[1] < 400, "{bb:?}");
    // Fibo 2.0 names them its own way.
    let pf = plan(&r, &pi, &RecommendedSettings::fibo2_dev()).unwrap();
    let jf = prepare(&pf, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
    assert!(jf.request.prompt.contains("<image_1>") && jf.request.prompt.contains("<image_2>"), "{}", jf.request.prompt);
    assert!(!jf.request.prompt.contains("bbox"), "the box format is FLUX.3's");
    // Krea 2 has no reference edits: plain masked inpainting.
    let pk = plan(&r, &pi, &RecommendedSettings::krea2_turbo()).unwrap();
    let jk = prepare(&pk, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
    assert!(jk.request.ref_images.is_empty() && !jk.request.prompt.contains("image"), "{}", jk.request.prompt);
}

#[test]
fn flux_expand_keeps_its_reference() {
    let rec = RecommendedSettings::flux3_klein();
    let img = photo(800, 600);
    let mut r = req("more beach");
    r.outpaint = Some(OutpaintSpec { left: 0.0, right: 50.0, top: 0.0, bottom: 0.0, units: ExpansionUnits::Percent });
    let p = plan(&r, &inputs(vec![img.size()]), &rec).unwrap();
    let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.ref_images.len(), 1, "an editing model sees the source");
    assert_eq!(j.request.prompt, "more beach");
}
