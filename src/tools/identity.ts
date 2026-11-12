import type { InfoResponse, WhoAmI } from "../core/api-types.js";
import { keyValues } from "../core/format.js";
import { defineTool } from "../core/tool.js";

const ALL = ["admin", "tenant", "corpus"] as const;

export const whoamiTool = defineTool({
	name: "whoami",
	title: "Who am I",
	description: "Show which kind of key is in use (admin, tenant or corpus) and which tenant and corpus it reaches.",
	group: "",
	command: "whoami",
	kinds: ALL,
	access: "read",
	input: {},
	handler: async (_input, ctx) => ctx.client.whoami(),
	render: (data) =>
		keyValues(data, ["kind", "tenant_name", "tenant_id", "corpus_name", "corpus_id"] satisfies Array<keyof WhoAmI>),
});

/** Nested objects as dotted keys, lists joined with commas, for one flat key/value listing. */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
	} else {
		out[prefix] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

export const getEngineInfoTool = defineTool({
	name: "get_engine_info",
	title: "Engine info",
	description:
		"Show the engine's version, which features are on (streaming, transcription, reranking, web search, Content " +
		"Portal), its embedding and LLM models and whether it holds its own LLM key, its public URL, and its limits " +
		"(upload size, accepted file types, records per import, question length). No secrets.",
	group: "",
	command: "info",
	kinds: ALL,
	access: "read",
	input: {},
	handler: async (_input, ctx) => ctx.client.get<InfoResponse>("/api/v1/info"),
	render: (data) => {
		const flat = flatten(data);
		// Long lists (every accepted MIME type) would be cut at 100 characters in a table cell.
		const lines = Object.entries(flat).map(([key, value]) => [key, value === null ? "-" : String(value)] as const);
		const width = Math.max(...lines.map(([key]) => key.length));
		return lines.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
	},
});
