//! Fork: Krea 2 Turbo as a second, selectable model next to Qwen-Image 2.1. Checks that every
//! layer (profile, catalog, launch arguments, planner, pipeline) treats it as a text-to-image
//! model with plain masked inpainting, and leaves Qwen's behaviour unchanged.

use image::{GrayImage, Luma, Rgba, RgbaImage};

use crate::catalog;
use crate::config::{
    AppConfig, GpuBackend, KREA2_PROFILE_ID, ModelProfile, OFFICIAL_PROFILE_ID, ProfileSource,
    RecommendedSettings,
};
use crate::geometry::{ExpansionUnits, Size};
use crate::imaging::{self, LoadedImage};
use crate::pipeline::{BackendOptions, prepare};
use crate::planner::{
    GenerationRequest, InpaintAction, OutpaintSpec, PlanInputs, ResolvedMode, TURBO_SIGMAS, plan,
};

fn photo(w: u32, h: u32) -> LoadedImage {
    let pixels = RgbaImage::from_fn(w, h, |x, y| {
        Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
    });
    LoadedImage {
        pixels,
        format: "png",
        exif_orientation: 1,
        icc_profile: None,
        has_transparency: false,
        text: vec![],
    }
}

fn req(p: &str) -> GenerationRequest {
    GenerationRequest {
        prompt: p.into(),
        preserve_dimensions: true,
        ..Default::default()
    }
}

fn inputs(sizes: Vec<Size>) -> PlanInputs {
    PlanInputs {
        image_sizes: sizes,
        vram_total_mib: Some(24 * 1024),
        ..Default::default()
    }
}

fn krea_cfg(dir: &std::path::Path) -> AppConfig {
    let mut c = AppConfig {
        sdcpp_dir: dir.to_path_buf(),
        gpu_backend: GpuBackend::Cuda,
        ..Default::default()
    };
    c.apply_preset(catalog::preset("24gb").unwrap());
    c.use_krea2();
    c
}

#[test]
fn krea_profile_is_always_offered_and_selectable() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = AppConfig {
        sdcpp_dir: dir.path().to_path_buf(),
        ..Default::default()
    };
    c.normalize();
    c.normalize();
    let ids: Vec<&str> = c.profiles.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![OFFICIAL_PROFILE_ID, KREA2_PROFILE_ID],
        "listed once, right after the official files"
    );
    assert_eq!(
        c.active_profile, OFFICIAL_PROFILE_ID,
        "Qwen stays the default"
    );

    let c = krea_cfg(dir.path());
    let p = c.profile();
    assert!(p.is_krea2() && p.from_catalog() && !p.is_official());
    assert_eq!(p.source, ProfileSource::Official);
    assert_eq!(p.vision_projector, None, "Krea 2 takes no reference images");
    assert_eq!(
        p.diffusion_model,
        catalog::KREA2_TURBO_Q8_0.path(dir.path()),
        "24 GB: the 8-bit file"
    );
    assert_eq!(p.vae, catalog::KREA2_VAE.path(dir.path()));
    assert_eq!(
        p.text_encoder,
        catalog::KREA2_TEXT_ENCODER_Q8_0.path(dir.path())
    );
    assert!(
        !p.capabilities.edit
            && !p.capabilities.multi_reference
            && p.capabilities.inpaint
            && p.capabilities.outpaint
    );

    // Saved and loaded again: still active, still one Krea profile.
    let path = dir.path().join("config.json");
    c.save_to(&path).unwrap();
    let back = AppConfig::load_from(&path);
    assert_eq!(back.active_profile, KREA2_PROFILE_ID);
    assert_eq!(back.profiles.iter().filter(|p| p.is_krea2()).count(), 1);
}

#[test]
fn krea_files_follow_the_preset() {
    let q = |id: &str| catalog::krea2_files(catalog::preset(id).unwrap());
    assert_eq!(q("8gb").0.id, catalog::KREA2_TURBO_Q4_K_M.id);
    assert_eq!(q("8gb").1.id, catalog::KREA2_TEXT_ENCODER_Q4_K_M.id);
    assert_eq!(q("16gb").0.id, catalog::KREA2_TURBO_Q4_K_M.id);
    assert_eq!(q("16gb").1.id, catalog::KREA2_TEXT_ENCODER_Q8_0.id);
    assert_eq!(q("24gb").0.id, catalog::KREA2_TURBO_Q8_0.id);
    assert_eq!(q("32gb").0.id, catalog::KREA2_TURBO_Q8_0.id);
    for d in catalog::KREA2_DOWNLOADS {
        assert_eq!(d.sha256.len(), 64, "{} is pinned", d.id);
        assert!(
            d.url.starts_with("https://huggingface.co/")
                && d.size > 0
                && d.dest.starts_with(catalog::KREA2_SUBDIR)
        );
    }
}

#[test]
fn missing_krea_files_are_downloadable() {
    let dir = tempfile::tempdir().unwrap();
    let c = krea_cfg(dir.path());
    let names: Vec<&str> = catalog::profile_model_downloads(c.profile())
        .iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(
        names,
        vec!["krea2_turbo_q8_0", "krea2_vae", "krea2_text_encoder_q8_0"]
    );
    let all = catalog::downloads_for_profile(c.profile(), GpuBackend::Cuda);
    assert!(
        all.iter().any(|d| d.kind == catalog::FileKind::Engine),
        "the engine comes along"
    );
}

#[test]
fn krea_launch_args_skip_qwen_options() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = krea_cfg(dir.path());
    c.prefix_cache_type = "q8_0".into();
    let s = crate::process::build_server_args(&c, c.profile()).join(" ");
    assert!(s.contains(&format!(
        "--diffusion-model {}",
        catalog::KREA2_TURBO_Q8_0.path(dir.path()).display()
    )));
    assert!(s.contains(&format!(
        "--llm {}",
        catalog::KREA2_TEXT_ENCODER_Q8_0.path(dir.path()).display()
    )));
    assert!(!s.contains("--llm_vision"));
    assert!(!s.contains("qwen_image_2_1_prefix_cache"), "{s}");
    // Qwen still gets its prefix cache.
    c.use_official();
    let s = crate::process::build_server_args(&c, c.profile()).join(" ");
    assert!(s.contains("qwen_image_2_1_prefix_cache_type=q8_0"));
}

#[test]
fn krea_never_runs_on_the_mac_engine() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = krea_cfg(dir.path());
    c.gpu_backend = GpuBackend::Metal;
    c.mac_engine = true;
    assert!(!c.uses_mac_engine());
    c.use_official();
    assert!(c.uses_mac_engine());
}

#[test]
fn krea_plans_text_to_image_with_its_own_schedule() {
    let rec = RecommendedSettings::krea2_turbo();
    let p = plan(&req("a lighthouse at dusk"), &inputs(vec![]), &rec).unwrap();
    assert_eq!(p.mode, ResolvedMode::Generate);
    assert_eq!((p.steps, p.cfg), (8, 1.0));
    assert!(
        p.custom_sigmas.is_empty(),
        "the server's Krea 2 schedule, not Qwen's sigmas"
    );
    assert!(!p.reference_edits);
    assert!(p.working.is_aligned(16) && p.working.width <= 2048 && p.working.height <= 2048);
    // Qwen is unchanged.
    let q = plan(
        &req("a lighthouse at dusk"),
        &inputs(vec![]),
        &RecommendedSettings::default(),
    )
    .unwrap();
    assert_eq!(q.custom_sigmas, TURBO_SIGMAS.to_vec());
    assert!(q.reference_edits);
}

#[test]
fn krea_refuses_reference_edits() {
    let rec = RecommendedSettings::krea2_turbo();
    let one = plan(
        &req("make it golden hour"),
        &inputs(vec![Size::new(800, 600)]),
        &rec,
    )
    .unwrap_err();
    assert!(one.message.contains("text only"), "{}", one.message);
    let two = plan(
        &req("put the cat on the sofa"),
        &inputs(vec![Size::new(800, 600), Size::new(640, 480)]),
        &rec,
    )
    .unwrap_err();
    assert!(two.message.contains("text only"), "{}", two.message);
}

#[test]
fn krea_inpaints_with_the_mask_only() {
    let rec = RecommendedSettings::krea2_turbo();
    let mut img = photo(900, 700);
    let mut m = GrayImage::new(900, 700);
    for y in 300..360 {
        for x in 400..480 {
            m.put_pixel(x, y, Luma([255]));
            img.pixels.put_pixel(x, y, Rgba([255, 255, 255, 255]));
        }
    }
    for (action, prompt, expect) in [
        (
            InpaintAction::Replace,
            "replace it with a red apple",
            "a red apple, fitting",
        ),
        (InpaintAction::Remove, "remove the box", "empty background"),
        (
            InpaintAction::Edit,
            "a small potted plant",
            "a small potted plant",
        ),
    ] {
        let mut r = req(prompt);
        r.mask = Some("input:m".into());
        r.inpaint_action = action;
        let pi = PlanInputs {
            image_sizes: vec![img.size()],
            mask: Some((
                Size::new(900, 700),
                imaging::mask_bbox(&m, 127),
                imaging::mask_coverage(&m, 127),
            )),
            vram_total_mib: Some(24 * 1024),
            ..Default::default()
        };
        let p = plan(&r, &pi, &rec).unwrap();
        assert_eq!(p.mode, ResolvedMode::Inpaint);
        let j = prepare(
            &p,
            &r.prompt,
            1,
            std::slice::from_ref(&img),
            Some(&m),
            &BackendOptions::default(),
        )
        .unwrap();
        assert!(
            j.request.ref_images.is_empty(),
            "{action:?}: no reference images"
        );
        assert!(j.request.init_image.is_some() && j.request.mask_image.is_some());
        assert!(
            !j.request.prompt.contains("<image"),
            "{action:?}: no Qwen instruction: {}",
            j.request.prompt
        );
        assert!(
            j.request.prompt.starts_with(expect),
            "{action:?}: {}",
            j.request.prompt
        );
        assert!(
            j.request
                .image_preprocess
                .iter()
                .all(|s| !s.contains("target=ref"))
        );
    }
}

#[test]
fn krea_outpaints_without_a_reference() {
    let rec = RecommendedSettings::krea2_turbo();
    let img = photo(800, 600);
    let mut r = req("more beach");
    r.outpaint = Some(OutpaintSpec {
        left: 0.0,
        right: 50.0,
        top: 0.0,
        bottom: 0.0,
        units: ExpansionUnits::Percent,
    });
    let p = plan(&r, &inputs(vec![img.size()]), &rec).unwrap();
    assert_eq!(p.mode, ResolvedMode::Outpaint);
    let j = prepare(
        &p,
        &r.prompt,
        1,
        std::slice::from_ref(&img),
        None,
        &BackendOptions::default(),
    )
    .unwrap();
    assert!(j.request.ref_images.is_empty());
    assert!(j.request.init_image.is_some() && j.request.mask_image.is_some());
    assert_eq!(
        j.request.prompt, "more beach",
        "a description, not Qwen's instruction"
    );
}

#[test]
fn krea_keeps_transparency_words_as_written() {
    let rec = RecommendedSettings::krea2_turbo();
    let p = plan(
        &req("a glass bottle, transparent background"),
        &inputs(vec![]),
        &rec,
    )
    .unwrap();
    let j = prepare(
        &p,
        "a glass bottle, transparent background",
        1,
        &[],
        None,
        &BackendOptions::default(),
    )
    .unwrap();
    assert_eq!(j.request.prompt, "a glass bottle, transparent background");
}

#[test]
fn qwen_profiles_are_untouched_by_the_krea_switch() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = krea_cfg(dir.path());
    // The Qwen update paths only change the user's own files, never Krea's.
    c.use_improved_vae();
    c.use_new_dit();
    let krea = c
        .profiles
        .iter()
        .find(|p| p.id == KREA2_PROFILE_ID)
        .unwrap();
    assert_eq!(krea, &ModelProfile::krea2(dir.path(), c.preset()));
    assert_eq!(c.model_vram_extra_mib(false), 0, "nothing on disk yet");
}
