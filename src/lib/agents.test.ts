import { describe, expect, it } from "vitest";
import { mcpCommand, mcpJson } from "./agents";

describe("AI agents config", () => {
  const win = "C:\\Users\\Seb\\AppData\\Local\\Kokon Modal\\kokon-mcp.exe";
  it("quotes the path for Claude Code", () => {
    expect(mcpCommand(win)).toBe(`claude mcp add --scope user kokon-modal -- "${win}"`);
  });
  it("writes valid JSON with the path escaped", () => {
    expect(JSON.parse(mcpJson(win)).mcpServers["kokon-modal"].command).toBe(win);
    expect(mcpJson(win)).toContain("\\\\Kokon Modal\\\\");
  });
});
