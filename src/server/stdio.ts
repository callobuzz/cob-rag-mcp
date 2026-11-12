import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineClient } from "../core/client.js";
import type { ResolvedConfig } from "../core/config.js";
import { CobRagError } from "../core/errors.js";
import { VERSION } from "../version.js";
import { createMcpServer } from "./create-server.js";

export const NO_KEY_MESSAGE =
	"No engine key configured. Set COB_RAG_API_KEY (a corpus ck_, tenant tk_ or admin key from your own " +
	"cob-rag-engine), or run `cob-rag-engine login --url <engine url> --key <key>`. There is no hosted service: " +
	"you point this package at the engine you run.";

/**
 * Start the MCP server on stdin/stdout. Everything human-readable goes to stderr, because stdout
 * belongs to the protocol.
 */
export async function startStdio(config: ResolvedConfig, fetchImpl?: typeof fetch): Promise<void> {
	if (!config.apiKey) throw new CobRagError(NO_KEY_MESSAGE, "CONFIG");
	const client = new EngineClient({
		url: config.url,
		apiKey: config.apiKey,
		llm: config.llm,
		userAgent: `cob-rag-mcp/${VERSION}`,
		fetch: fetchImpl,
	});
	// Fails fast, with a clear message, when the engine is down or the key is wrong: an MCP client
	// shows the server as failed rather than offering tools that can only error.
	const identity = await client.whoami();
	const { server, tools } = createMcpServer({ client, config, identity, transport: "stdio" });
	await server.connect(new StdioServerTransport());
	const who = identity.kind === "corpus" ? `corpus "${identity.corpus_name}"` : identity.kind;
	process.stderr.write(
		`cob-rag-mcp ${VERSION}: ${config.url} as ${who}; ${tools.length} tools` +
			`${config.readOnly ? " (read-only)" : ""}${config.allowDestructive ? " (destructive allowed)" : ""}\n`,
	);
}
