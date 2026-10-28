<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo/kokon-logo-white.svg">
    <img src="assets/brand/logo/kokon-logo.svg" alt="Kokon Modal" width="260">
  </picture>
</p>

<h3 align="center">Kokon Modal: edit and create photos by describing them, with the open model you choose.</h3>

<p align="center">
  A fork of <a href="https://github.com/GabrieleLozupone/kokon"><b>Kokon</b></a> by Gabriele Lozupone that adds
  <b>FLUX.3 Image Klein</b>, <b>Fibo 2.0</b>, <b>Krea 2 Turbo</b> and <b>MOSS-Image</b> next to Qwen-Image 2.1.<br>
  Everything still runs on your own GPU: no account, no uploads, no limits.
</p>

<p align="center">
  <a href="https://github.com/sebmue78/kokon-modal/releases"><b>Download (Windows, alpha)</b></a> ·
  <a href="#models">Models</a> ·
  <a href="#whats-different-from-kokon">What's different</a> ·
  <a href="#install">Install</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="https://github.com/GabrieleLozupone/kokon#readme">Kokon's own README</a>
</p>

> [!IMPORTANT]
> **Alpha.** Kokon Modal is an early fork. The Windows installer is built by GitHub Actions and
> published as a pre-release; the new models have been tried on a few GPUs only. Kokon itself is
> the tested app: for that, use [Kokon's releases](https://github.com/GabrieleLozupone/kokon/releases).

## Based on Kokon

Kokon Modal is built on [Kokon](https://github.com/GabrieleLozupone/kokon) by
[Gabriele Lozupone](https://github.com/GabrieleLozupone): the app, its engine (Kokon's build of
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)), the planner, the editor,
the gallery and the Mac engine are his work. This fork adds more models and what they need. Kokon
Modal shows this on its welcome and setup screens and in Settings, with a link to the original.

If Kokon is useful to you, [support its author](https://kokon.app/support/).

## Models

Choose a model in the **model menu at the top**. Qwen-Image 2.1 is downloaded at setup; the others
are downloaded the first time you choose them (the app asks first, then shows the download).

| Model | What it does | Steps | Prompt+ | License (check before commercial use) |
| --- | --- | --- | --- | --- |
| **Qwen-Image 2.1 Turbo** (Alibaba Qwen) | New images, every kind of edit, combining images, LoRAs | 8 | yes | Qwen Research License: research and evaluation only, non-commercial |
| **FLUX.3 Image Klein** (Black Forest Labs, 5.6B) | New images, edits of a whole photo, combining up to 10 images; brushed changes as plain inpainting | 16 | yes, recommended | FLUX Kommunity License: non-commercial; commercial use of images only for qualifying users |
| **Fibo 2.0 Dev** (Bria, 8B) | New images, edits of a whole photo, combining up to 10 images (`<image_1>`, `<image_2>`); brushed changes as plain inpainting | 20, CFG 5 | yes, sees your images | CC BY-NC 4.0: non-commercial only |
| **Fibo 2.0 Edit Turbo** (Bria, 8B) | Fast edits of a whole photo and combining images; no new images from text | 4 | yes, sees your images | CC BY-NC 4.0: non-commercial only |
| **Krea 2 Turbo** (Krea, 12.9B) | New images from text, up to 2K; brushed changes and Expand as plain inpainting | 8 | yes | Krea 2 Community License |
| **MOSS-Image SFT** (OpenMOSS, 5B) | New images from text, with CFG and negative prompts; brushed changes and Expand | 20 | no (its Qwen3.5 encoder can't write text in the engine) | Apache-2.0 |

Download sizes on a 24 GB card (smaller files are picked for smaller cards): Qwen-Image about
12 GB, FLUX.3 about 12 GB, Fibo 2.0 Dev or Edit Turbo about 16 GB each, Krea 2 about 18 GB,
MOSS-Image about 12 GB. FLUX.3, Fibo 2.0 and Krea 2 share their text encoder (Qwen3-VL 4B), and
FLUX.3, Fibo 2.0 and MOSS-Image their decoder (the FLUX.2 VAE): a shared file is downloaded once,
so the second of them is much smaller (Fibo 2.0 after FLUX.3: about 10 GB). Every file is pinned by URL, size and SHA-256 and checked after
download.

The image sizes of the quality presets follow the model: Qwen-Image 2.1 and Krea 2 go up to 2K,
FLUX.3, Fibo 2.0 and MOSS-Image to 1.5K for now (not measured yet on real hardware).

## What's different from Kokon

- **More models**, with a model menu in the top bar that shows the model in use, switches and
  loads a model at once, and downloads one that is not there yet.
- **Edits where the model can do them.** Qwen-Image 2.1, FLUX.3 and Fibo 2.0 edit photos and combine images;
  with Krea 2 and MOSS-Image, Kokon Modal offers what they do (new images, brushed changes, Expand)
  and says so instead of failing.
- **LoRAs per model.** Each LoRA is loaded for the model in use and only used with it; the LoRA
  button next to the prompt lists the LoRAs of that model, and each model keeps its own choice per
  project. LoRAs for FLUX.3, Krea 2 and MOSS-Image are not tested yet.
- **Prompt+ with FLUX.3 and Krea 2.** Their Qwen3-VL 4B text encoder ties its output layer to its
  embeddings, so its GGUF has no LM head and the engine could not write with it. Kokon Modal writes
  a copy with the head added once (about 4.7 GB, next to the downloaded file, which stays as it
  is) and runs Prompt+ on it. The engine shows input images to the text encoder of Qwen-Image 2.1
  and Fibo 2.0 only, so with FLUX.3 and Krea 2 Prompt+ rewrites edits and combinations from your
  words alone, with instructions written for that.
- **Its own app next to Kokon.** Kokon Modal has its own name, app id (`app.kokonmodal.desktop`),
  install folder, settings (`%APPDATA%\Kokon Modal`), data and models (`%LOCALAPPDATA%\KokonModalData`),
  output folder (`Pictures\Kokon Modal`) and ports (39160-39162; Kokon uses 39150-39152). Both apps
  can be installed and run at the same time, and neither touches the other's files or processes.
- **No automatic updates yet.** The in-app update check points at this fork, which publishes no
  update manifest yet: install a new alpha over the old one (settings, gallery and models stay).
- Small fixes: the setup's file list no longer garbles rows waiting to download.

## Install

1. Download `Kokon-modal_<version>_x64-setup.exe` from the
   [releases](https://github.com/sebmue78/kokon-modal/releases) (the SHA-256 is in the notes).
2. The installer is not code-signed: Windows SmartScreen may ask once (**More info → Run anyway**).
3. On first start, Setup checks your GPU and downloads the engine and Qwen-Image 2.1.
   Already have Kokon's model files? **Use models I already have** can point Kokon Modal at them
   (in `%LOCALAPPDATA%\KokonData\sdcpp\models\qwen21`) instead of downloading them again.
4. Choose FLUX.3, Fibo 2.0, Krea 2 or MOSS-Image in the model menu at the top when you want them.

**Requirements** are Kokon's: Windows 10/11 64-bit, an NVIDIA card with 12 GB of VRAM (8 GB in
beta) or AMD/Intel through Vulkan (beta), 16 GB of RAM (32 GB recommended), and an SSD with room
for the models you use. Krea 2 is the largest model; 24 GB of VRAM gets the 8-bit files of every
model. macOS and Linux builds work as in Kokon but are not built for this fork yet.

## Build from source

Kokon Modal builds like Kokon: see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
In short:

```bash
npm install
cargo test -p qls-core -p qls-service   # core and service, no GPU needed
npm test                                # UI logic
npx tauri dev                           # run the app (Windows)
```

The Windows alpha is built by [`.github/workflows/alpha-windows.yml`](.github/workflows/alpha-windows.yml)
on every push to the `alpha-release` branch: tests, the service, the MCP server, the app and the
NSIS installer, then a pre-release `v<version>-modal-alpha.<run>`. It is built without Kokon's
updater signing key (no updater artifacts).

Where the fork's changes live:

| Change | Files |
| --- | --- |
| Model profiles, downloads, settings | `crates/qls-core/src/config.rs`, `catalog.rs` |
| Steps, CFG, edits per model | `crates/qls-core/src/planner.rs`, `pipeline.rs` |
| LM head for Qwen3-VL 4B | `crates/qls-core/src/gguf_head.rs` |
| LoRAs per model | `crates/qls-core/src/lora.rs`, `src/components/LoraSettings.tsx` |
| Model menu, "Based on Kokon" | `src/components/ModelPicker.tsx`, `BasedOn.tsx` |
| App identity | `src-tauri/tauri.conf.json`, `src-tauri/windows/`, `crates/qls-core/src/config.rs` |
| Model names in the UI | `src/lib/models.ts` |
| Tests | `crates/qls-core/src/krea2_tests.rs`, `moss_tests.rs`, `flux3_tests.rs`, `fibo2_tests.rs` |

## Everything else

Kokon Modal keeps all of Kokon's features: brushed edits, Expand, the upscalers, LUTs, private
mode, other devices in a browser, the HTTP API and the MCP server for AI agents (they talk to Kokon
Modal's own service and data folder). They are described in
[Kokon's README](https://github.com/GabrieleLozupone/kokon#readme) and in [docs/](docs/).

## License

Kokon Modal is a modified version of Kokon and, like Kokon, is licensed under the
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only); see [NOTICE](NOTICE) for the
third-party code. Changes in this fork are marked "Fork:" in the code and listed in the git history.

The models are not part of this repository. Each is downloaded from Hugging Face under its own
license, which you accept when you download it; read it on the model's page before using images
commercially.
