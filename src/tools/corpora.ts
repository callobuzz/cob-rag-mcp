import { z } from "zod";
import type {
	CorpusDetailResponse,
	CorpusListResponse,
	CreateCorpusRequest,
	CreateCorpusResponse,
	DeletePreviewResponse,
	RotateKeyResponse,
	UpdateCorpusRequest,
} from "../core/api-types.js";
import { seg } from "../core/client.js";
import { CobRagError } from "../core/errors.js";
import { keyValues, pageFooter, renderPreview, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import {
	CLEARING_RULES,
	compact,
	embeddingConfigSchema,
	llmConfigSchema,
	llmConfigUpdateSchema,
	promptConfigSchema,
	promptConfigUpdateSchema,
	retrievalConfigSchema,
	retrievalConfigUpdateSchema,
	uuid,
} from "./schemas.js";

// Corpus management answers tenant keys (their own corpora) and the admin key (all of them).
const MANAGERS = ["admin", "tenant"] as const;

const corpusId = uuid("Corpus id (from list_corpora).");

const KEY_ONCE = "The new key is shown only in this response: store it now.";

/** The engine's largest page for GET /api/v1/corpora. */
export const MAX_CORPORA_PAGE = 500;

export const listCorporaTool = defineTool({
	name: "list_corpora",
	title: "List corpora",
	description:
		"List knowledge bases (corpora) with their owner, document and chunk counts and last activity: a tenant key " +
		"sees its own, the admin key sees all. Paged: `count` is the corpora on this page, `total` all that match; " +
		"use offset for the next page, or all: true to fetch every page.",
	group: "corpora",
	command: "list",
	kinds: MANAGERS,
	access: "read",
	input: {
		tenant_id: uuid("Only this tenant's corpora. A tenant key may name only itself.").optional(),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_CORPORA_PAGE)
			.optional()
			.describe(`Page size (default 100, at most ${MAX_CORPORA_PAGE}).`),
		all: z.boolean().optional().describe("Fetch every page from offset on and return them as one list."),
	},
	handler: async (input, ctx) => {
		const page = (offset: number | undefined, limit: number | undefined) =>
			ctx.client.get<CorpusListResponse>("/api/v1/corpora", { tenant_id: input.tenant_id, offset, limit });
		if (!input.all) return page(input.offset, input.limit);

		const start = input.offset ?? 0;
		const limit = input.limit ?? MAX_CORPORA_PAGE;
		const items: CorpusListResponse["items"] = [];
		let total = 0;
		for (;;) {
			const res = await page(start + items.length, limit);
			items.push(...res.items);
			total = res.total ?? items.length;
			if (res.items.length === 0 || start + items.length >= total) break;
		}
		return { items, count: items.length, total, offset: start, limit: items.length } satisfies CorpusListResponse;
	},
	render: (data) => {
		const res = data as CorpusListResponse;
		return `${table(res.items, [
			{ key: "id" },
			{ key: "name", max: 30 },
			{ key: "tenant_name", label: "tenant", max: 24 },
			{ key: "document_count", label: "docs" },
			{ key: "chunk_count", label: "chunks" },
			{ key: "last_activity_at", label: "last activity" },
			{ key: "created_at" },
		])}\n\n${pageFooter("corpora", { count: res.items.length, total: res.total, offset: res.offset }, "--offset", "--all")}`;
	},
});

export const getCorpusTool = defineTool({
	name: "get_corpus",
	title: "Get a corpus",
	description: "Get one corpus with its model, prompt, retrieval and embedding settings (keys redacted).",
	group: "corpora",
	command: "get",
	kinds: MANAGERS,
	access: "read",
	positional: ["corpus_id"],
	input: { corpus_id: corpusId },
	handler: async (input, ctx) => ctx.client.get<CorpusDetailResponse>(`/api/v1/corpora/${seg(input.corpus_id)}`),
	render: (data) => JSON.stringify(data, null, 2),
});

export const createCorpusTool = defineTool({
	name: "create_corpus",
	title: "Create a corpus",
	description:
		"Create a knowledge base (corpus) with its own vector collection and corpus key (ck_). " +
		`The response holds the corpus key. ${KEY_ONCE}`,
	group: "corpora",
	command: "create",
	kinds: MANAGERS,
	access: "write",
	positional: ["name"],
	input: {
		name: z.string().min(1).max(255).describe("Corpus name."),
		description: z.string().optional(),
		tenant_id: uuid(
			"Required with the admin key: the tenant that owns the corpus (every knowledge base belongs to one). " +
				"A tenant key creates corpora for itself and may omit it.",
		).optional(),
		llm_config: llmConfigSchema.optional().describe("Model for answers; the API key is encrypted at rest."),
		prompt_config: promptConfigSchema.optional(),
		retrieval_config: retrievalConfigSchema.optional(),
		embedding_config: embeddingConfigSchema
			.optional()
			.describe("Embedding model from the engine's catalog; the collection is built for it, no migration needed."),
	},
	handler: async (input, ctx) => {
		const body: CreateCorpusRequest = {
			name: input.name,
			...compact({
				description: input.description,
				tenant_id: input.tenant_id,
				llm_config: input.llm_config,
				prompt_config: input.prompt_config,
				retrieval_config: input.retrieval_config,
				embedding_config: input.embedding_config,
			}),
		};
		return ctx.client.request<CreateCorpusResponse>("POST", "/api/v1/corpora", { body });
	},
	render: (data) => `${keyValues(data, ["id", "name", "api_key", "qdrant_collection", "created_at"])}\n\n${KEY_ONCE}`,
});

export const updateCorpusTool = defineTool({
	name: "update_corpus",
	title: "Update a corpus",
	description:
		"Change a corpus's name, description, model, prompt, retrieval or embedding settings, or (admin key) move it to another tenant. Only the fields you send change. " +
		`${CLEARING_RULES} ` +
		"Changing embedding_config starts an embedding migration in the engine.",
	group: "corpora",
	command: "update",
	kinds: MANAGERS,
	access: "write",
	positional: ["corpus_id"],
	input: {
		corpus_id: corpusId,
		name: z.string().min(1).max(255).optional(),
		description: z.string().nullable().optional().describe("null clears the description."),
		llm_config: llmConfigUpdateSchema
			.nullable()
			.optional()
			.describe("Model for answers. api_key: null deletes the stored key; the whole object as null resets it."),
		prompt_config: promptConfigUpdateSchema.nullable().optional(),
		retrieval_config: retrievalConfigUpdateSchema.nullable().optional(),
		embedding_config: embeddingConfigSchema.optional(),
		tenant_id: uuid(
			"Admin key only: move the corpus to this tenant (its corpus limit applies). A corpus always has a tenant.",
		).optional(),
	},
	handler: async (input, ctx) => {
		const { corpus_id, ...fields } = input;
		const body: UpdateCorpusRequest = compact(fields);
		if (Object.keys(body).length === 0) throw new CobRagError("Nothing to update: pass at least one field.", "USAGE");
		return ctx.client.request<CorpusDetailResponse>("PUT", `/api/v1/corpora/${seg(corpus_id)}`, { body });
	},
	render: (data) => JSON.stringify(data, null, 2),
});

export const rotateCorpusKeyTool = defineTool({
	name: "rotate_corpus_key",
	title: "Rotate a corpus key",
	description:
		"Issue a new corpus key (ck_). The old key stops working immediately, breaking anything still using it. " +
		KEY_ONCE,
	group: "corpora",
	command: "rotate-key",
	kinds: MANAGERS,
	access: "destructive",
	positional: ["corpus_id"],
	input: { corpus_id: corpusId },
	handler: async (input, ctx) =>
		ctx.client.request<RotateKeyResponse>("POST", `/api/v1/corpora/${seg(input.corpus_id)}/rotate-key`),
	render: (data) => `${keyValues(data)}\n\n${KEY_ONCE}`,
});

const confirmCorpusName = z
	.string()
	.min(1)
	.max(255)
	.describe(
		"The knowledge base's exact name (from get_corpus or preview_delete_corpus): the engine refuses anything else.",
	);

export const previewDeleteCorpusTool = defineTool({
	name: "preview_delete_corpus",
	title: "Preview deleting a corpus",
	description:
		"Dry run: what deleting a corpus would remove (documents, chunks, widget keys, conversations, memories) and the " +
		"exact name to pass as confirm_name to delete_corpus. Changes nothing.",
	group: "corpora",
	command: "delete-preview",
	kinds: MANAGERS,
	access: "read",
	positional: ["corpus_id"],
	input: { corpus_id: corpusId },
	handler: async (input, ctx) =>
		ctx.client.get<DeletePreviewResponse>(`/api/v1/corpora/${seg(input.corpus_id)}/delete-preview`),
	render: (data) => renderPreview(data as DeletePreviewResponse),
});

export const deleteCorpusTool = defineTool({
	name: "delete_corpus",
	title: "Delete a corpus",
	description:
		"Permanently delete a corpus with every document, vector, widget key and usage record in it. Cannot be undone. " +
		"Needs confirm_name, the knowledge base's exact name; run preview_delete_corpus first to see what would go.",
	group: "corpora",
	command: "delete",
	kinds: MANAGERS,
	access: "destructive",
	positional: ["corpus_id", "confirm_name"],
	input: { corpus_id: corpusId, confirm_name: confirmCorpusName },
	handler: async (input, ctx) => {
		await ctx.client.request("DELETE", `/api/v1/corpora/${seg(input.corpus_id)}`, {
			query: { confirm_name: input.confirm_name },
		});
		return { deleted: true, corpus_id: input.corpus_id };
	},
});
