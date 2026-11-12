import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { fakeEngine, type RecordedCall, reply, WHOAMI } from "../test/fake-engine.js";
import { type RunningHttpServer, startHttpServer } from "./http.js";

const CORPUS_KEY = "ck_callerkeycallerkey01";
const ADMIN_KEY = "admin-caller-key-0123456789";
const SERVER_KEY = "ck_serverkeyserverkey9";

function engineFor() {
	return fakeEngine({
		"GET /api/v1/whoami": (call: RecordedCall) => {
			const key = call.headers["x-api-key"];
			if (key === CORPUS_KEY || key === SERVER_KEY) return WHOAMI.corpus;
			if (key === ADMIN_KEY) return WHOAMI.admin;
			return reply(401, { detail: "Invalid API key" });
		},
		"POST /api/v1/query/retrieve": { chunks: [], processed_query: "q", latency_ms: 1, total_chunks: 0 },
	});
}

let running: RunningHttpServer | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

async function start(options: { useServerKey?: boolean; env?: NodeJS.ProcessEnv } = {}) {
	const engine = engineFor();
	running = await startHttpServer({
		config: loadConfig({ env: options.env ?? {} }),
		host: "127.0.0.1",
		port: 0,
		useServerKey: options.useServerKey ?? false,
		fetch: engine.fetch,
		log: () => {},
	});
	return { engine, url: running.url };
}

async function mcpClient(url: string, headers: Record<string, string>) {
	const client = new Client({ name: "test", version: "1" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
	return client;
}

const post = (url: string, headers: Record<string, string> = {}) =>
	fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	});

describe("HTTP transport", () => {
	it("forwards the caller's Bearer key to the engine and scopes tools by it", async () => {
		const { engine, url } = await start();
		const client = await mcpClient(url, { Authorization: `Bearer ${CORPUS_KEY}` });
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("search");
		expect(tools.map((t) => t.name)).not.toContain("list_corpora");
		expect(tools.map((t) => t.name)).not.toContain("upload_file");

		await client.callTool({ name: "search", arguments: { query: "fasting" } });
		const retrieve = engine.calls.find((c) => c.path === "/api/v1/query/retrieve");
		expect(retrieve?.headers["x-api-key"]).toBe(CORPUS_KEY);
		await client.close();
	});

	it("accepts X-API-Key too, and forwards the caller's X-LLM-* headers", async () => {
		const { engine, url } = await start({ env: { COB_RAG_LLM_API_KEY: "sk-server-side-secret" } });
		const client = await mcpClient(url, { "X-API-Key": ADMIN_KEY, "X-LLM-Model": "caller-model" });
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("list_tenants");
		await client.callTool({
			name: "search",
			arguments: { query: "q", corpus_id: "22222222-2222-4222-8222-222222222222" },
		});
		const retrieve = engine.calls.find((c) => c.path === "/api/v1/query/retrieve");
		expect(retrieve?.headers["x-api-key"]).toBe(ADMIN_KEY);
		expect(retrieve?.headers["x-llm-model"]).toBe("caller-model");
		// The server's own model key is never spent on an HTTP caller's behalf.
		expect(retrieve?.headers["x-llm-api-key"]).toBeUndefined();
		await client.close();
	});

	it("refuses a request without a key, even when the server has one", async () => {
		const { engine, url } = await start({ env: { COB_RAG_API_KEY: SERVER_KEY } });
		const res = await post(url);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Missing engine key/);
		expect(engine.calls).toHaveLength(0);
	});

	it("uses the server key only when COB_RAG_HTTP_USE_SERVER_KEY is set", async () => {
		const { engine, url } = await start({ env: { COB_RAG_API_KEY: SERVER_KEY }, useServerKey: true });
		const client = await mcpClient(url, {});
		await client.listTools();
		expect(engine.calls[0]?.headers["x-api-key"]).toBe(SERVER_KEY);
		await client.close();
	});

	it("answers 401 when the engine rejects the caller's key", async () => {
		const { url } = await start();
		const res = await post(url, { Authorization: "Bearer ck_notarealkeynotreal" });
		expect(res.status).toBe(401);
	});

	it("answers 502 when the engine is unreachable", async () => {
		const failing = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		}) as unknown as typeof fetch;
		running = await startHttpServer({
			config: loadConfig({ env: {} }),
			host: "127.0.0.1",
			port: 0,
			useServerKey: false,
			fetch: failing,
			log: () => {},
		});
		const res = await post(running.url, { "X-API-Key": CORPUS_KEY });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Cannot reach cob-rag-engine/);
	});

	it("serves /health without a key, refuses GET on /mcp, and 404s elsewhere", async () => {
		const { url } = await start();
		const base = url.replace(/\/mcp$/, "");
		expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: "ok" });
		expect((await fetch(url, { headers: { "X-API-Key": CORPUS_KEY } })).status).toBe(405);
		expect((await fetch(`${base}/other`, { method: "POST" })).status).toBe(404);
	});

	it("refuses foreign Host and Origin headers while bound to loopback", async () => {
		const { url } = await start();
		const badOrigin = await post(url, { "X-API-Key": CORPUS_KEY, Origin: "https://evil.example" });
		expect(badOrigin.status).toBe(403);
		const goodOrigin = await post(url, { "X-API-Key": CORPUS_KEY, Origin: "http://localhost:5173" });
		expect(goodOrigin.status).toBe(200);

		// fetch always sends the real Host, so forge one with node:http (a DNS-rebinding page would
		// arrive with its own domain in Host).
		const { port } = new URL(url);
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path: "/mcp",
					method: "POST",
					headers: { Host: `rebind.example:${port}`, "X-API-Key": CORPUS_KEY, "content-type": "application/json" },
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end("{}");
		});
		expect(status).toBe(403);
	});

	it("caches /whoami per key briefly", async () => {
		const { engine, url } = await start();
		await post(url, { "X-API-Key": CORPUS_KEY });
		await post(url, { "X-API-Key": CORPUS_KEY });
		expect(engine.calls.filter((c) => c.path === "/api/v1/whoami")).toHaveLength(1);
	});
});
