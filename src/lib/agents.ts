// Fork: the MCP configuration Settings → AI agents shows for the bundled kokon-mcp.

/** `claude mcp add` for Claude Code, with the path quoted for the shell. */
export function mcpCommand(exe: string): string {
  return `claude mcp add --scope user kokon-modal -- "${exe}"`;
}

/** The `mcpServers` entry most MCP clients read (Claude Desktop, Cursor, ...). */
export function mcpJson(exe: string): string {
  return JSON.stringify({ mcpServers: { "kokon-modal": { command: exe, args: [] } } }, null, 2);
}
