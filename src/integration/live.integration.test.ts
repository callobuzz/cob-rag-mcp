/**
 * Live tests against a running cob-rag-engine: `pnpm test:integration`.
 *
 * Skipped unless COB_RAG_URL and COB_RAG_API_KEY are set. With an admin or tenant key they create
 * a throwaway corpus, index a few records, search them through the tools and through an MCP
 * session, read it back with the manager key plus corpus_id (documents, chunks, settings, paged
 * corpora, filtered jobs, feedback, migrations, and the tenant's own record for a tenant key), and
 * delete the corpus afterwards. With the admin key they also create the corpus's tenant, check that
 * a corpus needs one, suspend and reactivate it (typed name), read plans, the tenant's plan and
 * usage, invite into its team and read the engine settings, then delete the tenant (typed name).
 * With a corpus key they only read.
 *
 * The streaming test needs a model the engine can reach (the corpus's, the engine default, or
 * COB_RAG_LLM_* settings). Set COB_RAG_IT_NO_LLM=true to skip it on an engine without one.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	AdminInvitationOut,
	AdminTenantResponse,
	CorpusListResponse,
	CreateCorpusResponse,
	DocumentDetailResponse,
	DocumentListResponse,
	FeedbackListResponse,
	InfoResponse,
	JobListResponse,
	MigrationListResponse,
	PlanListResponse,
	PlanUsageResponse,
	QueryStreamEvent,
	SettingsResponse,
	TeamResponse,
	TenantResponse,
	WhoAmI,
} from "../core/api-types.js";
import { EngineClient } from "../core/client.js";
import { loadConfig } from "../core/config.js";
import type { ToolContext } from "../core/tool.js";
import { createMcpServer } from "../server/create-server.js";
import { findTool } from "../tools/index.js";
import type { StreamedAskResult } from "../tools/query.js";

const url = process.env.COB_RAG_URL;
const key = process.env.COB_RAG_API_KEY;
const live = Boolean(url && key);
const noLlm = process.env.COB_RAG_IT_NO_LLM === "true";

const RECORDS = [
	{ id: "it-fasting", title: "Fasting", text: "Fast for 10 to 12 hours before a lipid profile. Water is allowed." },
	{ id: "it-reports", title: "Reports", text: "Most blood test reports are ready within 24 hours by email." },
];

async function call(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
	const tool = findTool(name);
	if (!tool) throw new Error(name);
	return tool.handler(input, ctx);
}

describe.skipIf(!live)("live engine", () => {
	const config = loadConfig({ env: { COB_RAG_URL: url, COB_RAG_API_KEY: key } });
	const manager = new EngineClient({ url: config.url, apiKey: config.apiKey as string });
	let identity: WhoAmI;
	let created: CreateCorpusResponse | undefined;
	/** The tenant an admin-key run creates its corpus under (every corpus belongs to one). */
	let tenantId: string | undefined;
	let tenantName = "";
	let corpusCtx: ToolContext;
	/** The admin or tenant key's context; undefined when the test runs with a corpus key. */
	let managerCtx: ToolContext | undefined;

	beforeAll(async () => {
		identity = await manager.whoami();
		if (identity.kind === "corpus") {
			corpusCtx = { client: manager, config, surface: "cli", identity };
			return;
		}
		managerCtx = { client: manager, config, surface: "cli", identity };
		if (identity.kind === "admin") {
			tenantName = `cob-rag-mcp-it-${Date.now()}`;
			const tenant = (await call("create_tenant", { name: tenantName }, managerCtx)) as { id: string };
			tenantId = tenant.id;
		}
		created = (await call(
			"create_corpus",
			{
				name: `cob-rag-mcp-it-${Date.now()}`,
				description: "cob-rag-mcp integration test",
				...(tenantId ? { tenant_id: tenantId } : {}),
			},
			managerCtx,
		)) as CreateCorpusResponse;
		const client = new EngineClient({ url: config.url, apiKey: created.api_key });
		corpusCtx = { client, config, surface: "cli", identity: await client.whoami() };
		const ingest = (await call("add_records", { records: RECORDS, wait: true, wait_seconds: 120 }, corpusCtx)) as {
			job: { status: string };
		};
		expect(ingest.job.status).toBe("completed");
	});

	afterAll(async () => {
		if (created) await manager.request("DELETE", `/api/v1/corpora/${created.id}`);
		// A hard delete, with the tenant's name typed (the engine refuses it otherwise).
		if (tenantId && managerCtx)
			await call("delete_tenant", { tenant_id: tenantId, confirm_name: tenantName }, managerCtx);
	});

	it("admin key: a corpus needs its tenant, and suspend / reactivate switch the tenant's keys off and on", async () => {
		if (identity.kind !== "admin" || !managerCtx || !tenantId || !created) return;
		await expect(call("create_corpus", { name: "no tenant" }, managerCtx)).rejects.toThrow(/tenant/);
		await expect(
			call("suspend_tenant", { tenant_id: tenantId, confirm_name: tenantName.toUpperCase() }, managerCtx),
		).rejects.toThrow(/refused/);
		const suspended = (await call(
			"suspend_tenant",
			{ tenant_id: tenantId, confirm_name: tenantName },
			managerCtx,
		)) as AdminTenantResponse;
		expect(suspended.status).toBe("suspended");
		await expect(call("list_documents", {}, corpusCtx)).rejects.toThrow(/not active/);
		const back = (await call("reactivate_tenant", { tenant_id: tenantId }, managerCtx)) as AdminTenantResponse;
		expect(back.status).toBe("active");
		await expect(call("list_documents", {}, corpusCtx)).resolves.toBeTruthy();
	});

	it("admin key: plans, the tenant's plan and usage, its team, and the engine settings", async () => {
		if (identity.kind !== "admin" || !managerCtx || !tenantId) return;
		const plans = (await call("list_plans", {}, managerCtx)) as PlanListResponse;
		const standard = plans.items.find((p) => p.is_default);
		expect(standard).toBeTruthy();
		const moved = (await call(
			"set_tenant_plan",
			{ tenant_id: tenantId, plan_id: standard?.id },
			managerCtx,
		)) as AdminTenantResponse;
		expect(moved.plan_id).toBe(standard?.id);
		const usage = (await call("get_my_plan", { tenant_id: tenantId }, managerCtx)) as PlanUsageResponse;
		expect(usage.plan.id).toBe(standard?.id);
		expect(usage.usage.knowledge_bases).toBeGreaterThanOrEqual(1);
		const invitation = (await call(
			"admin_invite",
			// `call` skips the schema, so its defaults: pass the role the tool defaults to.
			{ tenant_id: tenantId, email: `owner-${Date.now()}@it.example`, role: "owner" },
			managerCtx,
		)) as AdminInvitationOut;
		expect(invitation.accept_url).toContain("#token=");
		const team = (await call("list_team", { tenant_id: tenantId }, managerCtx)) as TeamResponse;
		expect(team.invitations.map((i) => i.id)).toContain(invitation.id);
		const settings = (await call("get_settings", {}, managerCtx)) as SettingsResponse;
		expect(["open", "approval", "closed"]).toContain(settings.signup_mode);
	});

	it("identifies the key", () => {
		expect(["admin", "tenant", "corpus"]).toContain(identity.kind);
	});

	it("searches and finds the right record", async () => {
		const res = (await call("search", { query: "How long should I fast before a lipid test?" }, corpusCtx)) as {
			chunks: Array<{ external_id?: string | null }>;
		};
		if (created) expect(res.chunks[0]?.external_id).toBe("it-fasting");
		else expect(Array.isArray(res.chunks)).toBe(true);
	});

	it("lists documents and usage", async () => {
		const docs = (await call("list_documents", {}, corpusCtx)) as { count: number };
		if (created) expect(docs.count).toBe(RECORDS.length);
		const usage = (await call("get_usage", {}, corpusCtx)) as { rows: unknown[] };
		expect(Array.isArray(usage.rows)).toBe(true);
	});

	it("reads engine info with any key", async () => {
		const info = (await call("get_engine_info", {}, corpusCtx)) as InfoResponse;
		expect(info.version).toBeTruthy();
		expect(info.limits.max_records_per_request).toBeGreaterThan(0);
		if (managerCtx) expect(await call("get_engine_info", {}, managerCtx)).toEqual(info);
	});

	it("gets a document with its chunks, with the corpus key and with the manager key plus corpus_id", async () => {
		const docs = (await call("list_documents", { search: "it-fasting" }, corpusCtx)) as DocumentListResponse;
		if (created) expect(docs.items.map((d) => d.external_id)).toEqual(["it-fasting"]);
		const first = docs.items[0];
		if (!first) return;
		const doc = (await call(
			"get_document",
			{ document_id: first.id, chunk_limit: 1 },
			corpusCtx,
		)) as DocumentDetailResponse;
		expect(doc.chunks.length).toBeLessThanOrEqual(1);
		expect(doc.chunk_total).toBeGreaterThanOrEqual(doc.chunks.length);
		if (!managerCtx || !created) return;
		const viaManager = (await call(
			"get_document",
			{ document_id: first.id, corpus_id: created.id, chunk_limit: 1 },
			managerCtx,
		)) as DocumentDetailResponse;
		expect(viaManager.id).toBe(first.id);
		const listed = (await call("list_documents", { corpus_id: created.id }, managerCtx)) as DocumentListResponse;
		expect(listed.count).toBe(RECORDS.length);
		const settings = (await call("get_corpus_settings", { corpus_id: created.id }, managerCtx)) as {
			corpus_id?: string | null;
		};
		expect(settings.corpus_id).toBe(created.id);
		await expect(call("list_documents", {}, managerCtx)).rejects.toThrow(/corpus_id is required/);
	});

	it("pages corpora, filters jobs and lists feedback and migrations", async () => {
		const feedback = (await call("list_feedback", { limit: 5 }, corpusCtx)) as FeedbackListResponse;
		expect(feedback.limit).toBe(5);
		if (!managerCtx || !created) return;
		const page = (await call("list_corpora", { limit: 1 }, managerCtx)) as CorpusListResponse;
		expect(page.items).toHaveLength(1);
		expect(page.count).toBe(1);
		expect(page.total ?? 0).toBeGreaterThanOrEqual(1);
		// About three pages, however many corpora the engine holds.
		const perPage = Math.min(500, Math.max(1, Math.ceil((page.total ?? 1) / 3)));
		const all = (await call("list_corpora", { all: true, limit: perPage }, managerCtx)) as CorpusListResponse;
		expect(all.items.length).toBe(all.total);
		expect(all.items.map((c) => c.id)).toContain(created.id);
		const jobs = (await call(
			"list_ingest_jobs",
			{ corpus_id: created.id, status: "completed", limit: 5 },
			managerCtx,
		)) as JobListResponse;
		expect(jobs.total).toBeGreaterThanOrEqual(1);
		expect(jobs.items.every((j) => j.corpus_id === created?.id && j.status === "completed")).toBe(true);
		expect(jobs.items[0]?.mode).toBe("records");
		const migrations = (await call("list_migrations", { corpus_id: created.id }, managerCtx)) as MigrationListResponse;
		expect(Array.isArray(migrations.items)).toBe(true);
		if (identity.kind === "tenant") {
			const me = (await call("get_my_tenant", {}, managerCtx)) as TenantResponse;
			expect(me.id).toBe(identity.tenant_id);
			expect(me.corpus_count).toBeGreaterThanOrEqual(1);
		}
	});

	it.skipIf(noLlm)(
		"streams a cited answer: sources, then tokens, then done",
		async () => {
			const events: QueryStreamEvent[] = [];
			const res = (await call(
				"ask",
				{ query: "How long should I fast before a lipid test?" },
				{ ...corpusCtx, stream: (e) => events.push(e) },
			)) as StreamedAskResult;
			const kinds = events.map((e) => e.event);
			expect(kinds[0]).toBe("sources");
			expect(kinds.at(-1)).toBe("done");
			expect(kinds.slice(1, -1).every((k) => k === "token")).toBe(true);
			expect(kinds.length).toBeGreaterThan(2);
			expect(res.answer.trim().length).toBeGreaterThan(0);
			expect(res.model).toBeTruthy();
			expect(res.latency_ms).toBeGreaterThan(0);
			if (created) expect(res.sources.map((s) => s.external_id)).toContain("it-fasting");
			// The query_id is logged before done, so it already resolves.
			await expect(corpusCtx.client.get(`/api/v1/query/${res.query_id}`)).resolves.toBeTruthy();
		},
		180_000,
	);

	it("serves the same search over MCP", async () => {
		const { server } = createMcpServer({
			client: corpusCtx.client,
			config,
			identity: corpusCtx.identity as WhoAmI,
			transport: "stdio",
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: "it", version: "1" });
		await Promise.all([server.connect(a), mcp.connect(b)]);
		const { tools } = await mcp.listTools();
		expect(tools.map((t) => t.name)).toContain("search");
		const result = await mcp.callTool({ name: "search", arguments: { query: "When are reports ready?" } });
		expect(result.isError).toBeFalsy();
		await mcp.close();
	});
});
