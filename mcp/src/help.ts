// Text printed by `kokon-mcp --help`. Kept apart from index.ts so it can be tested without
// starting the server. The environment variables listed here are read in paths.ts,
// service.ts and index.ts; update this text when one is added or renamed.

export function helpText(version: string): string {
  return `kokon-mcp ${version}

MCP server for Kokon Modal. It speaks the Model Context Protocol over stdio, so an MCP client
(Claude Code, Cursor, Claude Desktop...) starts it; running it by hand just waits for input.
It comes with the Kokon Modal app (next to kokon-service) and starts the local engine on demand.
Settings → AI agents in the app shows this file's path and a ready-made config.

Usage:
  kokon-mcp             start the MCP server on stdio
  kokon-mcp --version   print the version and exit
  kokon-mcp --help      print this text and exit

Register it with Claude Code:
  Windows: claude mcp add --scope user kokon-modal -- "%LOCALAPPDATA%\\Kokon Modal\\kokon-mcp.exe"
  Mac:     claude mcp add --scope user kokon-modal -- "/Applications/Kokon Modal.app/Contents/MacOS/kokon-mcp"

Environment variables:
  QLS_MCP_ALLOWED_DIRS  extra folders the tools may read and write, separated by semicolons
  QLS_SERVICE_EXE       path to kokon-service, if Kokon Modal is installed in an unusual place
  QLS_DATA_DIR          Kokon Modal's data folder (default: the app's KokonModalData folder)
  CLAUDE_PROJECT_DIR    project folder the tools may use (set by Claude Code; default: the
                        working directory)
`;
}
