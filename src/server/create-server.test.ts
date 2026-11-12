import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { WhoAmI } from "../core/api-types.js";
import { EngineClient } from "../core/client.js";
import { loadConfig, type ResolvedConfig } from "../core/config.js";
import { fakeEngine, reply, WHOAMI } from "../test/fake-engine.js";
import { createMcpServer } from "./create-server.js";
import { startStdio } from "./stdio.js";

async function connect(identity: WhoAmI, config: Partial<ResolvedConfig> = {}, routes: Record<string, unknown> = {}) {
	const engine = fakeEngine(routes);
	const client = new EngineClient({ url: "http://engine.test", apiKey: "ck_testtesttest1234", fetch: engine.fetch });
	const { server } = createMcpServer({
		client,
		config: { ...loadConfig({ env: {} }), ...config },
		identity,
		transport: "stdio",
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: "test", version: "1" });
	await Promise.all([server.connect(a), mcp.connect(b)]);
	return { mcp, engine };
}

describe("MCP server", () => {
	it("registers the corpus-key tool set with correct annotations and no corpus_id", async () => {
		const { mcp } = await connect(WHOAMI.corpus as WhoAmI);
		const { tools } = await mcp.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("search");
		expect(names).not.toContain("list_corpora");
		expect(names).not.toContain("delete_document");

		const search = tools.find((t) => t.name === "search");
		expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
		expect(Object.keys(search?.inputSchema.properties ?? {})).not.toContain("corpus_id");

		const add = tools.find((t) => t.name === "add_records");
		expect(add?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
	});

	it("shows admin tools, and destructive ones only when allowed", async () => {
		const { mcp } = await connect(WHOAMI.admin as WhoAmI, { allowDestructive: true });
		const { tools } = await mcp.listTools();
		const del = tools.find((t) => t.name === "delete_corpus");
		expect(del?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
		expect(tools.map((t) => t.name)).toContain("suspend_tenant");
		const search = tools.find((t) => t.name === "search");
		expect(Object.keys(search?.inputSchema.properties ?? {})).toContain("corpus_id");
	});

	it("gives a tenant key the documents and settings tools with a corpus_id it must fill", async () => {
		const corpusId = "22222222-2222-4222-8222-222222222222";
		const { mcp, engine } = await connect(
			WHOAMI.tenant as WhoAmI,
			{},
			{ "GET /api/v1/documents": { items: [], count: 0 } },
		);
		const { tools } = await mcp.listTools();
		const names = tools.map((t) => t.name);
		for (const name of ["list_documents", "get_document", "get_corpus_settings", "update_corpus_settings"]) {
			const tool = tools.find((t) => t.name === name);
			expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("corpus_id");
		}
		expect(names).toEqual(expect.arrayContaining(["get_my_tenant", "list_migrations", "list_feedback"]));
		expect(names).not.toContain("rotate_my_tenant_key");
		expect(names).not.toContain("list_tenants");

		const missing = await mcp.callTool({ name: "list_documents", arguments: {} });
		expect(missing.isError).toBe(true);
		expect((missing.content as Array<{ text: string }>)[0]?.text).toContain("USAGE: corpus_id is required");
		expect(engine.calls).toHaveLength(0);

		const listed = await mcp.callTool({ name: "list_documents", arguments: { corpus_id: corpusId } });
		expect(listed.isError).toBeFalsy();
		expect(engine.last().query.get("corpus_id")).toBe(corpusId);
	});

	it("never offers tenant-self or migration tools to a corpus key", async () => {
		const { mcp } = await connect(WHOAMI.corpus as WhoAmI, { allowDestructive: true });
		const names = (await mcp.listTools()).tools.map((t) => t.name);
		for (const name of ["get_my_tenant", "rotate_my_tenant_key", "list_migrations"]) expect(names).not.toContain(name);
		expect(names).toEqual(expect.arrayContaining(["get_engine_info", "list_feedback", "get_document"]));
	});

	it("lets an MCP client send null to clear a corpus setting", async () => {
		const corpusId = "22222222-2222-4222-8222-222222222222";
		const { mcp, engine } = await connect(WHOAMI.admin as WhoAmI, {}, { [`PUT /api/v1/corpora/${corpusId}`]: {} });
		const { tools } = await mcp.listTools();
		const update = tools.find((t) => t.name === "update_corpus");
		expect(JSON.stringify(update?.inputSchema.properties?.description)).toContain("null");
		const result = await mcp.callTool({
			name: "update_corpus",
			arguments: { corpus_id: corpusId, description: null, llm_config: { api_key: null } },
		});
		expect(result.isError).toBeFalsy();
		expect(engine.last().body).toEqual({ description: null, llm_config: { api_key: null } });
	});

	it("shows only read tools in read-only mode", async () => {
		const { mcp } = await connect(WHOAMI.admin as WhoAmI, { readOnly: true, allowDestructive: true });
		const { tools } = await mcp.listTools();
		expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
	});

	it("calls a tool and returns JSON text", async () => {
		const { mcp, engine } = await connect(
			WHOAMI.corpus as WhoAmI,
			{},
			{
				"POST /api/v1/query/retrieve": { chunks: [], processed_query: "q", latency_ms: 3, total_chunks: 0 },
			},
		);
		const result = await mcp.callTool({ name: "search", arguments: { query: "fasting" } });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
		expect(JSON.parse(text)).toMatchObject({ query: "q", total_chunks: 0 });
		expect(engine.last().body).toEqual({ query: "fasting", options: {} });
	});

	it("returns engine errors as tool errors with a code", async () => {
		const { mcp } = await connect(
			WHOAMI.corpus as WhoAmI,
			{},
			{
				"POST /api/v1/query": reply(503, { detail: "No LLM configured" }),
			},
		);
		const result = await mcp.callTool({ name: "ask", arguments: { query: "q" } });
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
			"ENGINE_ERROR: The engine returned HTTP 503: No LLM configured",
		);
	});

	it("drops a corpus_id a corpus key's client sends anyway: it never reaches the engine", async () => {
		const { mcp, engine } = await connect(
			WHOAMI.corpus as WhoAmI,
			{},
			{
				"POST /api/v1/query/retrieve": { chunks: [], processed_query: "q", latency_ms: 3, total_chunks: 0 },
			},
		);
		const result = await mcp.callTool({
			name: "search",
			arguments: { query: "q", corpus_id: "33333333-3333-4333-8333-333333333333" },
		});
		expect(result.isError).toBeFalsy();
		expect(engine.last().body).toEqual({ query: "q", options: {} });
	});

	it("offers the answer-with-citations prompt", async () => {
		const { mcp } = await connect(WHOAMI.corpus as WhoAmI);
		const { prompts } = await mcp.listPrompts();
		expect(prompts.map((p) => p.name)).toEqual(["answer-with-citations"]);
		const prompt = await mcp.getPrompt({ name: "answer-with-citations", arguments: { question: "Fasting?" } });
		const text = (prompt.messages[0]?.content as { text: string } | undefined)?.text;
		expect(text).toContain("`search`");
		expect(text).toContain("Question: Fasting?");
	});
});

describe("startStdio", () => {
	it("refuses to start without a key, and says where keys come from", async () => {
		await expect(startStdio(loadConfig({ env: {} }))).rejects.toThrow(/No engine key configured.*no hosted service/s);
	});

	it("fails fast when the key is wrong", async () => {
		const engine = fakeEngine({ "GET /api/v1/whoami": reply(401, { detail: "Invalid API key" }) });
		const config = loadConfig({ env: { COB_RAG_API_KEY: "ck_wrongwrongwrong" } });
		await expect(startStdio(config, engine.fetch)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
