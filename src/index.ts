/**
 * Programmatic API: the engine client, the tool definitions and the MCP server factory, for
 * anyone embedding cob-rag-mcp in their own process.
 */

export type * from "./core/api-types.js";
export { EngineClient, type EngineClientOptions, type LlmSettings } from "./core/client.js";
export { loadConfig, maskSecret, type ResolvedConfig } from "./core/config.js";
export { CobRagError, type ErrorCode } from "./core/errors.js";
export type { Access, AnyTool, ToolContext, ToolDefinition } from "./core/tool.js";
export { visibleTools } from "./core/visibility.js";
export { createMcpServer } from "./server/create-server.js";
export { startHttpServer } from "./server/http.js";
export { startStdio } from "./server/stdio.js";
export { ALL_TOOLS } from "./tools/index.js";
export { VERSION } from "./version.js";
