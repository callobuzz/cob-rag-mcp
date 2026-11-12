import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type {
	IngestRecordsRequest,
	IngestRecordsResponse,
	IngestResponse,
	JobListResponse,
	JobStatusResponse,
} from "../core/api-types.js";
import { type EngineClient, seg } from "../core/client.js";
import { CobRagError } from "../core/errors.js";
import { keyValues, pageFooter, table } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";
import { resolveUploadPath } from "../core/upload-guard.js";
import { compact, recordSchema, uuid } from "./schemas.js";

const ALL = ["admin", "tenant", "corpus"] as const;

/** The engine's upload limit (MAX_FILE_SIZE in its ingest route). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Job states after which nothing more happens without a person acting. */
const SETTLED = new Set(["completed", "failed", "pending_review", "expired", "skipped"]);

/**
 * MIME types by extension, matching what the engine accepts. Sending the right type matters:
 * the engine checks PDF and Office files against their magic bytes.
 */
const MIME_BY_EXT: Record<string, string> = {
	".pdf": "application/pdf",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".csv": "text/csv",
	".html": "text/html",
	".htm": "text/html",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".txt": "text/plain",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".webm": "audio/webm",
};

export function mimeTypeFor(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const waitInput = z
	.boolean()
	.optional()
	.describe("Wait until the ingest job finishes (up to wait_seconds) and return its final status.");
const waitSecondsInput = z.number().int().min(1).max(3600).optional().describe("How long to wait (default 120).");

export async function waitForJob(
	client: EngineClient,
	jobId: string,
	timeoutSeconds = 120,
	intervalMs = 1000,
): Promise<JobStatusResponse> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	for (;;) {
		const job = await client.get<JobStatusResponse>(`/api/v1/ingest/jobs/${seg(jobId)}`);
		if (SETTLED.has(job.status) || job.finished_at) return job;
		if (Date.now() >= deadline) return job;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

function renderJob(data: unknown): string {
	const job = (data as { job?: JobStatusResponse }).job ?? (data as JobStatusResponse);
	const head = keyValues(
		data,
		Object.keys(data as object).filter((k) => k !== "job"),
	);
	if (!(data as { job?: unknown }).job) return head;
	return `${head}\n\nJob:\n${keyValues(job, ["id", "status", "processed_documents", "total_documents", "records", "errors", "finished_at"])}`;
}

export const addRecordsTool = defineTool({
	name: "add_records",
	title: "Add text records",
	description:
		"Add or update up to 1000 already-text records (FAQ entries, products, help articles) in the knowledge base. " +
		"Each record is keyed by its id: sending an id again replaces that record, and unchanged records are skipped.",
	group: "ingest",
	command: "records",
	kinds: ALL,
	access: "write",
	corpusScoped: true,
	input: {
		records: z.array(recordSchema).min(1).max(1000).describe("The records. CLI: a JSON array, or @file.json."),
		corpus_id: corpusIdInput,
		wait: waitInput,
		wait_seconds: waitSecondsInput,
	},
	handler: async (input, ctx) => {
		const body: IngestRecordsRequest = {
			records: input.records,
			...compact({ corpus_id: await resolveCorpusId(input.corpus_id, ctx) }),
		};
		const res = await ctx.client.request<IngestRecordsResponse>("POST", "/api/v1/ingest/records", { body });
		if (!input.wait) return res;
		return { ...res, job: await waitForJob(ctx.client, res.job_id, input.wait_seconds) };
	},
	render: renderJob,
});

export const uploadFileTool = defineTool({
	name: "upload_file",
	title: "Upload a file",
	description:
		"Upload a local file (PDF, DOCX, PPTX, XLSX, CSV, HTML, Markdown, text, images; audio when the engine has " +
		"transcription on) for ingestion. Over MCP, only files inside COB_RAG_UPLOAD_DIR can be uploaded; a relative " +
		"path is taken relative to that directory.",
	group: "ingest",
	command: "upload",
	kinds: ALL,
	access: "write",
	positional: ["path"],
	corpusScoped: true,
	mcpTransports: ["stdio"],
	input: {
		path: z.string().min(1).describe("Path of the file to upload."),
		corpus_id: corpusIdInput,
		mode: z
			.enum(["auto", "replace", "new", "version"])
			.optional()
			.describe("How to treat a document that looks like one already there (default auto)."),
		target_document_id: uuid("Document to replace or add a version to.").optional(),
		auto_confirm: z.boolean().optional().describe("Skip the near-duplicate review step."),
		metadata: z.record(z.string()).optional().describe("Filterable metadata for the document."),
		idempotency_key: z.string().optional().describe("Retry-safe key: the same key never ingests twice."),
		wait: waitInput,
		wait_seconds: waitSecondsInput,
	},
	handler: async (input, ctx) => {
		// The CLI runs as the user in their own shell, so any path they type is theirs to send.
		// An MCP client is a different matter: see upload-guard.ts.
		const path =
			ctx.surface === "cli" ? resolve(input.path) : await resolveUploadPath(input.path, ctx.config.uploadDir);
		let size: number;
		try {
			const info = await stat(path);
			if (!info.isFile()) throw new CobRagError(`Not a file: ${input.path}`, "USAGE");
			size = info.size;
		} catch (err) {
			if (err instanceof CobRagError) throw err;
			throw new CobRagError(`File not found: ${input.path}`, "USAGE");
		}
		if (size > MAX_UPLOAD_BYTES) throw new CobRagError("File too large: the engine accepts up to 50 MB.", "USAGE");

		const form = new FormData();
		form.append("file", await openAsBlob(path, { type: mimeTypeFor(path) }), basename(path));
		const corpusId = await resolveCorpusId(input.corpus_id, ctx);
		if (corpusId) form.append("corpus_id", corpusId);
		if (input.mode) form.append("mode", input.mode);
		if (input.target_document_id) form.append("target_document_id", input.target_document_id);
		if (input.auto_confirm !== undefined) form.append("auto_confirm", String(input.auto_confirm));
		if (input.metadata) form.append("metadata", JSON.stringify(input.metadata));
		if (input.idempotency_key) form.append("idempotency_key", input.idempotency_key);

		const res = await ctx.client.request<IngestResponse>("POST", "/api/v1/ingest", { form });
		if (!input.wait) return res;
		return { ...res, job: await waitForJob(ctx.client, res.job_id, input.wait_seconds) };
	},
	render: renderJob,
});

export const getIngestJobTool = defineTool({
	name: "get_ingest_job",
	title: "Ingest job status",
	description:
		"Get the status of an ingest job: queued, parsing, embedding, completed, failed, pending_review, skipped...",
	group: "ingest",
	command: "job",
	kinds: ALL,
	access: "read",
	positional: ["job_id"],
	input: {
		job_id: uuid("Job id returned by add_records or upload_file."),
	},
	handler: async (input, ctx) => ctx.client.get<JobStatusResponse>(`/api/v1/ingest/jobs/${seg(input.job_id)}`),
	render: (data) => {
		const job = data as JobStatusResponse;
		const head = keyValues(job, [
			"id",
			"status",
			"corpus_id",
			"file_name",
			"mode",
			"target_document_id",
			"processed_documents",
			"total_documents",
			"records",
			"errors",
			"created_at",
			"finished_at",
			"expires_at",
		]);
		if (!job.similar_documents?.length) return head;
		const similar = table(job.similar_documents, [
			{ key: "document_id" },
			{ key: "file_name", max: 40 },
			{ key: "similarity" },
			{ key: "match_count", label: "matches" },
		]);
		return `${head}\n\nLooks like these existing documents:\n${similar}`;
	},
});

/** Job states the engine reports, for filters. */
const JOB_STATUSES =
	"queued, uploading, parsing, chunking, enriching, embedding, storing, completed, failed, pending_review, expired, skipped";

export const listIngestJobsTool = defineTool({
	name: "list_ingest_jobs",
	title: "List ingest jobs",
	description:
		"List ingest jobs, newest first, with their corpus, file, mode and progress: the key's own corpus, a tenant's " +
		"corpora, or all for admin. Paged: `count` is the jobs on this page, `total` all that match.",
	group: "ingest",
	command: "jobs",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: {
		status: z.string().min(1).max(50).optional().describe(`Only jobs in this status: ${JOB_STATUSES}.`),
		corpus_id: uuid("Only this corpus's jobs (a filter: no default corpus applies).").optional(),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
		limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20, at most 100)."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<JobListResponse>("/api/v1/ingest/jobs", {
			status: input.status,
			corpus_id: input.corpus_id,
			offset: input.offset,
			limit: input.limit,
		}),
	render: (data) => {
		const res = data as JobListResponse;
		const rows = table(res.items, [
			{ key: "id" },
			{ key: "status" },
			{ key: "corpus_id" },
			{ key: "file_name", max: 30 },
			{ key: "mode" },
			{ key: "processed_documents", label: "processed" },
			{ key: "total_documents", label: "total" },
			{ key: "created_at" },
		]);
		return `${rows}\n\n${pageFooter("job(s)", { count: res.items.length, total: res.total, offset: res.offset })}`;
	},
});
