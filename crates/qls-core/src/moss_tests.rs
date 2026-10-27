//! Fork: MOSS-Image SFT as a third, selectable model. Like Krea 2 it is text to image with plain
//! masked inpainting; unlike it, it is not distilled (20 steps at CFG 3, negative prompt used)
//! and needs an external tokenizer.

use crate::catalog;
use crate::config::{AppConfig, GpuBackend, MOSS_PROFILE_ID, ModelProfile, RecommendedSettings};
use crate::geometry::Size;
use crate::pipeline::{BackendOptions, prepare};
use crate::planner::{GenerationRequest, PlanInputs, ResolvedMode, plan};

fn moss_cfg(dir: &std::path::Path, preset: &str) -> AppConfig {
    let mut c = AppConfig { sdcpp_dir: dir.to_path_buf(), gpu_backend: GpuBackend::Cuda, ..Default::default() };
    c.apply_preset(catalog::preset(preset).unwrap());
    c.use_extra_catalog(MOSS_PROFILE_ID);
    c
}

#[test]
fn moss_profile_has_its_files_and_tokenizer() {
    let dir = tempfile::tempdir().unwrap();
    let c = moss_cfg(dir.path(), "24gb");
    let p = c.profile();
    assert_eq!(p.id, MOSS_PROFILE_ID);
    assert!(p.from_catalog() && !p.is_official() && !p.is_qwen() && !p.is_krea2());
    assert_eq!(p.diffusion_model, catalog::MOSS_SFT_Q8_0.path(dir.path()));
    assert_eq!(p.text_encoder, catalog::MOSS_TEXT_ENCODER_Q4_K_M.path(dir.path()));
    assert_eq!(p.vae, catalog::MOSS_VAE.path(dir.path()));
    assert_eq!(p.tokenizer, Some(catalog::MOSS_TOKENIZER.path(dir.path())));
    assert_eq!(p.vision_projector, None);
    assert!(p.files().iter().any(|(l, _, req)| l.starts_with("Tokenizer") && *req), "a missing tokenizer stops the start");

    let path = dir.path().join("config.json");
    c.save_to(&path).unwrap();
    let back = AppConfig::load_from(&path);
    assert_eq!(back.active_profile, MOSS_PROFILE_ID);
    assert_eq!(back.profiles.iter().filter(|p| p.id == MOSS_PROFILE_ID).count(), 1);
}

#[test]
fn moss_files_follow_the_preset() {
    let q = |id: &str| catalog::moss_files(catalog::preset(id).unwrap());
    assert_eq!(q("8gb").0.id, catalog::MOSS_SFT_Q4_K.id);
    assert_eq!(q("12gb").0.id, catalog::MOSS_SFT_Q4_K.id);
    assert_eq!(q("16gb").0.id, catalog::MOSS_SFT_Q8_0.id);
    assert_eq!(q("24gb").1.id, catalog::MOSS_TEXT_ENCODER_Q4_K_M.id);
    assert_eq!(q("32gb").1.id, catalog::MOSS_TEXT_ENCODER_Q8_0.id);
    for d in catalog::MOSS_DOWNLOADS {
        assert_eq!(d.sha256.len(), 64, "{} is pinned", d.id);
        assert!(d.url.starts_with("https://huggingface.co/") && d.size > 0 && d.dest.starts_with(catalog::MOSS_SUBDIR));
    }
}

#[test]
fn missing_moss_files_are_downloadable() {
    let dir = tempfile::tempdir().unwrap();
    let c = moss_cfg(dir.path(), "16gb");
    let ids: Vec<&str> = catalog::profile_model_downloads(c.profile()).iter().map(|d| d.id).collect();
    assert_eq!(ids, vec!["moss_sft_q8_0", "moss_vae", "moss_text_encoder_q4_k_m", "moss_tokenizer"]);
}

#[test]
fn moss_launch_args_pass_the_tokenizer() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = moss_cfg(dir.path(), "16gb");
    c.prefix_cache_type = "q8_0".into();
    let s = crate::process::build_server_args(&c, c.profile()).join(" ");
    assert!(s.contains(&format!("--tokenizer {}", catalog::MOSS_TOKENIZER.path(dir.path()).display())), "{s}");
    assert!(!s.contains("--llm_vision") && !s.contains("qwen_image_2_1_prefix_cache"), "{s}");
    // The Qwen files get no tokenizer argument.
    c.use_official();
    assert!(!crate::process::build_server_args(&c, c.profile()).iter().any(|a| a == "--tokenizer"));
}

#[test]
fn moss_never_runs_on_the_mac_engine() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = moss_cfg(dir.path(), "16gb");
    c.gpu_backend = GpuBackend::Metal;
    c.mac_engine = true;
    assert!(!c.uses_mac_engine());
}

#[test]
fn moss_plans_twenty_steps_with_cfg_and_negative_prompt() {
    let rec = RecommendedSettings::moss_image();
    let r = GenerationRequest { prompt: "a lighthouse at dusk".into(), negative_prompt: Some("blurry, text".into()), ..Default::default() };
    let p = plan(&r, &PlanInputs { vram_total_mib: Some(16 * 1024), ..Default::default() }, &rec).unwrap();
    assert_eq!(p.mode, ResolvedMode::Generate);
    assert_eq!((p.steps, p.cfg), (20, 3.0));
    assert!(p.custom_sigmas.is_empty(), "the server's MOSS schedule");
    assert!(p.working.is_aligned(16));
    assert!(!p.notes.iter().any(|n| n.contains("negative prompt")), "used with CFG: {:?}", p.notes);
    let j = prepare(&p, &r.prompt, 1, &[], None, &BackendOptions::default()).unwrap();
    assert_eq!(j.request.negative_prompt, "blurry, text");
    assert_eq!(j.request.sample_params.guidance.txt_cfg, 3.0);
    assert_eq!(j.request.sample_params.sample_steps, 20);
    // The time estimate counts the extra steps and the CFG pass.
    let turbo = plan(&r, &PlanInputs { vram_total_mib: Some(16 * 1024), ..Default::default() }, &RecommendedSettings::krea2_turbo()).unwrap();
    assert!(crate::planner::backend_seconds(&p, false) > crate::planner::backend_seconds(&turbo, false) * 2.0);
}

#[test]
fn moss_refuses_whole_photo_edits() {
    let rec = RecommendedSettings::moss_image();
    let r = GenerationRequest { prompt: "make it winter".into(), preserve_dimensions: true, ..Default::default() };
    let e = plan(&r, &PlanInputs { image_sizes: vec![Size::new(800, 600)], vram_total_mib: Some(16 * 1024), ..Default::default() }, &rec).unwrap_err();
    assert!(e.message.contains("text only"), "{}", e.message);
}

#[test]
fn old_profiles_without_a_tokenizer_still_load() {
    let json = r#"{"id":"qwen-image-2.1-user","displayName":"mine","diffusionModel":"/m/a.gguf","vae":"/m/v.safetensors","textEncoder":"/m/t.gguf"}"#;
    let p: ModelProfile = serde_json::from_str(json).unwrap();
    assert_eq!(p.tokenizer, None);
    assert_eq!(p.recommended_settings.cfg_scale, 1.0, "older settings keep Turbo's CFG");
}
