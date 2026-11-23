import { FastMCP } from "fastmcp";
import { withStructuredErrors } from "./errors.js";
import { registerResourceTools } from "./tools/resources.js";

const server = withStructuredErrors(
  new FastMCP({
    name: "atlassian-ai-toolkit",
    version: "0.10.0",
  })
);

// Register tool groups
registerResourceTools(server);

// Start the server in stdio mode (for Claude Desktop, Cursor, etc.)
server.start({
  transportType: "stdio",
});
