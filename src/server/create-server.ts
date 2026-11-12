/**
 * Build an McpServer for one engine key. The key's kind (from /whoami) decides which tools are
 * registered, so a client never sees a tool its key cannot use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WhoAmI } from "../core/api-types.js";
import type { EngineClient } from "../core/client.js";
import type { ResolvedConfig } from "../core/config.js";
import { toCobRagError } from "../core/errors.js";
import type { AnyTool, ToolContext } from "../core/tool.js";
import { inputShapeFor, visibleTools } from "../core/visibility.js";
import { ALL_TOOLS } from "../tools/index.js";
import { VERSION } from "../version.js";

export interface CreateServerOptions {
	client: EngineClient;
	config: ResolvedConfig;
	identity: WhoAmI;
	transport: "stdio" | "http";
	tools?: readonly AnyTool[];
}

export interface CreatedServer {
	server: McpServer;
	tools: AnyTool[];
}

function describeKey(identity: WhoAmI): string {
	if (identity.kind === "admin") return "the engine's admin key (every tenant and corpus)";
	const permission = identity.permission ? ` (a ${identity.permission}-permission key)` : "";
	if (identity.kind === "tenant") {
		return `tenant "${identity.tenant_name ?? identity.tenant_id}" and its corpora${permission}`;
	}
	return `the knowledge base "${identity.corpus_name ?? identity.corpus_id}"${permission}`;
}

export function createMcpServer(options: CreateServerOptions): CreatedServer {
	const { client, config, identity, transport } = options;
	const server = new McpServer(
		{ name: "cob-rag-mcp", version: VERSION },
		{
			instructions:
				`This server connects to a self-hosted cob-rag-engine using ${describeKey(identity)}. ` +
				"Use `search` to find passages from the business's own documents and answer from them, citing the " +
				"sources; use `ask` for an answer written by the engine's own model.",
		},
	);

	const tools = visibleTools(options.tools ?? ALL_TOOLS, {
		kind: identity.kind,
		transport,
		allowDestructive: config.allowDestructive,
		readOnly: config.readOnly,
		permission: identity.permission,
		uploadDir: config.uploadDir,
	});

	const ctx: ToolContext = { client, config, surface: transport, identity };

	for (const tool of tools) {
		const shape = inputShapeFor(tool, identity.kind);
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: shape,
				annotations: {
					title: tool.title,
					readOnlyHint: tool.access === "read",
					destructiveHint: tool.access === "destructive",
					idempotentHint: tool.access === "read",
					// Every call goes to the user's own engine, not the open internet.
					openWorldHint: false,
				},
			},
			async (args: Record<string, unknown>): Promise<CallToolResult> => {
				try {
					// The SDK has already validated args against `shape`; parse again with the full schema
					// so defaults and transforms apply exactly as in the CLI.
					const input = z
						.object(shape)
						.strict()
						.parse(args ?? {});
					const data = await tool.handler(input, ctx);
					return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
				} catch (err) {
					const e = toCobRagError(err);
					return {
						isError: true,
						content: [{ type: "text", text: `${e.code}: ${e.message}` }],
					};
				}
			},
		);
	}

	if (tools.some((t) => t.name === "search")) registerAnswerPrompt(server);

	return { server, tools };
}

function registerAnswerPrompt(server: McpServer): void {
	server.registerPrompt(
		"answer-with-citations",
		{
			title: "Answer with citations",
			description: "Answer a question from the knowledge base only, citing every source used.",
			argsSchema: { question: z.string().describe("The question to answer.") },
		},
		({ question }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text:
							"Answer the question below using only the knowledge base.\n\n" +
							"1. Call the `search` tool with the question (and again with rephrased queries if the first results " +
							"do not cover it).\n" +
							"2. Answer only from the passages returned. If they do not contain the answer, say so plainly; " +
							"do not fill gaps from general knowledge.\n" +
							"3. Cite each claim with a bracketed number, and end with a Sources list giving each number's " +
							"file name or record id and section.\n\n" +
							`Question: ${question}`,
					},
				},
			],
		}),
	);
}
