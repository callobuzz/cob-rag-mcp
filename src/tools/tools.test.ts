import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WhoAmI } from "../core/api-types.js";
import { EngineClient } from "../core/client.js";
import { loadConfig, type ResolvedConfig } from "../core/config.js";
import type { AnyTool, Surface, ToolContext } from "../core/tool.js";
import {
	createCorpusRoute,
	fakeEngine,
	IDS,
	type RecordedCall,
	reply,
	STREAM_EVENTS,
	sse,
	WHOAMI,
} from "../test/fake-engine.js";
import { ALL_TOOLS, findTool } from "./index.js";
import { mimeTypeFor } from "./ingest.js";

function tool(name: string): AnyTool {
	const t = findTool(name);
	if (!t) throw new Error(`no tool ${name}`);
	return t;
}

interface RunOptions {
	routes?: Record<string, unknown>;
	identity?: WhoAmI;
	config?: Partial<ResolvedConfig>;
	surface?: Surface;
	stream?: ToolContext["stream"];
}

async function run(name: string, input: Record<string, unknown>, options: RunOptions = {}) {
	const engine = fakeEngine({ "GET /api/v1/whoami": WHOAMI.corpus, ...options.routes });
	const config = { ...loadConfig({ env: {} }), ...options.config };
	const client = new EngineClient({ url: "http://engine.test", apiKey: "ck_testtesttest1234", fetch: engine.fetch });
	const ctx: ToolContext = {
		client,
		config,
		surface: options.surface ?? "stdio",
		identity: options.identity,
		stream: options.stream,
	};
	const t = tool(name);
	const parsed = z
		.object(t.input as z.ZodRawShape)
		.strict()
		.parse(input);
	const result = await t.handler(parsed, ctx);
	const calls = engine.calls.filter((c) => c.path !== "/api/v1/whoami");
	return { result, calls, all: engine.calls, call: calls[calls.length - 1] as RecordedCall };
}

const chunk = {
	chunk_id: "c1",
	text: "Fast for 10-12 hours before a lipid profile.",
	score: 0.91,
	token_count: 12,
	file_name: null,
	external_id: "faq-lipid",
	section: "Fasting",
	page: null,
	document_id: IDS.doc,
	score_breakdown: { fused_score: 0.91, pipeline_rank: 1 },
};

describe("whoami", () => {
	it("GETs /api/v1/whoami", async () => {
		const { result, all } = await run("whoami", {});
		expect(all[0]?.method).toBe("GET");
		expect(result).toMatchObject({ kind: "corpus" });
	});
});

describe("search", () => {
	const routes = {
		"POST /api/v1/query/retrieve": {
			chunks: [chunk],
			processed_query: "fasting lipid",
			latency_ms: 42,
			total_chunks: 1,
			stage_timings_ms: { embed: 5 },
		},
	};

	it("POSTs /query/retrieve with only the options given, and trims score detail", async () => {
		const { call, result } = await run("search", { query: "fasting?", final_k: 3, search_mode: "hybrid" }, { routes });
		expect(call.method).toBe("POST");
		expect(call.path).toBe("/api/v1/query/retrieve");
		expect(call.body).toEqual({ query: "fasting?", options: { final_k: 3, search_mode: "hybrid" } });
		const r = result as { chunks: Array<Record<string, unknown>>; stage_timings_ms?: unknown };
		expect(r.chunks[0]).not.toHaveProperty("score_breakdown");
		expect(r.chunks[0]).toMatchObject({ external_id: "faq-lipid", section: "Fasting" });
		expect(r.stage_timings_ms).toBeUndefined();
	});

	it("keeps score detail with verbose", async () => {
		const { result } = await run("search", { query: "q", verbose: true }, { routes });
		const r = result as { chunks: Array<Record<string, unknown>>; stage_timings_ms?: unknown };
		expect(r.chunks[0]).toHaveProperty("score_breakdown");
		expect(r.stage_timings_ms).toEqual({ embed: 5 });
	});

	it("sends the bring-your-own-key headers", async () => {
		const engine = fakeEngine(routes);
		const client = new EngineClient({
			url: "http://e",
			apiKey: "k",
			llm: { provider: "openai", model: "gpt-x", apiKey: "sk-1", baseUrl: "https://p" },
			fetch: engine.fetch,
		});
		await tool("search").handler({ query: "q" }, { client, config: loadConfig({ env: {} }), surface: "cli" });
		expect(engine.last().headers).toMatchObject({
			"x-llm-provider": "openai",
			"x-llm-model": "gpt-x",
			"x-llm-api-key": "sk-1",
			"x-llm-base-url": "https://p",
		});
	});

	it("names the corpus for tenant keys, from input or the configured default", async () => {
		const tenant = WHOAMI.tenant as WhoAmI;
		const given = await run("search", { query: "q", corpus_id: IDS.other }, { routes, identity: tenant });
		expect(given.call.body).toMatchObject({ corpus_id: IDS.other });
		const fallback = await run(
			"search",
			{ query: "q" },
			{ routes, identity: tenant, config: { corpusId: IDS.corpus } },
		);
		expect(fallback.call.body).toMatchObject({ corpus_id: IDS.corpus });
	});

	it("tells a tenant key without a corpus what to do, before calling the engine", async () => {
		await expect(run("search", { query: "q" }, { routes, identity: WHOAMI.tenant as WhoAmI })).rejects.toThrow(
			/corpus_id is required with a tenant key/,
		);
	});

	it("never sends corpus_id for a corpus key", async () => {
		const { call } = await run(
			"search",
			{ query: "q" },
			{ routes, identity: WHOAMI.corpus as WhoAmI, config: { corpusId: IDS.other } },
		);
		expect(call.body).not.toHaveProperty("corpus_id");
	});
});

describe("ask", () => {
	it("POSTs /query with X-LLM headers", async () => {
		const answer = { answer: "10-12 hours.", confidence: 0.9, query_id: IDS.job, model_used: "m", latency_ms: 800 };
		const { call, result } = await run(
			"ask",
			{ query: "fasting?", system_prompt: "Be brief" },
			{
				routes: { "POST /api/v1/query": answer },
			},
		);
		expect(call.path).toBe("/api/v1/query");
		expect(call.body).toEqual({ query: "fasting?", system_prompt: "Be brief", options: {} });
		expect(result).toEqual(answer);
	});

	it("streams from /query/stream when the CLI asks for it", async () => {
		const events: string[] = [];
		const { call, result } = await run(
			"ask",
			{ query: "q", final_k: 3 },
			{ routes: { "POST /api/v1/query/stream": sse(STREAM_EVENTS) }, stream: (e) => events.push(e.event) },
		);
		expect(call.path).toBe("/api/v1/query/stream");
		expect(call.body).toEqual({ query: "q", options: { final_k: 3 } });
		expect(events).toEqual(["sources", "token", "token", "done"]);
		expect(result).toMatchObject({
			streamed: true,
			query_id: IDS.job,
			answer: "Fast for 10-12 hours [1].",
			model: "qwen2.5:3b",
			latency_ms: 950,
		});
		const text = tool("ask").render?.(result) ?? "";
		expect(text).toBe("\nSources:\n  [1] Fasting [faq-lipid]\n  [2] prep.pdf > Thyroid > p. 3\n\nqwen2.5:3b | 950 ms");
	});

	it("never streams over MCP: without a stream sink it asks /query", async () => {
		const { call } = await run("ask", { query: "q" }, { routes: { "POST /api/v1/query": {} } });
		expect(call.path).toBe("/api/v1/query");
	});

	it("rejects questions over the engine's 2000-character limit", () => {
		expect(() => z.object(tool("ask").input).parse({ query: "x".repeat(2001) })).toThrow();
	});
});

describe("documents", () => {
	const tenant = WHOAMI.tenant as WhoAmI;
	const admin = WHOAMI.admin as WhoAmI;

	it("lists with paging and search, and says which page it is", async () => {
		const { call, result } = await run(
			"list_documents",
			{ limit: 10, offset: 20, search: "price" },
			{ routes: { "GET /api/v1/documents": { items: [], count: 25 } } },
		);
		expect(Object.fromEntries(call.query)).toEqual({ limit: "10", offset: "20", search: "price" });
		expect(result).toEqual({ items: [], count: 25, offset: 20 });
	});

	it("renders record ids and the page footer", () => {
		const text =
			tool("list_documents").render?.({
				items: [
					{
						id: IDS.doc,
						file_name: "Fasting",
						external_id: "faq-1",
						mime_type: "text/plain",
						size_bytes: 10,
						ingested_at: "2026-09-29",
						version_count: 1,
					},
				],
				count: 3,
				offset: 0,
			}) ?? "";
		expect(text).toMatch(/record id/);
		expect(text).toContain("faq-1");
		expect(text).toContain("document(s) 1-1 of 3. More: --offset 1");
	});

	it("names the corpus with ?corpus_id= for tenant and admin keys, never for a corpus key", async () => {
		const routes = { "GET /api/v1/documents": { items: [], count: 0 } };
		const given = await run("list_documents", { corpus_id: IDS.other }, { routes, identity: tenant });
		expect(given.call.query.get("corpus_id")).toBe(IDS.other);
		const fallback = await run("list_documents", {}, { routes, identity: admin, config: { corpusId: IDS.corpus } });
		expect(fallback.call.query.get("corpus_id")).toBe(IDS.corpus);
		const own = await run(
			"list_documents",
			{},
			{ routes, identity: WHOAMI.corpus as WhoAmI, config: { corpusId: IDS.other } },
		);
		expect(own.call.query.has("corpus_id")).toBe(false);
	});

	it("tells a tenant or admin key without a corpus what to do, before calling the engine", async () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["list_documents", {}],
			["get_document", { document_id: IDS.doc }],
			["list_document_versions", { document_id: IDS.doc }],
			["delete_document", { document_id: IDS.doc, confirm_name: "policy.pdf" }],
			["preview_delete_document", { document_id: IDS.doc }],
			["get_corpus_settings", {}],
			["update_corpus_settings", { prompt_config: { response_language: "en" } }],
		];
		for (const [name, input] of cases) {
			for (const identity of [tenant, admin]) {
				await expect(run(name, input, { identity })).rejects.toThrow(/corpus_id is required/);
			}
		}
	});

	it("gets a document with its chunks, paged", async () => {
		const detail = {
			id: IDS.doc,
			file_name: "prep.pdf",
			mime_type: "application/pdf",
			size_bytes: 10,
			ingested_at: "2026-09-29T00:00:00Z",
			external_id: null,
			metadata: { lang: "en" },
			source_uri: null,
			active_version_id: IDS.job,
			version_id: IDS.job,
			versions: [{ id: IDS.job, status: "active", chunk_count: 3, created_at: "2026-09-29" }],
			chunks: [
				{
					id: IDS.key,
					chunk_index: 2,
					text: "Fast 10-12 hours.",
					section: ["Prep", "Fasting"],
					page: 1,
					token_count: 5,
					is_table: false,
					is_code: false,
				},
			],
			chunk_total: 3,
			chunk_offset: 2,
			chunk_limit: 1,
		};
		const { call, result } = await run(
			"get_document",
			{ document_id: IDS.doc, corpus_id: IDS.corpus, version_id: IDS.job, chunk_offset: 2, chunk_limit: 1 },
			{ identity: tenant, routes: { [`GET /api/v1/documents/${IDS.doc}`]: detail } },
		);
		expect(call.path).toBe(`/api/v1/documents/${IDS.doc}`);
		expect(Object.fromEntries(call.query)).toEqual({
			corpus_id: IDS.corpus,
			version_id: IDS.job,
			chunk_offset: "2",
			chunk_limit: "1",
		});
		const text = tool("get_document").render?.(result) ?? "";
		expect(text).toContain("[#2 | Prep > Fasting | p. 1 | 5 tokens]");
		expect(text).toContain("Fast 10-12 hours.");
		expect(text).toContain("chunk(s) 3-3 of 3");
		expect(() => z.object(tool("get_document").input).parse({ document_id: IDS.doc, chunk_limit: 201 })).toThrow();
	});

	it("lists versions", async () => {
		const { call } = await run(
			"list_document_versions",
			{ document_id: IDS.doc },
			{
				routes: {
					[`GET /api/v1/documents/${IDS.doc}/versions`]: {
						document_id: IDS.doc,
						file_name: "f",
						versions: [],
						count: 0,
					},
				},
			},
		);
		expect(call.method).toBe("GET");
		const scoped = await run(
			"list_document_versions",
			{ document_id: IDS.doc, corpus_id: IDS.corpus },
			{
				identity: WHOAMI.admin as WhoAmI,
				routes: {
					[`GET /api/v1/documents/${IDS.doc}/versions`]: { document_id: IDS.doc, versions: [], count: 0 },
				},
			},
		);
		expect(scoped.call.query.get("corpus_id")).toBe(IDS.corpus);
	});

	it("deletes with ?corpus_id= for a tenant key", async () => {
		const { call } = await run(
			"delete_document",
			{ document_id: IDS.doc, corpus_id: IDS.corpus, confirm_name: "policy.pdf" },
			{ identity: WHOAMI.tenant as WhoAmI, routes: { [`DELETE /api/v1/documents/${IDS.doc}`]: reply(204) } },
		);
		expect(call.query.get("corpus_id")).toBe(IDS.corpus);
		expect(call.query.get("confirm_name")).toBe("policy.pdf");
	});

	it("deletes, sending the document's name as confirm_name", async () => {
		const { call, result } = await run(
			"delete_document",
			{ document_id: IDS.doc, confirm_name: "policy.pdf" },
			{ routes: { [`DELETE /api/v1/documents/${IDS.doc}`]: reply(204) } },
		);
		expect(call.method).toBe("DELETE");
		expect(call.query.get("confirm_name")).toBe("policy.pdf");
		expect(result).toEqual({ deleted: true, document_id: IDS.doc });
	});

	it("will not delete without the document's name", () => {
		const input = z.object(tool("delete_document").input);
		expect(() => input.parse({ document_id: IDS.doc })).toThrow();
		expect(() => input.parse({ document_id: IDS.doc, confirm_name: "" })).toThrow();
		expect(String(tool("delete_document").description)).toContain("preview_delete_document");
	});

	it("previews a delete: counts and the name to confirm with, changing nothing", async () => {
		const preview = {
			kind: "document",
			id: IDS.doc,
			name: "policy.pdf",
			confirm_name: "policy.pdf",
			counts: { versions: 2, chunks: 31 },
			irreversible: true,
		};
		const { call, result } = await run(
			"preview_delete_document",
			{ document_id: IDS.doc },
			{ routes: { [`GET /api/v1/documents/${IDS.doc}/delete-preview`]: preview } },
		);
		expect(call.method).toBe("GET");
		expect(result).toEqual(preview);
		expect(tool("preview_delete_document").access).toBe("read");
		const text = tool("preview_delete_document").render?.(preview) ?? "";
		expect(text).toContain('"policy.pdf" would remove');
		expect(text).toContain("chunks: 31");
		expect(text).toContain('confirm_name "policy.pdf"');
	});

	it("refuses an id that is not a UUID", () => {
		expect(() =>
			z.object(tool("delete_document").input).parse({ document_id: "../corpora", confirm_name: "x" }),
		).toThrow();
	});
});

describe("ingest", () => {
	const records = [{ id: "faq-1", title: "Fasting", text: "Fast 10-12 hours.", metadata: { category: "prep" } }];

	it("adds records", async () => {
		const { call, result } = await run(
			"add_records",
			{ records },
			{ routes: { "POST /api/v1/ingest/records": { job_id: IDS.job, status: "queued", records: 1 } } },
		);
		expect(call.body).toEqual({ records });
		expect(result).toMatchObject({ job_id: IDS.job });
	});

	it("waits for the job when asked", async () => {
		let polls = 0;
		const { result } = await run(
			"add_records",
			{ records, wait: true, wait_seconds: 5 },
			{
				routes: {
					"POST /api/v1/ingest/records": { job_id: IDS.job, status: "queued", records: 1 },
					[`GET /api/v1/ingest/jobs/${IDS.job}`]: () => {
						polls += 1;
						return {
							id: IDS.job,
							status: polls < 2 ? "embedding" : "completed",
							total_documents: 1,
							processed_documents: polls < 2 ? 0 : 1,
							errors: null,
							created_at: "2026-01-01T00:00:00Z",
							finished_at: polls < 2 ? null : "2026-01-01T00:00:02Z",
						};
					},
				},
			},
		);
		expect(polls).toBe(2);
		expect(result).toMatchObject({ job: { status: "completed" } });
	});

	it("rejects records the engine would refuse", () => {
		const input = z.object(tool("add_records").input);
		expect(() => input.parse({ records: [] })).toThrow();
		expect(() => input.parse({ records: [{ id: "x", text: "" }] })).toThrow();
		expect(() => input.parse({ records: [{ id: "x", text: "t", extra: 1 }] })).toThrow();
	});

	it("uploads a local file as multipart from the CLI", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cob-rag-up-"));
		const file = join(dir, "prep.md");
		writeFileSync(file, "# Prep\nFast 10 hours.");
		const { call } = await run(
			"upload_file",
			{ path: file, mode: "new", metadata: { lang: "en" }, auto_confirm: true },
			{ surface: "cli", routes: { "POST /api/v1/ingest": { job_id: IDS.job, status: "queued" } } },
		);
		const form = call.form as FormData;
		const sent = form.get("file") as File;
		expect(sent.name).toBe("prep.md");
		expect(sent.type).toBe("text/markdown");
		expect(await sent.text()).toContain("Fast 10 hours");
		expect(form.get("mode")).toBe("new");
		expect(form.get("auto_confirm")).toBe("true");
		expect(form.get("metadata")).toBe('{"lang":"en"}');
		expect(form.get("corpus_id")).toBeNull();
	});

	it("over MCP, uploads only from the upload directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cob-rag-up-"));
		writeFileSync(join(dir, "ok.txt"), "hello");
		const routes = { "POST /api/v1/ingest": { job_id: IDS.job, status: "queued" } };
		const ok = await run("upload_file", { path: "ok.txt" }, { surface: "stdio", routes, config: { uploadDir: dir } });
		expect(ok.call.path).toBe("/api/v1/ingest");
		await expect(
			run("upload_file", { path: "../etc/passwd" }, { surface: "stdio", routes, config: { uploadDir: dir } }),
		).rejects.toMatchObject({ code: "REFUSED" });
		await expect(run("upload_file", { path: join(dir, "ok.txt") }, { surface: "stdio", routes })).rejects.toMatchObject(
			{ code: "REFUSED" },
		);
	});

	it("maps extensions to the MIME types the engine checks", () => {
		expect(mimeTypeFor("a.PDF")).toBe("application/pdf");
		expect(mimeTypeFor("b.docx")).toContain("wordprocessingml");
		expect(mimeTypeFor("c.unknown")).toBe("application/octet-stream");
	});

	it("gets one job and lists jobs", async () => {
		const job = await run(
			"get_ingest_job",
			{ job_id: IDS.job },
			{ routes: { [`GET /api/v1/ingest/jobs/${IDS.job}`]: { id: IDS.job } } },
		);
		expect(job.call.method).toBe("GET");
		const list = await run(
			"list_ingest_jobs",
			{ limit: 5 },
			{ routes: { "GET /api/v1/ingest/jobs": { items: [], count: 0 } } },
		);
		expect(list.call.query.get("limit")).toBe("5");
	});

	it("filters jobs by status and corpus, with paging, and never applies the default corpus", async () => {
		const routes = { "GET /api/v1/ingest/jobs": { items: [], count: 0, total: 0, offset: 0, limit: 20 } };
		const { call } = await run(
			"list_ingest_jobs",
			{ status: "pending_review", corpus_id: IDS.corpus, offset: 40, limit: 20 },
			{ routes, identity: WHOAMI.admin as WhoAmI },
		);
		expect(Object.fromEntries(call.query)).toEqual({
			status: "pending_review",
			corpus_id: IDS.corpus,
			offset: "40",
			limit: "20",
		});
		const unfiltered = await run(
			"list_ingest_jobs",
			{},
			{ routes, identity: WHOAMI.tenant as WhoAmI, config: { corpusId: IDS.other } },
		);
		expect([...unfiltered.call.query.keys()]).toEqual([]);
		expect(() => z.object(tool("list_ingest_jobs").input).parse({ limit: 101 })).toThrow();
	});

	it("shows a job's file, mode and the documents a held upload resembles", () => {
		const job = {
			id: IDS.job,
			status: "pending_review",
			corpus_id: IDS.corpus,
			file_name: "prices-v2.pdf",
			mode: "auto",
			total_documents: 1,
			processed_documents: 0,
			errors: null,
			created_at: "2026-09-29",
			finished_at: null,
			similar_documents: [{ document_id: IDS.doc, file_name: "prices.pdf", similarity: 0.93, match_count: 12 }],
		};
		const one = tool("get_ingest_job").render?.(job) ?? "";
		expect(one).toMatch(/^file_name\s+prices-v2\.pdf$/m);
		expect(one).toContain("Looks like these existing documents:");
		expect(one).toContain("prices.pdf");
		const list = tool("list_ingest_jobs").render?.({ items: [job], count: 1, total: 41, offset: 20, limit: 1 }) ?? "";
		expect(list).toContain("prices-v2.pdf");
		expect(list).toContain("job(s) 21-21 of 41. More: --offset 21");
	});
});

describe("usage", () => {
	it("passes filters as query parameters", async () => {
		const { call } = await run(
			"get_usage",
			{ start: "2026-09-01", end: "2026-09-29", group_by: "source", tenant_id: IDS.tenant },
			{
				routes: {
					"GET /api/v1/usage": { start: "", end: "", group_by: "source", rows: [], totals: {} },
				},
			},
		);
		expect(Object.fromEntries(call.query)).toEqual({
			start: "2026-09-01",
			end: "2026-09-29",
			group_by: "source",
			tenant_id: IDS.tenant,
		});
	});

	it("rejects a malformed date", () => {
		expect(() => z.object(tool("get_usage").input).parse({ start: "29/09/2026" })).toThrow();
	});
});

describe("corpus settings", () => {
	it("gets and patches /api/v1/config", async () => {
		const get = await run("get_corpus_settings", {}, { routes: { "GET /api/v1/config": {} } });
		expect(get.call.path).toBe("/api/v1/config");
		const patch = await run(
			"update_corpus_settings",
			{ retrieval_config: { final_k: 8, reranking_enabled: true }, prompt_config: { response_language: "en" } },
			{ routes: { "PATCH /api/v1/config": {} } },
		);
		expect(patch.call.method).toBe("PATCH");
		expect(patch.call.body).toEqual({
			retrieval_config: { final_k: 8, reranking_enabled: true },
			prompt_config: { response_language: "en" },
		});
	});

	it("names the corpus with ?corpus_id= for tenant and admin keys", async () => {
		const get = await run(
			"get_corpus_settings",
			{ corpus_id: IDS.corpus },
			{ identity: WHOAMI.tenant as WhoAmI, routes: { "GET /api/v1/config": { corpus_id: IDS.corpus } } },
		);
		expect(get.call.query.get("corpus_id")).toBe(IDS.corpus);
		const patch = await run(
			"update_corpus_settings",
			{ retrieval_config: { final_k: 4 } },
			{
				identity: WHOAMI.admin as WhoAmI,
				config: { corpusId: IDS.other },
				routes: { "PATCH /api/v1/config": {} },
			},
		);
		expect(patch.call.query.get("corpus_id")).toBe(IDS.other);
		expect(patch.call.body).toEqual({ retrieval_config: { final_k: 4 } });
		const own = await run(
			"get_corpus_settings",
			{},
			{ identity: WHOAMI.corpus as WhoAmI, routes: { "GET /api/v1/config": {} } },
		);
		expect(own.call.query.has("corpus_id")).toBe(false);
	});

	it("clears a setting with null and resets a section with null", async () => {
		const patch = await run(
			"update_corpus_settings",
			{ retrieval_config: { final_k: null, preset: "premium" }, prompt_config: null },
			{ routes: { "PATCH /api/v1/config": {} } },
		);
		expect(patch.call.body).toEqual({ retrieval_config: { final_k: null, preset: "premium" }, prompt_config: null });
	});

	it("refuses an empty update and unknown settings", async () => {
		await expect(run("update_corpus_settings", {}, {})).rejects.toMatchObject({ code: "USAGE" });
		expect(() =>
			z.object(tool("update_corpus_settings").input).parse({ retrieval_config: { search_mode: "hybrid" } }),
		).toThrow();
	});
});

describe("corpora", () => {
	const base = `/api/v1/corpora/${IDS.corpus}`;

	it("lists, gets, creates and updates", async () => {
		expect((await run("list_corpora", {}, { routes: { "GET /api/v1/corpora": { items: [] } } })).call.path).toBe(
			"/api/v1/corpora",
		);
		expect((await run("get_corpus", { corpus_id: IDS.corpus }, { routes: { [`GET ${base}`]: {} } })).call.path).toBe(
			base,
		);

		const created = await run(
			"create_corpus",
			{
				name: "lab-faq",
				description: "Pune lab",
				tenant_id: IDS.tenant,
				llm_config: { provider: "ollama", model: "qwen2.5:3b" },
			},
			{ routes: { "POST /api/v1/corpora": createCorpusRoute() } },
		);
		expect(created.call.body).toEqual({
			name: "lab-faq",
			description: "Pune lab",
			tenant_id: IDS.tenant,
			llm_config: { provider: "ollama", model: "qwen2.5:3b" },
		});
		expect(created.result).toMatchObject({ tenant_id: IDS.tenant });

		const updated = await run(
			"update_corpus",
			{ corpus_id: IDS.corpus, name: "renamed" },
			{ routes: { [`PUT ${base}`]: {} } },
		);
		expect(updated.call.method).toBe("PUT");
		expect(updated.call.body).toEqual({ name: "renamed" });
		await expect(run("update_corpus", { corpus_id: IDS.corpus }, {})).rejects.toMatchObject({ code: "USAGE" });
	});

	it("lists a page with tenant_id, offset and limit, and says there are more", async () => {
		const page = {
			items: [
				{
					id: IDS.corpus,
					name: "lab-faq",
					description: null,
					qdrant_collection: "c",
					created_at: "2026-09-29",
					tenant_id: IDS.tenant,
					tenant_name: "Acme",
					document_count: 4,
					chunk_count: 20,
					last_activity_at: "2026-09-30",
				},
			],
			count: 1,
			total: 3,
			offset: 1,
			limit: 1,
		};
		const { call, result } = await run(
			"list_corpora",
			{ tenant_id: IDS.tenant, offset: 1, limit: 1 },
			{ routes: { "GET /api/v1/corpora": page } },
		);
		expect(Object.fromEntries(call.query)).toEqual({ tenant_id: IDS.tenant, offset: "1", limit: "1" });
		const text = tool("list_corpora").render?.(result) ?? "";
		expect(text).toMatch(/tenant\s+docs\s+chunks\s+last activity/);
		expect(text).toContain("Acme");
		expect(text).toContain("corpora 2-2 of 3. More: --offset 2, or --all for every page");
		const whole = tool("list_corpora").render?.({ ...page, total: 1, offset: 0 }) ?? "";
		expect(whole).toContain("1 corpora");
		expect(whole).not.toContain("More:");
		expect(() => z.object(tool("list_corpora").input).parse({ limit: 501 })).toThrow();
	});

	it("pages through every corpus with all", async () => {
		const corpus = (n: number) => ({ id: `id-${n}`, name: `c${n}` });
		const pages: Record<string, unknown> = {
			"0": { items: [corpus(0), corpus(1)], count: 2, total: 5, offset: 0, limit: 2 },
			"2": { items: [corpus(2), corpus(3)], count: 2, total: 5, offset: 2, limit: 2 },
			"4": { items: [corpus(4)], count: 1, total: 5, offset: 4, limit: 2 },
		};
		const { calls, result } = await run(
			"list_corpora",
			{ all: true, limit: 2 },
			{ routes: { "GET /api/v1/corpora": (c: RecordedCall) => pages[c.query.get("offset") ?? ""] } },
		);
		expect(calls.map((c) => [c.query.get("offset"), c.query.get("limit")])).toEqual([
			["0", "2"],
			["2", "2"],
			["4", "2"],
		]);
		expect(result).toMatchObject({ count: 5, total: 5, offset: 0 });
		expect((result as { items: unknown[] }).items).toHaveLength(5);
		expect(tool("list_corpora").render?.(result)).toContain("5 corpora");

		// Without a limit, all asks for the engine's largest page, and stops on an empty one.
		const empty = await run(
			"list_corpora",
			{ all: true },
			{ routes: { "GET /api/v1/corpora": { items: [], count: 0, total: 7, offset: 0, limit: 500 } } },
		);
		expect(empty.calls).toHaveLength(1);
		expect(empty.call.query.get("limit")).toBe("500");
	});

	it("creates with an embedding model and moves a corpus to another tenant", async () => {
		// A tenant key creates for itself and may leave tenant_id out.
		const created = await run(
			"create_corpus",
			{ name: "lab", embedding_config: { provider: "tei", model: "BAAI/bge-m3" } },
			{ routes: { "POST /api/v1/corpora": createCorpusRoute(IDS.tenant) } },
		);
		expect(created.call.body).toEqual({ name: "lab", embedding_config: { provider: "tei", model: "BAAI/bge-m3" } });
		expect(created.result).toMatchObject({ tenant_id: IDS.tenant });
		const moved = await run(
			"update_corpus",
			{ corpus_id: IDS.corpus, tenant_id: IDS.tenant },
			{ routes: { [`PUT ${base}`]: {} } },
		);
		expect(moved.call.body).toEqual({ tenant_id: IDS.tenant });
	});

	it("every corpus keeps a tenant: no detach, and the engine's tenant_required comes through", async () => {
		const input = z.object(tool("update_corpus").input).strict();
		expect(() => input.parse({ corpus_id: IDS.corpus, tenant_id: null })).toThrow();
		expect(String(tool("create_corpus").input.tenant_id?.description)).toContain("Required with the admin key");
		await expect(
			run("create_corpus", { name: "orphan" }, { routes: { "POST /api/v1/corpora": createCorpusRoute() } }),
		).rejects.toThrow(/tenant_id is required/);
	});

	it("sends null to clear a field or reset a section, and keeps {} as a no-op", async () => {
		const cleared = await run(
			"update_corpus",
			{
				corpus_id: IDS.corpus,
				description: null,
				llm_config: { api_key: null, base_url: null, model: "gpt-4o-mini" },
				prompt_config: null,
				retrieval_config: {},
			},
			{ routes: { [`PUT ${base}`]: {} } },
		);
		expect(cleared.call.body).toEqual({
			description: null,
			llm_config: { api_key: null, base_url: null, model: "gpt-4o-mini" },
			prompt_config: null,
			retrieval_config: {},
		});
		// Null is not a value for name or the embedding section: the engine ignores it there.
		const input = z.object(tool("update_corpus").input).strict();
		expect(() => input.parse({ corpus_id: IDS.corpus, name: null })).toThrow();
		expect(() => input.parse({ corpus_id: IDS.corpus, embedding_config: null })).toThrow();
		expect(() => input.parse({ corpus_id: IDS.corpus, llm_config: { nope: null } })).toThrow();
		expect(String(tool("update_corpus").description)).toContain("null is removed");
	});

	it("rotates the key and deletes", async () => {
		const rotated = await run(
			"rotate_corpus_key",
			{ corpus_id: IDS.corpus },
			{ routes: { [`POST ${base}/rotate-key`]: { api_key: "ck_rotated" } } },
		);
		expect(rotated.result).toEqual({ api_key: "ck_rotated" });
		const deleted = await run(
			"delete_corpus",
			{ corpus_id: IDS.corpus, confirm_name: "acme-faq" },
			{ routes: { [`DELETE ${base}`]: reply(204) } },
		);
		expect(deleted.call.query.get("confirm_name")).toBe("acme-faq");
		expect(deleted.result).toEqual({ deleted: true, corpus_id: IDS.corpus });
	});

	it("needs the knowledge base's name to delete, and can preview what a delete removes", async () => {
		const input = z.object(tool("delete_corpus").input);
		expect(() => input.parse({ corpus_id: IDS.corpus })).toThrow();
		const preview = {
			kind: "knowledge_base",
			id: IDS.corpus,
			name: "acme-faq",
			confirm_name: "acme-faq",
			counts: { documents: 7, chunks: 120, widget_keys: 1, conversations: 4, memories: 0 },
			irreversible: true,
		};
		const { call, result } = await run(
			"preview_delete_corpus",
			{ corpus_id: IDS.corpus },
			{ routes: { [`GET ${base}/delete-preview`]: preview } },
		);
		expect(call.method).toBe("GET");
		expect(result).toEqual(preview);
		expect(tool("preview_delete_corpus").access).toBe("read");
	});
});

describe("widget keys", () => {
	const path = `/api/v1/corpora/${IDS.corpus}/widget-keys`;

	it("resolves a corpus key's own corpus through /whoami", async () => {
		const { call, all } = await run("list_widget_keys", {}, { surface: "cli", routes: { [`GET ${path}`]: [] } });
		expect(all[0]?.path).toBe("/api/v1/whoami");
		expect(call.path).toBe(path);
	});

	it("uses the known identity without another /whoami", async () => {
		const { all } = await run(
			"list_widget_keys",
			{},
			{ identity: WHOAMI.corpus as WhoAmI, routes: { [`GET ${path}`]: [] } },
		);
		expect(all.map((c) => c.path)).toEqual([path]);
	});

	it("creates with the spec's fields", async () => {
		const { call } = await run(
			"create_widget_key",
			{
				corpus_id: IDS.corpus,
				name: "Lab site",
				allowed_origins: ["https://lab.example"],
				rate_limit_per_minute: 5,
				appearance: { title: "Ask the lab", primary_color: "#0f766e" },
			},
			{ routes: { [`POST ${path}`]: reply(201, { id: IDS.key }) } },
		);
		expect(call.body).toEqual({
			name: "Lab site",
			allowed_origins: ["https://lab.example"],
			rate_limit_per_minute: 5,
			appearance: { title: "Ask the lab", primary_color: "#0f766e" },
		});
	});

	it("revokes with DELETE", async () => {
		const { call, result } = await run(
			"revoke_widget_key",
			{ corpus_id: IDS.corpus, key_id: IDS.key },
			{ routes: { [`DELETE ${path}/${IDS.key}`]: reply(204) } },
		);
		expect(call.method).toBe("DELETE");
		expect(result).toEqual({ revoked: true, key_id: IDS.key });
	});

	it("asks a tenant key for a corpus", async () => {
		await expect(
			run("list_widget_keys", {}, { identity: WHOAMI.tenant as WhoAmI, routes: { [`GET ${path}`]: [] } }),
		).rejects.toMatchObject({ code: "USAGE" });
	});
});

describe("tenants", () => {
	const base = "/api/v1/admin/tenants";

	it("lists, creates and rotates", async () => {
		expect((await run("list_tenants", {}, { routes: { [`GET ${base}`]: { items: [] } } })).call.path).toBe(base);
		const created = await run(
			"create_tenant",
			{ name: "Pune Path Lab", max_corpora: 3 },
			{ routes: { [`POST ${base}`]: reply(201, { api_key: "tk_x" }) } },
		);
		expect(created.call.body).toEqual({ name: "Pune Path Lab", max_corpora: 3 });
		const rotated = await run(
			"rotate_tenant_key",
			{ tenant_id: IDS.tenant },
			{ routes: { [`POST ${base}/${IDS.tenant}/rotate-key`]: { api_key: "tk_y" } } },
		);
		expect(rotated.call.method).toBe("POST");
	});

	it("filters and pages the list, and renders status and owners", async () => {
		const page = { items: [{ id: IDS.tenant, name: "Shree Labs", status: "pending", owner_emails: ["a@x.in"] }] };
		const { call, result } = await run(
			"list_tenants",
			{ status: "pending", search: "shree", offset: 100, limit: 50 },
			{ routes: { [`GET ${base}`]: { ...page, count: 1, total: 101, offset: 100, limit: 50 } } },
		);
		expect(Object.fromEntries(call.query)).toEqual({ status: "pending", search: "shree", offset: "100", limit: "50" });
		const text = tool("list_tenants").render?.(result) ?? "";
		expect(text).toContain("pending");
		expect(text).toContain("a@x.in");
		expect(() => z.object(tool("list_tenants").input as z.ZodRawShape).parse({ status: "gone" })).toThrow();
	});

	it("activates, suspends, reactivates, declines and deletes", async () => {
		const activated = await run(
			"activate_tenant",
			{ tenant_id: IDS.tenant, note: "paid via UPI" },
			{ routes: { [`POST ${base}/${IDS.tenant}/activate`]: { status: "active" } } },
		);
		expect(activated.call.body).toEqual({ note: "paid via UPI" });
		const suspended = await run(
			"suspend_tenant",
			{ tenant_id: IDS.tenant, confirm_name: "Shree Labs" },
			{ routes: { [`POST ${base}/${IDS.tenant}/suspend`]: { status: "suspended" } } },
		);
		expect(suspended.call.body).toEqual({ confirm_name: "Shree Labs" });
		const reactivated = await run(
			"reactivate_tenant",
			{ tenant_id: IDS.tenant },
			{ routes: { [`POST ${base}/${IDS.tenant}/reactivate`]: { status: "active" } } },
		);
		expect(reactivated.call.method).toBe("POST");
		const declined = await run(
			"decline_tenant",
			{ tenant_id: IDS.tenant, reason: "spam" },
			{ routes: { [`POST ${base}/${IDS.tenant}/decline`]: reply(204) } },
		);
		expect(declined.call.body).toEqual({ reason: "spam" });
		expect(declined.result).toEqual({ declined: true, tenant_id: IDS.tenant });
		const deleted = await run(
			"delete_tenant",
			{ tenant_id: IDS.tenant, confirm_name: "Shree Labs" },
			{ routes: { [`DELETE ${base}/${IDS.tenant}`]: reply(204) } },
		);
		expect(deleted.call.query.get("confirm_name")).toBe("Shree Labs");
		expect(deleted.result).toEqual({ deleted: true, tenant_id: IDS.tenant });
	});

	it("previews a tenant delete: counts and the name to confirm with", async () => {
		const preview = {
			kind: "customer",
			id: IDS.tenant,
			name: "Shree Labs",
			confirm_name: "Shree Labs",
			counts: { knowledge_bases: 2, documents: 14, chunks: 300, members: 3, api_keys: 4 },
			irreversible: true,
		};
		const { call, result } = await run(
			"preview_delete_tenant",
			{ tenant_id: IDS.tenant },
			{ routes: { [`GET ${base}/${IDS.tenant}/delete-preview`]: preview } },
		);
		expect(call.method).toBe("GET");
		expect(result).toEqual(preview);
		expect(tool("preview_delete_tenant").access).toBe("read");
		expect(tool("preview_delete_tenant").kinds).toEqual(["admin"]);
	});

	it("needs the typed name to suspend or delete", () => {
		for (const name of ["suspend_tenant", "delete_tenant"]) {
			expect(tool(name).access).toBe("destructive");
			expect(() => z.object(tool(name).input as z.ZodRawShape).parse({ tenant_id: IDS.tenant })).toThrow();
		}
	});

	it("activates on a plan and creates on a plan with a knowledge-base override", async () => {
		const activated = await run(
			"activate_tenant",
			{ tenant_id: IDS.tenant, plan_id: IDS.plan },
			{ routes: { [`POST ${base}/${IDS.tenant}/activate`]: { status: "active", plan_name: "Starter" } } },
		);
		expect(activated.call.body).toEqual({ plan_id: IDS.plan });
		expect(tool("activate_tenant").render?.(activated.result)).toContain("Starter");
		const created = await run(
			"create_tenant",
			{ name: "Shree Labs", plan_id: IDS.plan, max_corpora: 500 },
			{ routes: { [`POST ${base}`]: reply(201, { api_key: "tk_x" }) } },
		);
		expect(created.call.body).toEqual({ name: "Shree Labs", plan_id: IDS.plan, max_corpora: 500 });
	});
});

describe("team", () => {
	const team = {
		members: [
			{
				user_id: IDS.user,
				email: "asha@shree.example",
				name: "Asha",
				role: "owner",
				joined_at: "2026-09-30T10:00:00Z",
				last_login_at: null,
			},
		],
		invitations: [
			{
				id: IDS.invitation,
				email: "ravi@shree.example",
				role: "member",
				invited_by: "Asha",
				created_at: "2026-09-30T10:00:00Z",
				expires_at: "2026-10-07T10:00:00Z",
			},
		],
	};

	it("lists a tenant key's own team, or any tenant's with the admin key", async () => {
		const own = await run("list_team", {}, { routes: { "GET /api/v1/tenants/me/members": team } });
		expect(own.call.path).toBe("/api/v1/tenants/me/members");
		const text = tool("list_team").render?.(own.result) ?? "";
		expect(text).toContain("asha@shree.example");
		expect(text).toContain("ravi@shree.example");
		const admin = await run(
			"list_team",
			{ tenant_id: IDS.tenant },
			{ routes: { [`GET /api/v1/admin/tenants/${IDS.tenant}/members`]: team } },
		);
		expect(admin.call.path).toBe(`/api/v1/admin/tenants/${IDS.tenant}/members`);
		expect(tool("list_team").kinds).toEqual(["admin", "tenant"]);
	});

	it("invites a teammate with a tenant key (the link is e-mailed, never shown)", async () => {
		const { call, result } = await run(
			"invite_member",
			{ email: "ravi@shree.example" },
			{ routes: { "POST /api/v1/tenants/me/members": reply(201, team.invitations[0]) } },
		);
		expect(call.body).toEqual({ email: "ravi@shree.example", role: "member" });
		expect(tool("invite_member").kinds).toEqual(["tenant"]);
		expect(tool("invite_member").render?.(result)).toContain("e-mailed");
		expect(() => z.object(tool("invite_member").input).parse({ email: "not-an-address" })).toThrow();
	});

	it("invites into any tenant with the admin key and shows the link to send", async () => {
		const made = { ...team.invitations[0], role: "owner", accept_url: "http://dash/invite#token=inv_x" };
		const { call, result } = await run(
			"admin_invite",
			{ tenant_id: IDS.tenant, email: "owner@shree.example" },
			{ routes: { [`POST /api/v1/admin/tenants/${IDS.tenant}/invitations`]: reply(201, made) } },
		);
		expect(call.body).toEqual({ email: "owner@shree.example", role: "owner" });
		const text = tool("admin_invite").render?.(result) ?? "";
		expect(text).toContain("http://dash/invite#token=inv_x");
		expect(text).toContain("Send this link");
		expect(tool("admin_invite").kinds).toEqual(["admin"]);
	});
});

describe("plans", () => {
	const plan = {
		id: IDS.plan,
		name: "Starter",
		description: null,
		max_knowledge_bases: 1,
		monthly_questions: 1000,
		max_documents: null,
		max_widget_keys: 2,
		is_default: false,
		is_active: true,
		created_at: "2026-09-30T10:00:00Z",
		updated_at: "2026-09-30T10:00:00Z",
		tenant_count: 3,
	};

	it("lists plans with their limits", async () => {
		const { call, result } = await run(
			"list_plans",
			{ include_inactive: false },
			{ routes: { "GET /api/v1/admin/plans": { items: [plan], count: 1 } } },
		);
		expect(call.query.get("include_inactive")).toBe("false");
		const text = tool("list_plans").render?.(result) ?? "";
		expect(text).toContain("Starter");
		expect(text).toContain("unlimited");
		expect(text).toContain("1000");
		const all = await run("list_plans", {}, { routes: { "GET /api/v1/admin/plans": { items: [], count: 0 } } });
		expect(all.call.query.has("include_inactive")).toBe(false);
	});

	it("moves a tenant to a plan", async () => {
		const { call } = await run(
			"set_tenant_plan",
			{ tenant_id: IDS.tenant, plan_id: IDS.plan },
			{ routes: { [`POST /api/v1/admin/tenants/${IDS.tenant}/plan`]: { id: IDS.tenant, plan_id: IDS.plan } } },
		);
		expect(call.body).toEqual({ plan_id: IDS.plan });
		expect(tool("set_tenant_plan").access).toBe("write");
	});

	it("shows a tenant's plan and usage: its own, or any tenant's for the admin", async () => {
		const usage = {
			plan: plan,
			limits: { max_knowledge_bases: 1, monthly_questions: 1000, max_documents: null, max_widget_keys: 2 },
			usage: { month: "2026-09", questions: 998, knowledge_bases: 1, documents: 40, widget_keys: 1 },
			resets_at: "2026-10-01T00:00:00Z",
		};
		const own = await run("get_my_plan", {}, { routes: { "GET /api/v1/tenants/me/plan": usage } });
		expect(own.call.path).toBe("/api/v1/tenants/me/plan");
		const text = tool("get_my_plan").render?.(own.result) ?? "";
		expect(text).toContain("Plan: Starter");
		expect(text).toContain("998");
		expect(text).toContain("2026-10-01T00:00:00Z");
		const admin = await run(
			"get_my_plan",
			{ tenant_id: IDS.tenant },
			{ routes: { [`GET /api/v1/admin/tenants/${IDS.tenant}/plan`]: usage } },
		);
		expect(admin.call.path).toBe(`/api/v1/admin/tenants/${IDS.tenant}/plan`);
	});

	it("reads the question cap's reset time from the engine's 429", async () => {
		const capped = reply(429, {
			detail: "Monthly question limit reached",
			code: "question_cap_reached",
			limit: 1000,
			used: 1000,
			resets_at: "2026-10-01T00:00:00Z",
		});
		const err = await run("ask", { query: "q" }, { routes: { "POST /api/v1/query": capped } }).catch((e) => e);
		expect((err as { code: string }).code).toBe("LIMIT");
		expect((err as Error).message).toMatch(/questions its plan allows this month; they reset at 2026-10-01/);
	});
});

describe("engine settings", () => {
	const settings = {
		signup_mode: "approval",
		branding: {
			product_name: "Sahayak AI",
			logo_url: null,
			primary_color: "#0a7d5a",
			support_email: null,
			contact_text: "Contact us for pricing",
			contact_url: null,
		},
		updated_at: "2026-09-30T10:00:00Z",
		updated_by: "admin key",
	};

	it("gets and patches /api/v1/admin/settings", async () => {
		const got = await run("get_settings", {}, { routes: { "GET /api/v1/admin/settings": settings } });
		expect(got.call.method).toBe("GET");
		expect(tool("get_settings").render?.(got.result)).toContain("Sahayak AI");
		const patched = await run(
			"update_settings",
			{ signup_mode: "open", branding: { product_name: "Sahayak AI", logo_url: null } },
			{ routes: { "PATCH /api/v1/admin/settings": { ...settings, signup_mode: "open" } } },
		);
		expect(patched.call.body).toEqual({
			signup_mode: "open",
			branding: { product_name: "Sahayak AI", logo_url: null },
		});
		const reset = await run(
			"update_settings",
			{ branding: null },
			{ routes: { "PATCH /api/v1/admin/settings": settings } },
		);
		expect(reset.call.body).toEqual({ branding: null });
		expect(tool("update_settings").kinds).toEqual(["admin"]);
	});

	it("refuses an empty update, an unknown mode, a bad colour and powered_by", async () => {
		await expect(run("update_settings", {}, { routes: {} })).rejects.toThrow(/Nothing to update/);
		const input = z.object(tool("update_settings").input as z.ZodRawShape).strict();
		expect(() => input.parse({ signup_mode: "invite-only" })).toThrow();
		expect(() => input.parse({ branding: { primary_color: "green" } })).toThrow();
		expect(() => input.parse({ branding: { powered_by: "x" } })).toThrow();
		expect(() => input.parse({ powered_by: { text: "x" } })).toThrow();
	});
});

describe("engine info", () => {
	it("GETs /api/v1/info and prints it flat", async () => {
		const info = {
			version: "0.2.0",
			features: {
				content_portal: false,
				streaming: true,
				transcription: { enabled: false, provider: "off" },
				reranker: { local: false, llm: true, default_provider: "local", enabled_by_default: false },
				web_search: { enabled: false, provider: "none" },
			},
			embedding: { provider: "tei", model: "BAAI/bge-small-en-v1.5", dimensions: 384 },
			llm: { provider: "openai", model: "gpt-4o-mini", fast_model: null, key_configured: true },
			public_url: "http://127.0.0.1:8000",
			public_url_configured: false,
			limits: {
				max_upload_bytes: 52428800,
				max_upload_tokens: 500000,
				allowed_mime_types: ["application/pdf", "text/plain"],
				allowed_extensions: [".pdf", ".txt"],
				max_records_per_request: 1000,
				max_record_chars: 200000,
				max_query_chars: 2000,
			},
		};
		const { call, result } = await run("get_engine_info", {}, { routes: { "GET /api/v1/info": info } });
		expect(call.path).toBe("/api/v1/info");
		expect(result).toEqual(info);
		const text = tool("get_engine_info").render?.(result) ?? "";
		expect(text).toMatch(/^features\.transcription\.provider\s+off$/m);
		expect(text).toMatch(/^limits\.allowed_extensions\s+\.pdf, \.txt$/m);
		expect(text).toMatch(/^llm\.fast_model\s+-$/m);
	});
});

describe("my tenant", () => {
	it("reads /api/v1/tenants/me", async () => {
		const me = {
			id: IDS.tenant,
			name: "Acme",
			description: null,
			corpus_count: 2,
			max_corpora: 10,
			is_active: true,
			created_at: "2026-09-29",
		};
		const { call, result } = await run(
			"get_my_tenant",
			{},
			{ identity: WHOAMI.tenant as WhoAmI, routes: { "GET /api/v1/tenants/me": me } },
		);
		expect(call.method).toBe("GET");
		expect(call.path).toBe("/api/v1/tenants/me");
		expect(tool("get_my_tenant").render?.(result)).toMatch(/^max_corpora\s+10$/m);
	});

	it("rotates its own key with POST and returns the new key, marked as replacing the key in use", async () => {
		const { call, result } = await run(
			"rotate_my_tenant_key",
			{},
			{ identity: WHOAMI.tenant as WhoAmI, routes: { "POST /api/v1/tenants/me/rotate-key": { api_key: "tk_new" } } },
		);
		expect(call.method).toBe("POST");
		expect(call.path).toBe("/api/v1/tenants/me/rotate-key");
		expect(call.body).toBeUndefined();
		expect(result).toEqual({ api_key: "tk_new" });
		const t = tool("rotate_my_tenant_key");
		expect(t.access).toBe("destructive");
		expect(t.replacesOwnKey).toBe(true);
		expect(t.kinds).toEqual(["tenant"]);
		expect(t.description).toContain("stops working immediately");
	});
});

describe("feedback", () => {
	const routes = { "GET /api/v1/feedback": { items: [], total: 0, offset: 0, limit: 20 } };

	it("passes every filter as a query parameter", async () => {
		const { call } = await run(
			"list_feedback",
			{
				corpus_id: IDS.corpus,
				min_rating: 1,
				max_rating: 2,
				start: "2026-09-01",
				end: "2026-09-30T00:00:00Z",
				offset: 20,
				limit: 10,
			},
			{ routes, identity: WHOAMI.admin as WhoAmI },
		);
		expect(call.path).toBe("/api/v1/feedback");
		expect(Object.fromEntries(call.query)).toEqual({
			corpus_id: IDS.corpus,
			min_rating: "1",
			max_rating: "2",
			start: "2026-09-01",
			end: "2026-09-30T00:00:00Z",
			offset: "20",
			limit: "10",
		});
	});

	it("applies no default corpus, and refuses bad ranges and dates before calling the engine", async () => {
		const plain = await run(
			"list_feedback",
			{},
			{ routes, identity: WHOAMI.tenant as WhoAmI, config: { corpusId: IDS.other } },
		);
		expect([...plain.call.query.keys()]).toEqual([]);
		await expect(run("list_feedback", { min_rating: 4, max_rating: 2 }, { routes })).rejects.toMatchObject({
			code: "USAGE",
		});
		const input = z.object(tool("list_feedback").input);
		expect(() => input.parse({ min_rating: 0 })).toThrow();
		expect(() => input.parse({ max_rating: 6 })).toThrow();
		expect(() => input.parse({ start: "30/09/2026" })).toThrow();
		expect(() => input.parse({ limit: 101 })).toThrow();
	});

	it("renders ratings with their questions and the page", () => {
		const text =
			tool("list_feedback").render?.({
				items: [
					{
						id: IDS.key,
						query_id: IDS.job,
						corpus_id: IDS.corpus,
						question: "How long do I fast?",
						rating: 2,
						correction: "10-12 hours",
						feedback_type: "explicit",
						session_id: null,
						created_at: "2026-09-29",
					},
				],
				total: 1,
				offset: 0,
				limit: 20,
			}) ?? "";
		expect(text).toContain("How long do I fast?");
		expect(text).toContain("1 rating(s)");
	});
});

describe("migrations", () => {
	it("lists with filters and paging", async () => {
		const migration = {
			id: IDS.key,
			corpus_id: IDS.corpus,
			strategy: "blue_green",
			status: "pending_approval",
			from_config: { provider: "tei", model: "a" },
			to_config: { provider: "tei", model: "BAAI/bge-m3" },
			old_collection: "c1",
			new_collection: "c2",
			chunks_total: 10,
			chunks_done: 0,
			memories_total: 0,
			memories_done: 0,
			created_at: "2026-09-29",
		};
		const { call, result } = await run(
			"list_migrations",
			{ corpus_id: IDS.corpus, status: "pending_approval", offset: 0, limit: 5 },
			{
				identity: WHOAMI.tenant as WhoAmI,
				routes: { "GET /api/v1/migrations": { items: [migration], total: 6, offset: 0, limit: 5 } },
			},
		);
		expect(call.path).toBe("/api/v1/migrations");
		expect(Object.fromEntries(call.query)).toEqual({
			corpus_id: IDS.corpus,
			status: "pending_approval",
			offset: "0",
			limit: "5",
		});
		const text = tool("list_migrations").render?.(result) ?? "";
		expect(text).toContain("tei / BAAI/bge-m3");
		expect(text).toContain("0/10");
		expect(text).toContain("migration(s) 1-1 of 6. More: --offset 1");
		expect(tool("list_migrations").kinds).toEqual(["admin", "tenant"]);
		expect(() => z.object(tool("list_migrations").input).parse({ limit: 201 })).toThrow();
	});
});

describe("assistant", () => {
	const path = `/api/v1/corpora/${IDS.corpus}/assistant`;
	const state = (draftRevision: number | null) => ({
		enabled: true,
		published: { version: 1 },
		draft: draftRevision === null ? null : { draft_revision: draftRevision },
	});

	it("reads the state", async () => {
		const { call, result } = await run(
			"get_assistant",
			{ corpus_id: IDS.corpus },
			{ routes: { [`GET ${path}`]: state(null) } },
		);
		expect(call.method).toBe("GET");
		expect(call.path).toBe(path);
		expect(result).toMatchObject({ enabled: true });
	});

	it("patches the draft with the current revision when none is given", async () => {
		const { calls, result } = await run(
			"update_assistant_draft",
			{ corpus_id: IDS.corpus, patch: { voice: { emoji: "light" } } },
			{
				routes: {
					[`GET ${path}`]: state(2),
					[`PATCH ${path}/draft`]: { status: "draft", draft_revision: 3 },
				},
			},
		);
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${path}`, `PATCH ${path}/draft`]);
		expect(calls[1]?.body).toEqual({ patch: { voice: { emoji: "light" } }, base_revision: 2 });
		expect(result).toMatchObject({ status: "draft", draft_revision: 3 });
	});

	it("uses the revision the caller read, without another read", async () => {
		const { calls } = await run(
			"update_assistant_draft",
			{ corpus_id: IDS.corpus, patch: { identity: { business_name: null } }, base_revision: 5 },
			{ routes: { [`PATCH ${path}/draft`]: { status: "draft", draft_revision: 6 } } },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({ patch: { identity: { business_name: null } }, base_revision: 5 });
	});

	it("surfaces a stale draft as the engine's conflict", async () => {
		await expect(
			run(
				"update_assistant_draft",
				{ corpus_id: IDS.corpus, patch: {}, base_revision: 1 },
				{
					routes: {
						[`PATCH ${path}/draft`]: reply(409, {
							detail: "Someone else changed this draft",
							code: "assistant_draft_conflict",
							current_revision: 4,
						}),
					},
				},
			),
		).rejects.toMatchObject({
			code: "VALIDATION",
			status: 409,
			message: expect.stringContaining("Someone else changed this draft"),
		});
	});

	it("publishes the draft at its current revision, with the note", async () => {
		const { calls, result } = await run(
			"publish_assistant",
			{ corpus_id: IDS.corpus, note: "via agent" },
			{
				routes: {
					[`GET ${path}`]: state(1),
					[`POST ${path}/publish`]: { status: "published", version: 2 },
				},
			},
		);
		expect(calls[1]?.body).toEqual({ base_revision: 1, note: "via agent" });
		expect(result).toMatchObject({ status: "published", version: 2 });
	});

	it("publishes the revision the caller reviewed and surfaces a stale one as the engine's conflict", async () => {
		const ok = await run(
			"publish_assistant",
			{ corpus_id: IDS.corpus, base_revision: 3 },
			{ routes: { [`POST ${path}/publish`]: { status: "published", version: 3 } } },
		);
		expect(ok.calls).toHaveLength(1);
		expect(ok.calls[0]?.body).toEqual({ base_revision: 3 });
		await expect(
			run(
				"publish_assistant",
				{ corpus_id: IDS.corpus, base_revision: 3 },
				{
					routes: {
						[`POST ${path}/publish`]: reply(409, {
							detail: "Someone else changed this draft",
							code: "assistant_draft_conflict",
							current_revision: 4,
						}),
					},
				},
			),
		).rejects.toMatchObject({ code: "VALIDATION", status: 409 });
	});

	it("resolves a corpus key's own corpus and needs a corpus for a tenant key", async () => {
		const own = await run("get_assistant", {}, { routes: { [`GET ${path}`]: state(null) } });
		expect(own.call.path).toBe(path);
		await expect(
			run("get_assistant", {}, { identity: WHOAMI.tenant as WhoAmI, routes: { [`GET ${path}`]: state(null) } }),
		).rejects.toMatchObject({ code: "USAGE" });
	});

	it("is offered to every key kind and is never destructive", () => {
		for (const name of ["get_assistant", "update_assistant_draft", "publish_assistant"]) {
			const t = tool(name);
			expect(t.kinds).toEqual(["admin", "tenant", "corpus"]);
			expect(t.access).not.toBe("destructive");
		}
		expect(tool("get_assistant").access).toBe("read");
		expect(tool("update_assistant_draft").access).toBe("write");
		expect(tool("publish_assistant").access).toBe("write");
	});
});

describe("leads", () => {
	const lead = {
		id: IDS.doc,
		corpus_id: IDS.corpus,
		knowledge_base: "Patient help",
		contact: { name: "Priya Kulkarni", phone: "+919876543210", email: null, custom: {} },
		status: "new",
		trigger: "buying_intent",
		tags: [],
		created_at: "2026-10-14T09:12:02Z",
	};

	it("lists with filters, for tenant and admin keys that may write", async () => {
		const { call, result } = await run(
			"list_leads",
			{ status: "new", q: "+919876543210", limit: 10 },
			{
				identity: WHOAMI.tenant,
				routes: { "GET /api/v1/leads": { items: [lead], total: 1, offset: 0, limit: 10 } },
			},
		);
		expect(call.path).toBe("/api/v1/leads");
		expect(call.query.get("status")).toBe("new");
		expect(call.query.get("limit")).toBe("10");
		expect((result as { total: number }).total).toBe(1);
		for (const name of ["list_leads", "export_leads"]) expect(tool(name).kinds).not.toContain("corpus");
		expect(tool("list_leads").access).toBe("write");
		expect(tool("export_leads").access).toBe("write");
	});

	it("renders a table with the count", () => {
		const text = tool("list_leads").render?.({ items: [lead], total: 3, offset: 0, limit: 25 });
		expect(text).toContain("Priya Kulkarni");
		expect(text).toContain("1 of 3");
	});

	it("exports CSV text", async () => {
		const { call, result } = await run(
			"export_leads",
			{ corpus_id: IDS.corpus },
			{ identity: WHOAMI.tenant, routes: { "GET /api/v1/leads/export.csv": "﻿created_at,knowledge_base\n" } },
		);
		expect(call.query.get("corpus_id")).toBe(IDS.corpus);
		expect(String(result)).toContain("created_at");
	});
});

describe("every tool", () => {
	it("is covered by a test above", () => {
		const covered = [
			"get_assistant",
			"update_assistant_draft",
			"publish_assistant",
			"whoami",
			"get_engine_info",
			"get_document",
			"list_feedback",
			"list_migrations",
			"get_my_tenant",
			"rotate_my_tenant_key",
			"search",
			"ask",
			"list_documents",
			"list_document_versions",
			"delete_document",
			"preview_delete_document",
			"preview_delete_corpus",
			"preview_delete_tenant",
			"add_records",
			"upload_file",
			"get_ingest_job",
			"list_ingest_jobs",
			"get_usage",
			"list_leads",
			"export_leads",
			"get_corpus_settings",
			"update_corpus_settings",
			"list_corpora",
			"get_corpus",
			"create_corpus",
			"update_corpus",
			"rotate_corpus_key",
			"delete_corpus",
			"list_widget_keys",
			"create_widget_key",
			"revoke_widget_key",
			"list_tenants",
			"create_tenant",
			"rotate_tenant_key",
			"activate_tenant",
			"suspend_tenant",
			"reactivate_tenant",
			"decline_tenant",
			"delete_tenant",
			"list_team",
			"invite_member",
			"admin_invite",
			"list_plans",
			"set_tenant_plan",
			"get_my_plan",
			"get_settings",
			"update_settings",
		];
		expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual([...covered].sort());
	});
});
