import { describe, expect, it } from "vitest";
import { fakeEngine, IDS, reply, STREAM_EVENTS, sse, sseChunks, sseText, WHOAMI } from "../test/fake-engine.js";
import { EngineClient, SseParser } from "./client.js";
import { CobRagError } from "./errors.js";

const make = (routes: Record<string, unknown>, llm = {}) => {
	const engine = fakeEngine(routes);
	const client = new EngineClient({
		url: "http://engine.test/",
		apiKey: "ck_secretsecret1234",
		llm,
		fetch: engine.fetch,
	});
	return { engine, client };
};

describe("EngineClient", () => {
	it("sends the key as X-API-Key and strips a trailing slash from the URL", async () => {
		const { engine, client } = make({ "GET /api/v1/whoami": WHOAMI.corpus });
		await expect(client.whoami()).resolves.toMatchObject({ kind: "corpus" });
		expect(engine.last().headers["x-api-key"]).toBe("ck_secretsecret1234");
		expect(client.baseUrl).toBe("http://engine.test");
	});

	it("adds X-LLM-* headers only when asked, and only the ones that are set", async () => {
		const { engine, client } = make(
			{ "POST /api/v1/query": {}, "GET /api/v1/documents": {} },
			{ provider: "openrouter", model: "m", apiKey: "sk-llm" },
		);
		await client.request("POST", "/api/v1/query", { body: { query: "q" }, llmHeaders: true });
		const h = engine.last().headers;
		expect(h["x-llm-provider"]).toBe("openrouter");
		expect(h["x-llm-model"]).toBe("m");
		expect(h["x-llm-api-key"]).toBe("sk-llm");
		expect(h["x-llm-base-url"]).toBeUndefined();

		await client.get("/api/v1/documents");
		expect(Object.keys(engine.last().headers).some((k) => k.startsWith("x-llm"))).toBe(false);
	});

	it("drops undefined query parameters", async () => {
		const { engine, client } = make({ "GET /api/v1/usage": {} });
		await client.get("/api/v1/usage", { group_by: "day", corpus_id: undefined });
		expect(engine.last().query.toString()).toBe("group_by=day");
	});

	it.each([
		[401, { detail: "Invalid API key" }, "UNAUTHORIZED", /rejected the API key \(Invalid API key\)/],
		[403, { detail: "Admin access required" }, "FORBIDDEN", /Admin access required/],
		[
			403,
			{ detail: "This workspace is not active", code: "workspace_not_active", status: "suspended" },
			"FORBIDDEN",
			/^This workspace is not active \(pending or suspended\); ask the operator\.$/,
		],
		[
			403,
			{ detail: "Only a workspace owner can do this", code: "owner_required" },
			"FORBIDDEN",
			/^Only a workspace owner can do this \(Only a workspace owner can do this\)\.$/,
		],
		[
			403,
			{
				detail: "This API key has read permission; this needs write",
				code: "key_permission_denied",
				permission: "read",
				required: "write",
			},
			"FORBIDDEN",
			/^This API key only has read permission; this action needs write\. Use a key with more permission: .*Keys panel/,
		],
		[
			422,
			{
				detail: "Deleting a knowledge base with an API key needs confirm_name",
				code: "confirmation_required",
				confirm_name: "Support FAQ",
			},
			"VALIDATION",
			/^Deleting with an API key needs confirm_name: the item's exact name \(here: "Support FAQ"\)\. Nothing was deleted\. Run the matching preview_delete_\* tool first/,
		],
		[
			429,
			{ detail: "Monthly question limit reached", code: "question_cap_reached", resets_at: "2026-10-01T00:00:00Z" },
			"LIMIT",
			/questions its plan allows this month; they reset at 2026-10-01T00:00:00Z\. Ask the operator/,
		],
		[
			409,
			{ detail: "Tenant corpus limit reached (1)", code: "kb_limit_reached", limit: 1 },
			"LIMIT",
			/^The tenant has reached its plan's knowledge-base limit \(1\): Tenant corpus limit reached \(1\)\./,
		],
		[
			409,
			{ detail: "Document limit reached", code: "document_limit_reached", limit: 50, queued: 2 },
			"LIMIT",
			/plan's document limit \(50\)/,
		],
		[409, { detail: "Something else", code: "not_a_known_code" }, "VALIDATION", /refused the request: Something else/],
		[404, { detail: "Corpus not found" }, "NOT_FOUND", /Corpus not found/],
		[500, "boom", "ENGINE_ERROR", /HTTP 500: boom/],
	])("maps HTTP %i to %s", async (status, body, code, message) => {
		const { client } = make({ "GET /api/v1/whoami": reply(status, body) });
		const err = await client.whoami().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CobRagError);
		expect((err as CobRagError).code).toBe(code);
		expect((err as CobRagError).status).toBe(status);
		expect((err as Error).message).toMatch(message);
	});

	it("flattens a FastAPI 422 validation list", async () => {
		const { client } = make({
			"POST /api/v1/query": reply(422, {
				detail: [{ loc: ["body", "query"], msg: "String should have at least 1 character", type: "x" }],
			}),
		});
		await expect(client.request("POST", "/api/v1/query", { body: {} })).rejects.toThrow(
			"The engine refused the request: query: String should have at least 1 character",
		);
	});

	it("says plainly when the engine cannot be reached", async () => {
		const failing = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		}) as unknown as typeof fetch;
		const client = new EngineClient({ url: "http://127.0.0.1:1", apiKey: "k", fetch: failing });
		const err = (await client.whoami().catch((e: unknown) => e)) as CobRagError;
		expect(err.code).toBe("ENGINE_UNREACHABLE");
		expect(err.message).toContain("Cannot reach cob-rag-engine at http://127.0.0.1:1 (ECONNREFUSED)");
		expect(err.message).toContain("no hosted service");
	});

	it("reports a timeout", async () => {
		const slow = (async () => {
			throw Object.assign(new Error("t"), { name: "TimeoutError" });
		}) as unknown as typeof fetch;
		const client = new EngineClient({ url: "http://e", apiKey: "k", fetch: slow, timeoutMs: 5000 });
		await expect(client.whoami()).rejects.toMatchObject({ code: "TIMEOUT" });
	});
});

describe("SseParser", () => {
	const all = (parser: SseParser, pieces: string[]) => [...pieces.flatMap((p) => parser.push(p)), ...parser.end()];

	it("reads named events with JSON data", () => {
		expect(all(new SseParser(), [sseText(STREAM_EVENTS)])).toEqual(
			STREAM_EVENTS.map(([event, data]) => ({ event, data })),
		);
	});

	it("gives the same events however the text is split, down to one character at a time", () => {
		const text = sseText(STREAM_EVENTS);
		const expected = STREAM_EVENTS.map(([event, data]) => ({ event, data }));
		expect(all(new SseParser(), text.split(""))).toEqual(expected);
		for (const at of [3, 7, 16, 40, text.indexOf("\n\n") + 1, text.length - 1]) {
			expect(all(new SseParser(), [text.slice(0, at), text.slice(at)])).toEqual(expected);
		}
	});

	it("handles CRLF (split between chunks too), comments, multi-line data and unnamed events", () => {
		const parser = new SseParser();
		const events = all(parser, [
			": keep-alive\r\n\r",
			'\nevent: token\r\ndata: {"content":\r',
			'\ndata: "x"}\r\n\r\n',
			"data: plain text\n\n",
			"event: token\ndata:",
		]);
		expect(events).toEqual([
			{ event: "token", data: { content: "x" } },
			{ event: "message", data: "plain text" },
			{ event: "token", data: "" },
		]);
	});

	it("drops an event name with no data", () => {
		expect(all(new SseParser(), ["event: ping\n\n", 'data: {"a":1}\n\n'])).toEqual([
			{ event: "message", data: { a: 1 } },
		]);
	});
});

describe("streamQuery", () => {
	it("hands every event over as it arrives and gathers the answer", async () => {
		const { engine, client } = make({ "POST /api/v1/query/stream": sse(STREAM_EVENTS) });
		const seen: string[] = [];
		const answer = await client.streamQuery({ query: "q" }, (e) => seen.push(e.event));
		expect(seen).toEqual(["sources", "token", "token", "done"]);
		expect(answer).toMatchObject({
			query_id: IDS.job,
			answer: "Fast for 10-12 hours [1].",
			model: "qwen2.5:3b",
			latency_ms: 950,
			usage: { total_tokens: 128 },
		});
		expect(answer.sources.map((s) => s.index)).toEqual([1, 2]);
		expect(engine.last().headers.accept).toBe("text/event-stream");
		expect(engine.last().body).toEqual({ query: "q" });
	});

	it("parses events split across network chunks, including inside a UTF-8 character", async () => {
		const bytes = new TextEncoder().encode(
			sseText([
				["sources", { query_id: IDS.job, sources: [] }],
				["token", { content: "café ✓" }],
				["done", { query_id: IDS.job, model: "m", latency_ms: 1, usage: {} }],
			]),
		);
		const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
		const chunks = [bytes.slice(0, 5), bytes.slice(5, cut), bytes.slice(cut, cut + 9), bytes.slice(cut + 9)];
		const { client } = make({ "POST /api/v1/query/stream": sseChunks(chunks) });
		await expect(client.streamQuery({ query: "q" })).resolves.toMatchObject({ answer: "café ✓" });
	});

	it("throws the engine's detail on an error event, after the tokens before it", async () => {
		const { client } = make({
			"POST /api/v1/query/stream": sse([
				STREAM_EVENTS[0] as [string, unknown],
				["token", { content: "Fast" }],
				["error", { detail: "Generation failed part-way; the answer is incomplete." }],
			]),
		});
		const tokens: string[] = [];
		const failure = client.streamQuery({ query: "q" }, (e) => {
			if (e.event === "token") tokens.push(e.data.content);
		});
		await expect(failure).rejects.toMatchObject({
			code: "ENGINE_ERROR",
			message: expect.stringContaining("Generation failed part-way"),
		});
		expect(tokens).toEqual(["Fast"]);
	});

	it("reports a stream that ends without done", async () => {
		const { client } = make({ "POST /api/v1/query/stream": sse(STREAM_EVENTS.slice(0, 2)) });
		await expect(client.streamQuery({ query: "q" })).rejects.toMatchObject({
			code: "ENGINE_ERROR",
			message: expect.stringContaining("before the answer was finished"),
		});
	});

	it("names the old unnamed data: format instead of printing it", async () => {
		const { client } = make({ "POST /api/v1/query/stream": sseChunks(['data: "Hel"\n\n', "data: [DONE]\n\n"]) });
		await expect(client.streamQuery({ query: "q" })).rejects.toMatchObject({
			message: expect.stringContaining("old /query/stream format"),
		});
	});

	it("raises HTTP errors before the stream starts: 401, 422 and 502", async () => {
		const cases: Array<[number, unknown, string, string]> = [
			[401, { detail: "Invalid API key" }, "UNAUTHORIZED", "Invalid API key"],
			[422, { detail: "Query is empty after preprocessing" }, "VALIDATION", "Query is empty after preprocessing"],
			[502, { detail: "Vector store unavailable" }, "ENGINE_ERROR", "HTTP 502: Vector store unavailable"],
		];
		for (const [status, body, code, text] of cases) {
			const { client } = make({ "POST /api/v1/query/stream": reply(status, body) });
			await expect(client.streamQuery({ query: "q" })).rejects.toMatchObject({
				code,
				status,
				message: expect.stringContaining(text),
			});
		}
	});

	it("turns a connection lost mid-stream into a CobRagError", async () => {
		const fetchImpl = (async () => {
			let sent = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent) {
						controller.error(new TypeError("terminated"));
						return;
					}
					sent = true;
					controller.enqueue(new TextEncoder().encode(sseText([STREAM_EVENTS[0] as [string, unknown]])));
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		const client = new EngineClient({ url: "http://e", apiKey: "k", fetch: fetchImpl });
		await expect(client.streamQuery({ query: "q" })).rejects.toMatchObject({
			code: "ENGINE_ERROR",
			message: expect.stringContaining("broke off: terminated"),
		});
	});
});
