//! Fork: Fibo 2.0 Dev and Edit Turbo. Dev makes new images and edits (20 steps, CFG 5); Edit Turbo
//! only edits (4 steps). Both share FLUX.3 Image Klein's text encoder, vision projector and VAE,
//! see the references through their text encoder, and name input images `<image_N>`.

use crate::catalog;
use crate::config::{AppConfig, FIBO2_DEV_PROFILE_ID, FIBO2_EDIT_PROFILE_ID, FLUX3_PROFILE_ID, GpuBackend, RecommendedSettings};
use crate::geometry::Size;
use crate::imaging::LoadedImage;
use crate::pipeline::{BackendOptions, prepare, underscore_image_tags};
use crate::planner::{GenerationRequest, PlanInputs, ResolvedMode, plan};
use image::{Rgba, RgbaImage};

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

fn cfg(dir: &std::path::Path, preset: &str, id: &str) -> AppConfig {
    let mut c = AppConfig { sdcpp_dir: dir.to_path_buf(), gpu_backend: GpuBackend::Cuda, ..Default::default() };
    c.apply_preset(catalog::preset(preset).unwrap());
    c.use_extra_catalog(id);
    c
}

#[test]
fn both_profiles_share_flux3s_files() {
    let dir = tempfile::tempdir().unwrap();
    let flux = cfg(dir.path(), "24gb", FLUX3_PROFILE_ID).profile().clone();
    for (id, dit) in [(FIBO2_DEV_PROFILE_ID, catalog::FIBO2_DEV_Q8_0), (FIBO2_EDIT_PROFILE_ID, catalog::FIBO2_EDIT_Q8_0)] {
        let c = cfg(dir.path(), "24gb", id);
        let p = c.profile();
        assert_eq!(p.id, id);
        assert_eq!(p.diffusion_model, dit.path(dir.path()));
        assert_eq!((&p.text_encoder, &p.vae, &p.vision_projector), (&flux.text_encoder, &flux.vae, &flux.vision_projector), "{id}: downloaded once");
        assert!(p.from_catalog() && !p.is_qwen());
    }
    let ids: Vec<&str> = catalog::profile_model_downloads(cfg(dir.path(), "16gb", FIBO2_DEV_PROFILE_ID).profile()).iter().map(|d| d.id).collect();
    assert_eq!(ids[0], "fibo2_dev_q5_0", "16 GB: the 5-bit file");
    assert_eq!(catalog::fibo2_files(catalog::preset("12gb").unwrap(), true).0.id, "fibo2_edit_q4_0");
    for d in catalog::FIBO2_DOWNLOADS {
        assert_eq!(d.sha256.len(), 64, "{} is pinned", d.id);
        assert!(d.dest.starts_with(catalog::FIBO2_SUBDIR) && d.url.ends_with(d.file_name()));
    }
}

#[test]
fn dev_makes_new_images_with_cfg() {
    let rec = RecommendedSettings::fibo2_dev();
    let p = plan(&req("a lighthouse at dusk"), &inputs(vec![]), &rec).unwrap();
    assert_eq!((p.mode, p.steps, p.cfg), (ResolvedMode::Generate, 20, 5.0));
    assert!(rec.prompt_vision && rec.reference_edits && !rec.qwen_prompts);
}

#[test]
fn edit_turbo_edits_only() {
    let rec = RecommendedSettings::fibo2_edit_turbo();
    let e = plan(&req("a lighthouse at dusk"), &inputs(vec![]), &rec).unwrap_err();
    assert!(e.message.contains("only edits"), "{}", e.message);
    let img = photo(1200, 800);
    let r = req("make it night");
    let p = plan(&r, &inputs(vec![img.size()]), &rec).unwrap();
    assert_eq!((p.mode, p.steps, p.cfg), (ResolvedMode::Edit, 4, 1.0));
    let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.ref_images.len(), 1);
}

#[test]
fn image_tags_follow_fibos_form() {
    assert_eq!(underscore_image_tags("put the cat from <image2> on the sofa in <Image 1>, like <image_3>"), "put the cat from <image_2> on the sofa in <image_1>, like <image_3>");
    let rec = RecommendedSettings::fibo2_dev();
    let imgs = [photo(800, 600), photo(640, 640)];
    let r = req("the cat from <image2> on the sofa from <image1>");
    let p = plan(&r, &inputs(imgs.iter().map(|i| i.size()).collect()), &rec).unwrap();
    let j = prepare(&p, &r.prompt, 1, &imgs, None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.prompt, "the cat from <image_2> on the sofa from <image_1>");
    // Other models keep the prompt as written.
    let p = plan(&r, &inputs(imgs.iter().map(|i| i.size()).collect()), &RecommendedSettings::flux3_klein()).unwrap();
    assert_eq!(prepare(&p, &r.prompt, 1, &imgs, None, &BackendOptions::default()).unwrap().request.prompt, r.prompt);
}
