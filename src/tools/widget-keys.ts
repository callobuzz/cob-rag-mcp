import { z } from "zod";
import type { CreateWidgetKeyRequest, WidgetKeyResponse } from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues, table } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";
import { compact, uuid, widgetAppearanceSchema } from "./schemas.js";

// Widget keys (pk_) are publishable keys for the website chat widget. The engine scopes these
// routes like every other: a corpus key reaches its own corpus, a tenant key its corpora, admin all.
const ALL = ["admin", "tenant", "corpus"] as const;

async function corpusPath(given: string | undefined, ctx: Parameters<typeof resolveCorpusId>[1]): Promise<string> {
	const id = await resolveCorpusId(given, ctx, { required: true });
	return `/api/v1/corpora/${seg(id as string)}/widget-keys`;
}

export const listWidgetKeysTool = defineTool({
	name: "list_widget_keys",
	title: "List widget keys",
	description: "List a corpus's website widget keys (pk_) with their allowed sites and limits.",
	group: "widget-keys",
	command: "list",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: { corpus_id: corpusIdInput },
	handler: async (input, ctx) => ctx.client.get<WidgetKeyResponse[]>(await corpusPath(input.corpus_id, ctx)),
	render: (data) =>
		table(data as WidgetKeyResponse[], [
			{ key: "id" },
			{ key: "name", max: 30 },
			{ key: "public_key", max: 30 },
			{ key: "allowed_origins", label: "sites", max: 40 },
			{ key: "rate_limit_per_minute", label: "per min" },
			{ key: "daily_message_limit", label: "per day" },
			{ key: "is_active", label: "active" },
		]),
});

export const createWidgetKeyTool = defineTool({
	name: "create_widget_key",
	title: "Create a widget key",
	description:
		"Create a publishable widget key (pk_) for the website chat widget, locked to the given sites, and get the " +
		"embed snippet to paste before </body>.",
	group: "widget-keys",
	command: "create",
	kinds: ALL,
	access: "write",
	positional: ["name"],
	corpusScoped: true,
	input: {
		name: z.string().min(1).max(255).describe("e.g. 'Acme website'."),
		allowed_origins: z
			.array(z.string())
			.min(1)
			.max(50)
			.describe("Sites allowed to use the key, e.g. ['https://acme.com']. '*' allows any."),
		corpus_id: corpusIdInput,
		rate_limit_per_minute: z.number().int().min(1).max(600).optional().describe("Per visitor (default 10)."),
		daily_message_limit: z
			.number()
			.int()
			.min(0)
			.max(10_000_000)
			.optional()
			.describe("Per key per day, 0 = unlimited (default 1000)."),
		appearance: widgetAppearanceSchema.optional(),
	},
	handler: async (input, ctx) => {
		const body: CreateWidgetKeyRequest = {
			name: input.name,
			allowed_origins: input.allowed_origins,
			...compact({
				rate_limit_per_minute: input.rate_limit_per_minute,
				daily_message_limit: input.daily_message_limit,
				appearance: input.appearance,
			}),
		};
		return ctx.client.request<WidgetKeyResponse>("POST", await corpusPath(input.corpus_id, ctx), { body });
	},
	render: (data) => {
		const key = data as WidgetKeyResponse;
		return `${keyValues(key, ["id", "name", "public_key", "allowed_origins", "rate_limit_per_minute", "daily_message_limit"])}\n\nEmbed snippet:\n${key.embed_snippet}`;
	},
});

export const revokeWidgetKeyTool = defineTool({
	name: "revoke_widget_key",
	title: "Revoke a widget key",
	description: "Delete a widget key. Every website using it stops getting answers immediately.",
	group: "widget-keys",
	command: "revoke",
	kinds: ALL,
	access: "destructive",
	positional: ["key_id"],
	corpusScoped: true,
	input: {
		key_id: uuid("Widget key id (the id, not the pk_ value)."),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) => {
		await ctx.client.request("DELETE", `${await corpusPath(input.corpus_id, ctx)}/${seg(input.key_id)}`);
		return { revoked: true, key_id: input.key_id };
	},
});
