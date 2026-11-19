- **Fix: Claude could not use "generate_image" and "inpaint_image".** Claude rejected these two MCP
  tools: the outline points of areas were described as a JSON-schema tuple, and Claude does not
  accept that format. The other tools worked. The points are now a list of [x, y] pairs in a format
  every client accepts. What agents send does not change.
- A test now makes sure no tool uses that format again.
