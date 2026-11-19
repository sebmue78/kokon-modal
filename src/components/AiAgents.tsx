// Fork: Settings → AI agents. Kokon Modal comes with kokon-mcp, an MCP server through which
// Claude Code, Claude Desktop, Cursor and other agents make and edit images here.
import { Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toastError, toastInfo, useStore } from "../lib/store";
import { mcpCommand, mcpJson } from "../lib/agents";

function CopyBox(props: { title: string; help: string; text: string; copied: string }) {
  return (
    <div className="setting-card" style={{ alignItems: "flex-start", flexDirection: "column" }}>
      <div className="setting-card-text">
        <strong>{props.title}</strong>
        <span className="muted">{props.help}</span>
      </div>
      <pre className="agent-config">{props.text}</pre>
      <button className="btn" onClick={() => writeText(props.text).then(() => toastInfo(props.copied), toastError)}>
        <Copy size={14} /> Copy
      </button>
    </div>
  );
}

export function AiAgents() {
  const path = useStore((s) => s.status?.mcp_exe ?? null);
  return (
    <>
      <span className="muted">
        AI agents such as Claude Code, Claude Desktop or Cursor can make and edit images with Kokon Modal through its MCP server: new images (with a Layout), edits, combining images,
        areas, outpainting, upscaling, choosing the model and its LoRAs. Everything runs on this computer, also while the app is closed. Agents read and write images only in their
        project folder.
      </span>
      {!path ? (
        <span className="muted">The MCP server (kokon-mcp) was not found next to Kokon Modal. Install the latest release, then open this page again.</span>
      ) : (
        <>
          <CopyBox
            title="Claude Code"
            help="Run this once in a terminal. Every Claude Code project can then use Kokon Modal."
            text={mcpCommand(path)}
            copied="Command copied"
          />
          <CopyBox
            title="Claude Desktop, Cursor and others"
            help="Add this to the app's MCP configuration (Claude Desktop: Settings → Developer → Edit Config; Cursor: .cursor/mcp.json)."
            text={mcpJson(path)}
            copied="Configuration copied"
          />
          <span className="muted">
            The original Kokon's npm package (npx kokon-mcp) talks to the original Kokon app, not to Kokon Modal: use the file above.
          </span>
        </>
      )}
    </>
  );
}
