/**
 * MCP client integration (`src/mcp/`): the official SDK
 * (`@modelcontextprotocol/sdk`) owns the protocol + streamable-http transport;
 * this module owns the integration policy — short-session never-throw facade,
 * X-Uid per operation, error routing, observability — and the dynamic tool
 * bridge (tools/list → ToolDefinition, server-owned schemas verbatim).
 */

export * from "./client.js";
export * from "./tools.js";
