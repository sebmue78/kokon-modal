- **Fix (Mac): the MCP server for AI agents did not start.** On a Mac, `kokon-mcp` crashed right
  away ("trace trap"), so Claude and other agents could not connect to Kokon Modal. The app's
  programs were signed with Apple's hardened runtime. That blocks the code compilation Node.js
  needs, and `kokon-mcp` is built on Node.js. The Mac build no longer turns the hardened runtime on.
  The app is signed ad hoc and not notarized, so it had no benefit there. Windows was not affected.
- The Mac build now starts `kokon-mcp` once to check it, so this cannot slip through again.
