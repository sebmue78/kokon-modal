- **New: AI agents can use Kokon Modal (MCP).** Kokon Modal now comes with its own MCP server,
  `kokon-mcp`, installed next to the app. Claude Code, Claude Desktop, Cursor and other agents can
  make and edit images here, on your computer, also while the app is closed.
  - **Settings → AI agents** shows where it is and copies the setup: a `claude mcp add` command for
    Claude Code and the JSON for the other apps.
  - Agents can make new images (also with a **Layout**: areas that say where things go), edit,
    combine images, outpaint, upscale, and change parts of a photo with a mask or with **areas**
    (each with its own text, like Paint area in the app).
  - New tools: **list_models** and **select_model** (switch the model in use, the same choice as the
    model menu; a model is only downloaded when the agent is told to), **list_loras** (and a `loras`
    option on the image tools, for the LoRAs of the model in use).
  - The tool descriptions no longer say every image is made with Qwen; the server is called
    `kokon-modal`.
  - Don't use `npx kokon-mcp`: that package belongs to the original Kokon.
- Changing areas without a painted mask: when areas are sent without a mask (as agents do), the
  areas themselves are now the mask. In the app nothing changes.
- The service's status now says where `kokon-mcp` is.
