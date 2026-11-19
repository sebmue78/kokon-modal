# kokon-mcp (Kokon Modal)

MCP server for **Kokon Modal**, the fork of [Kokon](https://github.com/GabrieleLozupone/kokon) with
more models (FLUX.3 Klein, Fibo 2.0, Krea 2, MOSS-Image, Qwen-Image 2.1 in 16 bit), Layout, areas
and LoRAs per model. It lets Claude Code, Cursor, Claude Desktop and other MCP clients make and
edit images with them, offline on your own GPU. No API key, no cloud. Everything stays on `127.0.0.1`.

> **Comes with the Kokon Modal app.** The installer puts `kokon-mcp` next to the app; the app doesn't
> need to be open, the server starts the engine on demand. The npm package `kokon-mcp` belongs to
> the original Kokon and talks to that app, not to Kokon Modal.

## Setup

Settings → **AI agents** in the app shows the path and copies the configuration. By hand:

Claude Code:

```bash
# Windows
claude mcp add --scope user kokon-modal -- "%LOCALAPPDATA%\Kokon Modal\kokon-mcp.exe"
# Mac
claude mcp add --scope user kokon-modal -- "/Applications/Kokon Modal.app/Contents/MacOS/kokon-mcp"
```

Any client that takes the standard JSON config (`.mcp.json`, Claude Desktop, Cursor...):

```json
{
  "mcpServers": {
    "kokon-modal": {
      "type": "stdio",
      "command": "C:\\Users\\<you>\\AppData\\Local\\Kokon Modal\\kokon-mcp.exe",
      "args": []
    }
  }
}
```

Then ask: *"Generate a hero image for this README with FLUX.3 and save it in docs/"* or *"Replace the
car on the left of street.png with a bicycle"*. The first call takes about a minute while the model loads.

## Tools

Prompts are used exactly as your assistant writes them: Kokon's own prompt writer (Prompt+) does not
run for MCP, so the assistant writes the full description. The tool descriptions tell it how.

| Tool | What it does |
| --- | --- |
| `generate_image` | Text to image, optionally with up to 10 reference images in a new scene, or with **layout** areas that say where things go. Size chosen automatically, or set width/height or aspect ratio. |
| `edit_image` | Edit an image with an instruction. Keeps its size; never overwrites the input. |
| `edit_images` | Edit image 1 with the help of up to 9 more images ("image 1", "image 2"...). |
| `inpaint_image` | Change only part of an image, given as a mask or as **areas** (rectangles or outlines, each with what goes there): edit, remove, replace or add something. |
| `outpaint_image` | Extend an image beyond its borders. |
| `upscale_image` | Enlarge an image (default 2x, up to 8192 px). |
| `get_image_info` | Size, type and, for Kokon images, the prompt, seed and settings. |
| `get_generator_status` | Engine state, the model in use, GPU, VRAM, job queue and a running model download. |
| `list_models` | The models, what each can do, which are downloaded and which is in use. |
| `select_model` | Switch the model in use (the same choice as the app's model menu); downloads one only with `download: true`. |
| `list_loras` | The LoRAs added in the app, per model, with trigger words. `generate_image`, `edit_image(s)` and `inpaint_image` take their ids in `loras`. |

Areas and layout boxes use fractions of the image (0..1 from the top left): `{"x": 0.1, "y": 0.5,
"w": 0.3, "h": 0.4, "text": "a red vintage car"}`, optionally with `points` for an outline.

## Behavior and safety

- Every result returns the absolute path of the saved file, its size, seed and metadata.
- Reads and writes are limited to the project folder (`CLAUDE_PROJECT_DIR` or the working
  directory), Kokon's output folder and folders listed in `QLS_MCP_ALLOWED_DIRS` (separated by
  semicolons). Existing files are never overwritten.
- Images are not sent back to the model by default. Pass `include_preview: true` for a small JPEG.
- Progress is reported through MCP progress notifications.

## License

AGPL-3.0-only. The Qwen-Image 2.1 model weights the app downloads are under the Qwen Research
License (non-commercial). Source: [github.com/sebmue78/kokon-modal](https://github.com/sebmue78/kokon-modal/tree/master/mcp), based on [Kokon](https://github.com/GabrieleLozupone/kokon/tree/master/mcp).
