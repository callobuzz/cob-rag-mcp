import { z } from "zod";
import type {
	DeletePreviewResponse,
	DocumentDetailResponse,
	DocumentListResponse,
	VersionListResponse,
} from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues, pageFooter, renderPreview, table } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";
import { uuid } from "./schemas.js";

// The engine's /documents routes take the corpus from a corpus key, and from `?corpus_id=` for
// tenant keys (their own corpora) and the admin key (any). A corpus key never sends it.
const ALL = ["admin", "tenant", "corpus"] as const;

export const listDocumentsTool = defineTool({
	name: "list_documents",
	title: "List documents",
	description:
		"List the documents in a knowledge base, newest first, with their version counts, record ids and metadata. " +
		"`search` matches part of the file name or record id.",
	group: "documents",
	command: "list",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: {
		corpus_id: corpusIdInput,
		search: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe("Case-insensitive part of the file name or record id (% and _ are taken literally)."),
		limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
	},
	handler: async (input, ctx) => {
		const res = await ctx.client.get<DocumentListResponse>("/api/v1/documents", {
			corpus_id: await resolveCorpusId(input.corpus_id, ctx),
			search: input.search,
			limit: input.limit,
			offset: input.offset,
		});
		// The engine's `count` is every match across pages; say which page this is.
		return { ...res, offset: input.offset ?? 0 };
	},
	render: (data) => {
		const res = data as DocumentListResponse & { offset: number };
		return `${table(res.items, [
			{ key: "id" },
			{ key: "file_name", max: 40 },
			{ key: "external_id", label: "record id", max: 30 },
			{ key: "mime_type", max: 30 },
			{ key: "size_bytes", label: "bytes" },
			{ key: "version_count", label: "versions" },
			{ key: "ingested_at" },
		])}\n\n${pageFooter("document(s)", { count: res.items.length, total: res.count, offset: res.offset })}`;
	},
});

export const getDocumentTool = defineTool({
	name: "get_document",
	title: "Get a document",
	description:
		"Get one document with its versions and the chunks of its active version (or of `version_id`), as the engine " +
		"indexed them: text, section, page, token count. Chunks are paged with chunk_offset and chunk_limit.",
	group: "documents",
	command: "get",
	kinds: ALL,
	access: "read",
	positional: ["document_id"],
	corpusScoped: true,
	input: {
		document_id: uuid("Document id (from list_documents)."),
		corpus_id: corpusIdInput,
		version_id: uuid("Show this version's chunks instead of the active version's.").optional(),
		chunk_offset: z.number().int().min(0).optional().describe("Chunks to skip (default 0)."),
		chunk_limit: z.number().int().min(1).max(200).optional().describe("Chunks per page (default 50)."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<DocumentDetailResponse>(`/api/v1/documents/${seg(input.document_id)}`, {
			corpus_id: await resolveCorpusId(input.corpus_id, ctx),
			version_id: input.version_id,
			chunk_offset: input.chunk_offset,
			chunk_limit: input.chunk_limit,
		}),
	render: (data) => {
		const doc = data as DocumentDetailResponse;
		const head = keyValues(doc, [
			"id",
			"file_name",
			"external_id",
			"mime_type",
			"size_bytes",
			"ingested_at",
			"source_uri",
			"metadata",
			"active_version_id",
			"version_id",
		]);
		const versions = table(doc.versions, [
			{ key: "id" },
			{ key: "status" },
			{ key: "chunk_count", label: "chunks" },
			{ key: "created_at" },
		]);
		const chunks = doc.chunks.map((c) => {
			const label = [
				`#${c.chunk_index ?? "?"}`,
				c.section?.length ? c.section.join(" > ") : undefined,
				c.page !== null ? `p. ${c.page}` : undefined,
				c.is_table ? "table" : undefined,
				c.is_code ? "code" : undefined,
				`${c.token_count ?? "?"} tokens`,
			].filter(Boolean);
			return `[${label.join(" | ")}]\n${c.text.trim()}`;
		});
		const footer = pageFooter(
			"chunk(s)",
			{ count: doc.chunks.length, total: doc.chunk_total, offset: doc.chunk_offset },
			"--chunk-offset",
		);
		return `${head}\n\nVersions:\n${versions}\n\nChunks:\n${chunks.length ? chunks.join("\n\n") : "(none)"}\n\n${footer}`;
	},
});

export const listDocumentVersionsTool = defineTool({
	name: "list_document_versions",
	title: "List document versions",
	description: "List every version of one document, with its status and chunk count.",
	group: "documents",
	command: "versions",
	kinds: ALL,
	access: "read",
	positional: ["document_id"],
	corpusScoped: true,
	input: {
		document_id: uuid("Document id (from list_documents)."),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) =>
		ctx.client.get<VersionListResponse>(`/api/v1/documents/${seg(input.document_id)}/versions`, {
			corpus_id: await resolveCorpusId(input.corpus_id, ctx),
		}),
	render: (data) => {
		const res = data as VersionListResponse;
		return `${res.file_name ?? res.document_id}\n\n${table(res.versions, [
			{ key: "id" },
			{ key: "status" },
			{ key: "chunk_count", label: "chunks" },
			{ key: "parser_version", label: "parser" },
			{ key: "created_at" },
		])}`;
	},
});

export const previewDeleteDocumentTool = defineTool({
	name: "preview_delete_document",
	title: "Preview deleting a document",
	description:
		"Dry run: what deleting a document would remove (versions, chunks) and the exact name to pass as confirm_name " +
		"to delete_document (its file name, or its record id for imported records). Changes nothing.",
	group: "documents",
	command: "delete-preview",
	kinds: ALL,
	access: "read",
	positional: ["document_id"],
	corpusScoped: true,
	input: {
		document_id: uuid("Document id (from list_documents)."),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) =>
		ctx.client.get<DeletePreviewResponse>(`/api/v1/documents/${seg(input.document_id)}/delete-preview`, {
			corpus_id: await resolveCorpusId(input.corpus_id, ctx),
		}),
	render: (data) => renderPreview(data as DeletePreviewResponse),
});

export const deleteDocumentTool = defineTool({
	name: "delete_document",
	title: "Delete a document",
	description:
		"Permanently delete a document with all its versions, chunks and vectors. It stops appearing in answers immediately. Cannot be undone. " +
		"Needs confirm_name, the document's exact file name (or record id); run preview_delete_document first to see what would go.",
	group: "documents",
	command: "delete",
	kinds: ALL,
	access: "destructive",
	positional: ["document_id", "confirm_name"],
	corpusScoped: true,
	input: {
		document_id: uuid("Document id to delete."),
		confirm_name: z
			.string()
			.min(1)
			.max(500)
			.describe(
				"The document's exact file name, or its record id if it has none (from get_document or preview_delete_document).",
			),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) => {
		await ctx.client.request("DELETE", `/api/v1/documents/${seg(input.document_id)}`, {
			query: { corpus_id: await resolveCorpusId(input.corpus_id, ctx), confirm_name: input.confirm_name },
		});
		return { deleted: true, document_id: input.document_id };
	},
});
