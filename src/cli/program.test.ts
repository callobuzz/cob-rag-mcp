import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toCobRagError } from "../core/errors.js";
import { fakeEngine, IDS, type RecordedCall, reply, STREAM_EVENTS, sse, WHOAMI } from "../test/fake-engine.js";
import type { CliIO } from "./io.js";
import { buildProgram } from "./program.js";

const KEY = "ck_clitestclitest4321";

interface RunResult {
	out: string;
	err: string;
	error?: { code: string; message: string };
	engine: ReturnType<typeof fakeEngine>;
	prompts: string[];
}

async function cli(
	args: string[],
	options: {
		routes?: Record<string, unknown>;
		env?: NodeJS.ProcessEnv;
		interactive?: boolean;
		answer?: string;
		/** One answer per prompt, in order; takes precedence over `answer`. */
		answers?: string[];
		configPath?: string;
		/** Sees each io.write call (streamed tokens) as it happens. */
		onWrite?: (text: string) => void;
	} = {},
): Promise<RunResult> {
	const engine = fakeEngine({ "GET /api/v1/whoami": WHOAMI.corpus, ...options.routes });
	let out = "";
	let err = "";
	const prompts: string[] = [];
	const configPath = options.configPath ?? join(mkdtempSync(join(tmpdir(), "cob-rag-cli-")), "config.json");
	const io: CliIO = {
		out: (t) => {
			out += t.endsWith("\n") ? t : `${t}\n`;
		},
		write: (t) => {
			options.onWrite?.(t);
			out += t;
		},
		err: (t) => {
			err += `${t}\n`;
		},
		interactive: options.interactive ?? false,
		prompt: async (q) => {
			prompts.push(q);
			if (options.answers) return options.answers[prompts.length - 1] ?? "";
			return options.answer ?? "";
		},
		env: { COB_RAG_CONFIG: configPath, ...(options.env ?? { COB_RAG_API_KEY: KEY }) },
		fetch: engine.fetch,
	};
	const program = buildProgram(io).exitOverride();
	let error: RunResult["error"];
	try {
		await program.parseAsync(["node", "cob-rag-engine", ...args]);
	} catch (e) {
		const ce = toCobRagError(e);
		error = { code: ce.code, message: ce.message };
	}
	return { out, err, error, engine, prompts };
}

describe("CLI output", () => {
	it("prints whoami as a readable table, and as JSON with --json", async () => {
		const table = await cli(["whoami"]);
		expect(table.out).toMatch(/^kind\s+corpus$/m);
		expect(table.out).toMatch(/^corpus_name\s+acme-faq$/m);
		const json = await cli(["whoami", "--json"]);
		expect(JSON.parse(json.out)).toMatchObject({ kind: "corpus", corpus_name: "acme-faq" });
	});

	it("takes the search query positionally and prints passages with sources", async () => {
		const r = await cli(["search", "fasting before lipid test", "--final-k", "2", "--search-mode", "hybrid"], {
			routes: {
				"POST /api/v1/query/retrieve": {
					chunks: [
						{
							chunk_id: "c",
							text: "Fast 10-12 hours.",
							score: 0.8,
							token_count: 4,
							external_id: "faq-lipid",
							section: "Fasting",
						},
					],
					processed_query: "fasting",
					latency_ms: 12,
					total_chunks: 1,
				},
			},
		});
		expect(r.error).toBeUndefined();
		expect(r.engine.last().body).toEqual({
			query: "fasting before lipid test",
			options: { final_k: 2, search_mode: "hybrid" },
		});
		expect(r.out).toContain("[1] faq-lipid > Fasting  (score 0.800)");
		expect(r.out).toContain("Fast 10-12 hours.");
	});

	it("prints an answer with its sources", async () => {
		const r = await cli(["ask", "How long do I fast?"], {
			routes: {
				"POST /api/v1/query": {
					answer: "Fast for 10-12 hours [1].",
					confidence: 0.87,
					query_id: IDS.job,
					model_used: "qwen2.5:3b",
					latency_ms: 900,
					citations: [{ chunk_id: "c", text_snippet: "x", score: 0.9, external_id: "faq-lipid", section: "Fasting" }],
				},
			},
		});
		expect(r.out).toContain("Fast for 10-12 hours [1].");
		expect(r.out).toContain("Sources:\n  [1] faq-lipid > Fasting");
		expect(r.out).toContain("confidence 0.87 | qwen2.5:3b");
	});

	it("streams an answer with --stream, then its sources and the model and latency", async () => {
		const printed: string[] = [];
		const r = await cli(["ask", "q", "--stream"], {
			routes: { "POST /api/v1/query/stream": sse(STREAM_EVENTS) },
			onWrite: (t) => printed.push(t),
		});
		expect(r.error).toBeUndefined();
		// Tokens are written as they arrive, without newlines of their own.
		expect(printed.slice(0, 2)).toEqual(["Fast for ", "10-12 hours [1]."]);
		expect(r.out).toBe(
			"Fast for 10-12 hours [1].\n" +
				"\n" +
				"Sources:\n" +
				"  [1] Fasting [faq-lipid]\n" +
				"  [2] prep.pdf > Thyroid > p. 3\n" +
				"\n" +
				"qwen2.5:3b | 950 ms\n",
		);
	});

	it("prints one JSON event per line with --stream --json", async () => {
		const r = await cli(["ask", "q", "--stream", "--json"], {
			routes: { "POST /api/v1/query/stream": sse(STREAM_EVENTS) },
		});
		const lines = r.out.trim().split("\n");
		expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(["sources", "token", "token", "done"]);
		expect(JSON.parse(lines[0] as string)).toEqual({ event: "sources", data: STREAM_EVENTS[0]?.[1] });
	});

	it("ends the partial answer's line and reports an error event", async () => {
		const r = await cli(["ask", "q", "--stream"], {
			routes: {
				"POST /api/v1/query/stream": sse([
					STREAM_EVENTS[0] as [string, unknown],
					["token", { content: "Fast for" }],
					["error", { detail: "Generation failed part-way; the answer is incomplete." }],
				]),
			},
		});
		expect(r.out).toBe("Fast for\n");
		expect(r.error?.code).toBe("ENGINE_ERROR");
		expect(r.error?.message).toContain("Generation failed part-way; the answer is incomplete.");
	});

	it("reports an HTTP error from /query/stream before anything is printed", async () => {
		const r = await cli(["ask", "q", "--stream"], {
			routes: { "POST /api/v1/query/stream": reply(502, { detail: "Vector store unavailable" }) },
		});
		expect(r.out).toBe("");
		expect(r.error).toMatchObject({ code: "ENGINE_ERROR" });
		expect(r.error?.message).toContain("HTTP 502: Vector store unavailable");
	});

	it("prints lists as tables", async () => {
		const r = await cli(["documents", "list"], {
			routes: {
				"GET /api/v1/documents": {
					items: [
						{
							id: IDS.doc,
							file_name: "prep.pdf",
							mime_type: "application/pdf",
							size_bytes: 10,
							ingested_at: "2026-09-29",
							version_count: 1,
						},
					],
					count: 1,
				},
			},
		});
		expect(r.out).toMatch(/^id\s+file_name\s+record id\s+mime_type/m);
		expect(r.out).toContain("prep.pdf");
		expect(r.out).toContain("1 document(s)");
	});
});

describe("CLI input", () => {
	it("reads records from @file, as JSON or JSON lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cob-rag-rec-"));
		writeFileSync(join(dir, "r.jsonl"), '{"id":"a","text":"one"}\n{"id":"b","text":"two"}\n');
		const r = await cli(["ingest", "records", "--records", `@${join(dir, "r.jsonl")}`], {
			routes: { "POST /api/v1/ingest/records": { job_id: IDS.job, status: "queued", records: 2 } },
		});
		expect(r.error).toBeUndefined();
		expect(r.engine.last().body).toEqual({
			records: [
				{ id: "a", text: "one" },
				{ id: "b", text: "two" },
			],
		});
	});

	it("splits comma-separated lists", async () => {
		const r = await cli(
			["widget-keys", "create", "Lab site", "--allowed-origins", "https://a.example, https://b.example"],
			{
				routes: {
					[`POST /api/v1/corpora/${IDS.corpus}/widget-keys`]: reply(201, { id: IDS.key, embed_snippet: "<s>" }),
				},
			},
		);
		expect(r.error).toBeUndefined();
		expect(r.engine.last().body).toMatchObject({ allowed_origins: ["https://a.example", "https://b.example"] });
	});

	it("explains invalid input by flag name, without calling the engine", async () => {
		const r = await cli(["documents", "versions", "not-a-uuid"]);
		expect(r.error?.code).toBe("USAGE");
		expect(r.error?.message).toContain("--document-id: Invalid uuid");
		expect(r.engine.calls).toHaveLength(0);
	});

	it("asks for a key when none is configured", async () => {
		const r = await cli(["whoami"], { env: {} });
		expect(r.error?.code).toBe("CONFIG");
		expect(r.error?.message).toContain("cob-rag-engine login");
	});
});

describe("CLI safety", () => {
	const del = { [`DELETE /api/v1/documents/${IDS.doc}`]: reply(204) };

	it("refuses a destructive command without --yes when not at a terminal", async () => {
		const r = await cli(["documents", "delete", IDS.doc, "policy.pdf"], { routes: del });
		expect(r.error?.code).toBe("REFUSED");
		expect(r.error?.message).toContain("--yes");
		expect(r.engine.calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("runs it with --yes", async () => {
		const r = await cli(["documents", "delete", IDS.doc, "policy.pdf", "--yes"], { routes: del });
		expect(r.error).toBeUndefined();
		expect(r.engine.last().method).toBe("DELETE");
		expect(r.engine.last().query.get("confirm_name")).toBe("policy.pdf");
	});

	it("asks at a terminal, and stops on anything but yes", async () => {
		const no = await cli(["documents", "delete", IDS.doc, "policy.pdf"], {
			routes: del,
			interactive: true,
			answer: "n",
		});
		expect(no.prompts[0]).toContain("cannot be undone");
		expect(no.error?.message).toBe("Cancelled.");
		expect(no.engine.calls.some((c) => c.method === "DELETE")).toBe(false);

		const yes = await cli(["documents", "delete", IDS.doc, "policy.pdf"], {
			routes: del,
			interactive: true,
			answer: "y",
		});
		expect(yes.engine.last().method).toBe("DELETE");
	});

	it("read-only mode refuses writes but allows reads", async () => {
		const write = await cli(["--read-only", "ingest", "records", "--records", '[{"id":"a","text":"t"}]']);
		expect(write.error?.code).toBe("REFUSED");
		expect(write.engine.calls).toHaveLength(0);

		const envWrite = await cli(["documents", "delete", IDS.doc, "policy.pdf", "--yes"], {
			env: { COB_RAG_API_KEY: KEY, COB_RAG_READ_ONLY: "true" },
		});
		expect(envWrite.error?.code).toBe("REFUSED");

		const read = await cli(["--read-only", "whoami"]);
		expect(read.error).toBeUndefined();
	});
});

describe("login and config", () => {
	it("validates the key with /whoami, then saves it", async () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "cob-rag-login-")), "config.json");
		const r = await cli(["login", "--url", "http://rag.internal:8000", "--key", KEY], { env: {}, configPath });
		expect(r.error).toBeUndefined();
		expect(r.engine.calls[0]?.headers["x-api-key"]).toBe(KEY);
		expect(r.out).toContain("ck_****4321");
		expect(r.out).not.toContain(KEY);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ url: "http://rag.internal:8000", api_key: KEY });
	});

	it("does not save a key the engine rejects", async () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "cob-rag-login-")), "config.json");
		const r = await cli(["login", "--key", "ck_badbadbadbadbad"], {
			env: {},
			configPath,
			routes: { "GET /api/v1/whoami": reply(401, { detail: "Invalid API key" }) },
		});
		expect(r.error?.code).toBe("UNAUTHORIZED");
		expect(() => readFileSync(configPath)).toThrow();
	});

	it("config set/get/show masks secrets; get --reveal shows them", async () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "cob-rag-cfg-")), "config.json");
		const set = await cli(["config", "set", "llm_api_key", "sk-verysecretvalue77"], { env: {}, configPath });
		expect(set.out).toContain("llm_api_key = ****ue77");
		expect(set.out).not.toContain("verysecret");

		const show = await cli(["config", "show"], { env: {}, configPath });
		expect(show.out).toMatch(/llm_api_key\s+\*\*\*\*ue77\s+file/);
		expect(show.out).not.toContain("verysecret");

		const get = await cli(["config", "get", "llm_api_key"], { env: {}, configPath });
		expect(get.out.trim()).toBe("****ue77");
		const reveal = await cli(["config", "get", "llm_api_key", "--reveal"], { env: {}, configPath });
		expect(reveal.out.trim()).toBe("sk-verysecretvalue77");

		await cli(["config", "unset", "llm_api_key"], { env: {}, configPath });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({});
	});

	it("rejects unknown settings and bad values", async () => {
		expect((await cli(["config", "set", "colour", "blue"], { env: {} })).error?.code).toBe("USAGE");
		expect((await cli(["config", "set", "url", "nope"], { env: {} })).error?.code).toBe("CONFIG");
	});

	it("lists tools with the key kinds that see them", async () => {
		const r = await cli(["tools"]);
		expect(r.out).toMatch(/^list_tenants\s+tenants list\s+admin\s+read$/m);
		expect(r.out).toMatch(/^delete_document\s+documents delete\s+admin, tenant, corpus\s+destructive$/m);
		expect(r.out).toMatch(/^rotate_my_tenant_key\s+tenants rotate-my-key\s+tenant\s+destructive$/m);
		expect(r.out).toMatch(/^list_migrations\s+migrations list\s+admin, tenant\s+read$/m);
	});
});

describe("paged lists", () => {
	const TENANT_KEY = "tk_clitestclitest9876";
	const corpus = (n: number) => ({
		id: `00000000-0000-4000-8000-00000000000${n}`,
		name: `c${n}`,
		description: null,
		qdrant_collection: "q",
		created_at: "2026-09-29",
		tenant_name: "Acme",
		document_count: n,
		chunk_count: n * 10,
		last_activity_at: null,
	});

	it("says when more corpora exist and how to get them", async () => {
		const r = await cli(["corpora", "list", "--limit", "2"], {
			env: { COB_RAG_API_KEY: TENANT_KEY },
			routes: { "GET /api/v1/corpora": { items: [corpus(1), corpus(2)], count: 2, total: 5, offset: 0, limit: 2 } },
		});
		expect(r.error).toBeUndefined();
		expect(r.engine.last().query.get("limit")).toBe("2");
		expect(r.out).toContain("corpora 1-2 of 5. More: --offset 2, or --all for every page");
	});

	it("pages through every corpus with --all", async () => {
		const pages: Record<string, unknown> = {
			"0": { items: [corpus(1), corpus(2)], count: 2, total: 3, offset: 0, limit: 2 },
			"2": { items: [corpus(3)], count: 1, total: 3, offset: 2, limit: 2 },
		};
		const r = await cli(["corpora", "list", "--all", "--limit", "2", "--tenant-id", IDS.tenant], {
			env: { COB_RAG_API_KEY: TENANT_KEY },
			routes: { "GET /api/v1/corpora": (c: RecordedCall) => pages[c.query.get("offset") ?? ""] },
		});
		expect(r.error).toBeUndefined();
		expect(r.engine.calls.map((c) => c.query.get("offset"))).toEqual(["0", "2"]);
		expect(r.engine.calls.every((c) => c.query.get("tenant_id") === IDS.tenant)).toBe(true);
		expect(r.out).toContain("c3");
		expect(r.out).toContain("3 corpora");
		expect(r.out).not.toContain("More:");
	});

	it("lists a corpus's documents with a tenant key and --corpus-id", async () => {
		const r = await cli(["documents", "list", "--corpus-id", IDS.corpus, "--search", "faq"], {
			env: { COB_RAG_API_KEY: TENANT_KEY },
			routes: { "GET /api/v1/documents": { items: [], count: 0 } },
		});
		expect(r.error).toBeUndefined();
		expect(Object.fromEntries(r.engine.last().query)).toEqual({ corpus_id: IDS.corpus, search: "faq" });
		expect(r.out).toContain("0 document(s)");
	});

	it("filters ingest jobs from the command line", async () => {
		const r = await cli(["ingest", "jobs", "--status", "failed", "--offset", "20", "--limit", "10"], {
			routes: { "GET /api/v1/ingest/jobs": { items: [], count: 0, total: 20, offset: 20, limit: 10 } },
		});
		expect(r.error).toBeUndefined();
		expect(Object.fromEntries(r.engine.last().query)).toEqual({ status: "failed", offset: "20", limit: "10" });
		expect(r.out).toContain("No job(s) at offset 20 (20 in all).");
	});
});

describe("rotating my own tenant key", () => {
	const OLD = "tk_oldoldoldold1111";
	const NEW = "tk_newnewnewnew2222";
	const routes = { "POST /api/v1/tenants/me/rotate-key": { api_key: NEW } };

	function savedConfig(key = OLD): string {
		const configPath = join(mkdtempSync(join(tmpdir(), "cob-rag-rot-")), "config.json");
		writeFileSync(configPath, JSON.stringify({ url: "http://127.0.0.1:8000", api_key: key }));
		return configPath;
	}

	it("refuses without --yes when not at a terminal, after warning that the key in use dies", async () => {
		const configPath = savedConfig();
		const r = await cli(["tenants", "rotate-my-key"], { env: {}, configPath, routes });
		expect(r.error?.code).toBe("REFUSED");
		expect(r.err).toContain("stops working immediately");
		expect(r.err).toContain(configPath);
		expect(r.err).not.toContain(OLD);
		expect(r.engine.calls).toHaveLength(0);
	});

	it("with --yes, prints the new key and says the saved key no longer works", async () => {
		const configPath = savedConfig();
		const r = await cli(["tenants", "rotate-my-key", "--yes"], { env: {}, configPath, routes });
		expect(r.error).toBeUndefined();
		expect(r.engine.last().headers["x-api-key"]).toBe(OLD);
		expect(r.out).toContain(NEW);
		expect(r.err).toContain(`The key saved in ${configPath} no longer works`);
		expect(JSON.parse(readFileSync(configPath, "utf8")).api_key).toBe(OLD);
	});

	it("saves the new key with --save-key, keeping the other settings", async () => {
		const configPath = savedConfig();
		const r = await cli(["tenants", "rotate-my-key", "--yes", "--save-key", "--json"], { env: {}, configPath, routes });
		expect(r.error).toBeUndefined();
		expect(JSON.parse(r.out)).toEqual({ api_key: NEW });
		expect(r.err).toContain("Saved the new key (tk_****2222)");
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ url: "http://127.0.0.1:8000", api_key: NEW });
	});

	it("at a terminal, asks to confirm and then offers to save", async () => {
		const configPath = savedConfig();
		const yes = await cli(["tenants", "rotate-my-key"], {
			env: {},
			configPath,
			routes,
			interactive: true,
			answers: ["y", "y"],
		});
		expect(yes.error).toBeUndefined();
		expect(yes.prompts[0]).toContain("cannot be undone");
		expect(yes.prompts[1]).toContain(`Save the new key to ${configPath}?`);
		expect(JSON.parse(readFileSync(configPath, "utf8")).api_key).toBe(NEW);

		const declined = savedConfig();
		const no = await cli(["tenants", "rotate-my-key"], {
			env: {},
			configPath: declined,
			routes,
			interactive: true,
			answers: ["y", "n"],
		});
		expect(no.error).toBeUndefined();
		expect(JSON.parse(readFileSync(declined, "utf8")).api_key).toBe(OLD);
		expect(no.err).toContain("no longer works");
	});

	it("reminds that COB_RAG_API_KEY still holds the old key", async () => {
		const r = await cli(["tenants", "rotate-my-key", "--yes"], { env: { COB_RAG_API_KEY: OLD }, routes });
		expect(r.error).toBeUndefined();
		expect(r.err).toContain("from COB_RAG_API_KEY");
		expect(r.err).toContain("COB_RAG_API_KEY still holds the old key");
	});
});

describe("engine info and my tenant", () => {
	it("prints engine info as flat key/values", async () => {
		const r = await cli(["info"], {
			routes: {
				"GET /api/v1/info": {
					version: "0.2.0",
					features: { streaming: true },
					limits: { allowed_extensions: [".pdf", ".md"] },
				},
			},
		});
		expect(r.error).toBeUndefined();
		expect(r.out).toMatch(/^version\s+0\.2\.0$/m);
		expect(r.out).toMatch(/^features\.streaming\s+true$/m);
		expect(r.out).toMatch(/^limits\.allowed_extensions\s+\.pdf, \.md$/m);
	});

	it("shows my tenant", async () => {
		const r = await cli(["tenants", "me"], {
			env: { COB_RAG_API_KEY: "tk_clitestclitest9876" },
			routes: { "GET /api/v1/tenants/me": { id: IDS.tenant, name: "Acme", corpus_count: 1, max_corpora: 10 } },
		});
		expect(r.error).toBeUndefined();
		expect(r.out).toMatch(/^name\s+Acme$/m);
	});
});
