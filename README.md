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
  <a href="https://github.com/sebmue78/kokon-modal/releases"><b>Download (Windows, Mac)</b></a> ·
  <a href="#models">Models</a> ·
  <a href="#whats-different-from-kokon">What's different</a> ·
  <a href="#install">Install</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="https://github.com/GabrieleLozupone/kokon#readme">Kokon's own README</a>
</p>

> [!NOTE]
> Kokon Modal is a young fork. The Windows installer is built by GitHub Actions and published as a
> release; the new models have been tried on a few GPUs only. Kokon itself is the more tested app:
> for that, use [Kokon's releases](https://github.com/GabrieleLozupone/kokon/releases).

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
| **Qwen-Image 2.1 Turbo** (Alibaba Qwen) | New images, every kind of edit, combining images | 8 | yes | Qwen Research License: research and evaluation only, non-commercial |
| **Qwen-Image 2.1 · 16-bit** | The same model in full precision (F16, 14.2 GB, 8-bit text encoder): no quantization loss | 8 | yes | Qwen Research License |
| **Qwen-Image 2.1 Uncensored Omni** (chatrlabs) | The full Qwen-Image 2.1 without its content filter: new images, every kind of edit, combining images. Its Turbo LoRA comes with it, switched on | 8 with its Turbo LoRA, else 35 at CFG 5 | yes | Qwen Research License |
| **FLUX.3 Image Klein** (Black Forest Labs, 5.6B) | New images, edits of a whole photo, combining up to 10 images, brushed changes and areas (seeing the photo) | 16 | yes, recommended | FLUX Kommunity License: non-commercial; commercial use of images only for qualifying users |
| **Fibo 2.0 Dev** (Bria, 8B) | New images, edits of a whole photo, combining up to 10 images (`<image_1>`, `<image_2>`), brushed changes and areas (seeing the photo) | 20, CFG 5 | yes, sees your images | CC BY-NC 4.0: non-commercial only |
| **Fibo 2.0 Edit Turbo** (Bria, 8B) | Fast edits of a whole photo and combining images; no new images from text | 4 | yes, sees your images | CC BY-NC 4.0: non-commercial only |
| **Krea 2 Turbo** (Krea, 12.9B) | New images from text, up to 2K; brushed changes and Expand as plain inpainting | 8 | yes | Krea 2 Community License |
| **MOSS-Image SFT** (OpenMOSS, 5B) | New images from text, with CFG and negative prompts; brushed changes and Expand | 20 | yes, written by another installed model (see below) | Apache-2.0 |
| **Juggernaut Moss Turbo** (KandooAI, MOSS-Image fine-tune) | Photographic new images and film stills from text, about 2 MP; brushed changes and Expand | 6 | yes, with instructions from KandooAI's prompting guide, written by another installed model | Apache-2.0 |

Download sizes on a 24 GB card (smaller files are picked for smaller cards): Qwen-Image about
12 GB, FLUX.3 about 12 GB, Fibo 2.0 Dev or Edit Turbo about 16 GB each, Krea 2 about 18 GB,
MOSS-Image about 12 GB, Juggernaut Moss Turbo 5.7 GB after MOSS-Image (it uses MOSS-Image's text
encoder, tokenizer and decoder; 3.3 GB on cards under 14 GB), Qwen-Image 2.1 Uncensored Omni about 8.4 GB after Qwen-Image 2.1 (it uses
Qwen's text encoder and decoder; 5.1 GB on cards under 14 GB). On a Mac, Kokon's Mac engine runs Omni
with its Turbo LoRA; without it (CFG 5) a job runs on the standard engine. FLUX.3, Fibo 2.0 and Krea 2 share their text encoder (Qwen3-VL 4B), and
FLUX.3, Fibo 2.0 and MOSS-Image their decoder (the FLUX.2 VAE): a shared file is downloaded once,
so the second of them is much smaller (Fibo 2.0 after FLUX.3: about 10 GB). Every file is pinned by URL, size and SHA-256 and checked after
download.

The image sizes of the quality presets follow the model: Qwen-Image 2.1 and Krea 2 go up to 2K,
FLUX.3, Fibo 2.0 and MOSS-Image to 1.5K for now (not measured yet on real hardware). Juggernaut Moss
Turbo starts at about 1.6 MP: its author advises 1.5 to 2.4 MP and never 1 MP.

MOSS-Image and Juggernaut Moss encode prompts with Qwen3.5 9B, which the engine cannot use to write
text. Prompt+ for them is written by another installed model with a Qwen3-VL text encoder
(Qwen-Image 2.1 first): the engine loads only that text encoder, writes the prompt with the instructions
of the model in use, then loads the model in use. That adds a model load before the image.

Prompt+ instructions can be set per model and per kind of text: new images, edits, new images from
references, painted areas and Expand (Settings → General → Prompt+). Several models come with their own,
written from their makers' prompting guides:

| Model | Own built-in instructions | Source |
|---|---|---|
| Juggernaut Moss Turbo | new images, painted areas, Expand | [KandooAI's prompting guide](https://huggingface.co/Kandoo/Juggernaut-Moss-Turbo-Beta/blob/main/Juggernaut_Moss_Prompting_Guide.pdf) |
| FLUX.3 Image Klein | new images | Black Forest Labs' guides ([prompting](https://runware.ai/docs/models/bfl-flux-3-image-klein/guides/prompting), [text](https://runware.ai/docs/models/bfl-flux-3-image-klein/guides/text-rendering)) |
| Krea 2 Turbo | new images | Krea's [prompting guide and expansion prompt](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md) |
| Fibo 2.0 Dev and Edit Turbo | new images, as Bria's structured JSON caption | Bria's [prompt-to-JSON instructions](https://huggingface.co/briaai/FIBO-gemini-prompt-to-JSON) |
| MOSS-Image SFT | new images | OpenMOSS's [user guide](https://github.com/OpenMOSS/MOSS-Image/blob/master/USERGUIDE.md) and prompt-enhancer skill |

Qwen-Image 2.1 keeps Kokon's general instructions: they were written and A/B-tested for it and already
follow Qwen's own [prompt rewriter](https://github.com/QwenLM/Qwen-Image-2.1/tree/main/prompt_rewrite)
(the medium first, the light stated, exact text in quotes; edits lead with the operation, describe only
what changes and keep the rest in one sentence).

## What's different from Kokon

- **More models**, with a model menu in the top bar that shows the model in use, switches and
  loads a model at once, and downloads one that is not there yet.
- **Edits where the model can do them.** Qwen-Image 2.1, FLUX.3 and Fibo 2.0 edit photos and combine images;
  with Krea 2 and MOSS-Image, Kokon Modal offers what they do (new images, brushed changes, Expand)
  and says so instead of failing.
- **LoRAs per model.** Each LoRA is loaded for the model in use and only used with it; the LoRA
  button next to the prompt lists the LoRAs of that model, and each model keeps its own choice per
  project. This works for every model; LoRAs for FLUX.3, Fibo 2.0, Krea 2 and MOSS-Image are not
  tested yet (FLUX.3 and Fibo use LoRAs trained on their base models, Krea 2 on Krea 2 Raw).
- **Prompt+ with FLUX.3 and Krea 2.** Their Qwen3-VL 4B text encoder ties its output layer to its
  embeddings, so its GGUF has no LM head and the engine could not write with it. Kokon Modal writes
  a copy with the head added once (about 4.7 GB, next to the downloaded file, which stays as it
  is) and runs Prompt+ on it. The engine shows input images to the text encoder of Qwen-Image 2.1
  and Fibo 2.0 only, so with FLUX.3 and Krea 2 Prompt+ rewrites edits and combinations from your
  words alone, with instructions written for that.
- **Layout for new images.** The **Layout** button next to the aspect ratio opens a canvas in the
  shape of the new image: draw rectangles, outlines point by point (like a polygonal lasso: the
  area closes on the first point) or freehand, and write in each what goes there; the prompt describes
  the scene. Outlines are drawn as their shape in the sketch; FLUX.3, Krea 2 and MOSS-Image use
  the box around them. FLUX.3 reads the boxes natively (its `bbox` caption format); Qwen-Image 2.1 and Fibo 2.0
  Dev get the drawing as a reference image to follow as a plan; Krea 2 and MOSS-Image get the
  positions in words (approximate). Prompt+ writes the scene first, then the boxes are added.
- **Areas when editing a photo.** Next to Kokon's Colours, Paint area's One area has Rectangle,
  Outline and Freehand beside the brush and Select: each area is changed, as its own text says (or as the prompt says, if it has none). Qwen-Image 2.1
  changes all areas at once (each marked in its own color in its guide image); FLUX.3, Fibo 2.0,
  Krea 2 and MOSS-Image paint one area per pass, each pass starting from the one before.
- **Kokon's new features with every model where they can work.** Colours in Paint area needs a
  model that sees the photo (Qwen-Image 2.1, FLUX.3, Fibo 2.0); with Krea 2 and MOSS-Image it is
  switched off and One area is used. The Layers lab and More like this are Kokon's and tried with
  Qwen-Image 2.1 only.
- **A second GPU.** With several graphics cards, Settings → Performance → Second GPU runs the text
  encoder and the image decoder on another card (`--backend diffusion=cuda0,vae=cuda1,te=cuda1`):
  faster prompts and Prompt+, and the first card for the image model alone. One image still runs
  on one card.
- **Its own app next to Kokon.** Kokon Modal has its own name, app id (`app.kokonmodal.desktop`),
  install folder, settings (`%APPDATA%\Kokon Modal`), data and models (`%LOCALAPPDATA%\KokonModalData`),
  output folder (`Pictures\Kokon Modal`) and ports (39160-39162; Kokon uses 39150-39152). Both apps
  can be installed and run at the same time, and neither touches the other's files or processes.
- **Updates from this repository.** Kokon Modal checks this fork once a day (Settings → General can
  turn it off or check now) and installs a new version in one click; updates are signed with the
  fork's own key. Every release has its own, higher version: Kokon's version with a build number (`0.12.1024` =
  Kokon 0.12.1, build 24).
- Small fixes: the setup's file list no longer garbles rows waiting to download.

## Install

1. Download from the [latest release](https://github.com/sebmue78/kokon-modal/releases/latest)
   (the SHA-256 is in the notes):
   - **Windows:** `Kokon-modal_<version>_x64-setup.exe`. The installer is not code-signed:
     Windows SmartScreen may ask once (**More info → Run anyway**).
   - **Mac (Apple Silicon, macOS 15+):** `Kokon-modal_<version>_aarch64.dmg`. Open it and drag
     Kokon Modal to Applications. The app is not notarized by Apple: the first time, open System
     Settings → Privacy & Security and click **Open Anyway** (or run
     `xattr -dr com.apple.quarantine "/Applications/Kokon Modal.app"`).
2. Both update themselves from then on (Settings → General).
3. On first start, Setup checks your GPU and downloads the engine and Qwen-Image 2.1.
   Already have Kokon's model files? **Use models I already have** can point Kokon Modal at them
   (in `%LOCALAPPDATA%\KokonData\sdcpp\models\qwen21`) instead of downloading them again.
4. Choose FLUX.3, Fibo 2.0, Krea 2 or MOSS-Image in the model menu at the top when you want them.

**Requirements** are Kokon's: Windows 10/11 64-bit, an NVIDIA card with 12 GB of VRAM (8 GB in
beta) or AMD/Intel through Vulkan (beta), 16 GB of RAM (32 GB recommended), and an SSD with room
for the models you use. Krea 2 is the largest model; 24 GB of VRAM gets the 8-bit files of every
model. On a Mac, Kokon's requirements apply (M1 or newer, 16 GB of unified memory, 32 GB
recommended); the new models have not been tried on a Mac yet. Linux builds work as in Kokon but
are not built for this fork yet.

## Build from source

Kokon Modal builds like Kokon: see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
In short:

```bash
npm install
cargo test -p qls-core -p qls-service   # core and service, no GPU needed
npm test                                # UI logic
npx tauri dev                           # run the app (Windows)
```

The release is built by [`.github/workflows/alpha-windows.yml`](.github/workflows/alpha-windows.yml)
on every push to the `release` branch: on Windows the tests, the service, the MCP server, the app and
the NSIS installer; on macOS 26 (Apple Silicon) the service, Kokon's Mac engine, the MCP server, the app
and the disk image; then the release `v<version>` with both. With the repository secret
`TAURI_SIGNING_PRIVATE_KEY` (the fork's updater key; its public half is in `src-tauri/tauri.conf.json`)
both builds are signed for the updater and `latest.json` goes to the release `updates`, the address
the app checks. Without the secret the build works the same, without an update. The release notes
start with `.github/release-notes.md` (what's new, written for each release) and the commits since the
previous release.

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
| MCP server for agents | `mcp/src/tools.ts`, `mcp/src/index.ts`, `src/components/AiAgents.tsx` |
| Layout, areas in Paint area | `crates/qls-core/src/layout.rs`, `src/lib/layout.ts`, `src/components/AreaLayer.tsx`, `LayoutEditor.tsx`, `InpaintEditor.tsx` |
| Tests | `crates/qls-core/src/krea2_tests.rs`, `moss_tests.rs`, `flux3_tests.rs`, `fibo2_tests.rs` |

## AI agents (MCP)

Kokon Modal comes with its own MCP server, `kokon-mcp`, installed next to the app. Claude Code,
Claude Desktop, Cursor and other MCP clients can then make and edit images here: new images (with a
Layout), edits, combining images, inpainting with a mask or with areas, outpainting, upscaling,
listing and switching the models, and the LoRAs of each model. **Settings → AI agents** shows the
path and a ready-made configuration. For Claude Code:

```bash
# Windows
claude mcp add --scope user kokon-modal -- "%LOCALAPPDATA%\Kokon Modal\kokon-mcp.exe"
# Mac
claude mcp add --scope user kokon-modal -- "/Applications/Kokon Modal.app/Contents/MacOS/kokon-mcp"
```

Don't use `npx kokon-mcp`: that package talks to the original Kokon. [mcp/README.md](mcp/README.md)
lists the tools.

## Everything else

Kokon Modal keeps all of Kokon's features: brushed edits, Expand, the upscalers, LUTs, private
mode, other devices in a browser and the HTTP API (they use Kokon Modal's own service and data
folder). They are described in
[Kokon's README](https://github.com/GabrieleLozupone/kokon#readme) and in [docs/](docs/).

Every image Kokon makes or changes with AI is marked as such, as the EU AI Act asks: in the file's
metadata (IPTC Digital Source Type) and with an invisible watermark ([TrustMark](https://github.com/adobe/trustmark),
the text `Kokon-AI`) that survives JPEG, resizing and screenshots. Please don't remove these
marks. If you publish a realistic image of real people, places or events, say that it was made
or changed with AI. Settings → General → **Check an image** reads the marks of any image;
[docs/ai-marking.md](docs/ai-marking.md) has the details.

## License

Kokon Modal is a modified version of Kokon and, like Kokon, is licensed under the
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only); see [NOTICE](NOTICE) for the
third-party code. Changes in this fork are marked "Fork:" in the code and listed in the git history.

The models are not part of this repository. Each is downloaded from Hugging Face under its own
license, which you accept when you download it; read it on the model's page before using images
commercially.
