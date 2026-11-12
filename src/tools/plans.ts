import { z } from "zod";
import type {
	AdminTenantResponse,
	PlanListResponse,
	PlanUsageResponse,
	SetTenantPlanRequest,
} from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { uuid } from "./schemas.js";

// Plans (engine accounts A6): the operator's catalogue of four limits (knowledge bases, questions
// per month, active documents, widget keys; null = unlimited). Every tenant is on one plan.

function limit(value: number | null | undefined): string {
	return value === null || value === undefined ? "unlimited" : String(value);
}

export const listPlansTool = defineTool({
	name: "list_plans",
	title: "List plans",
	description:
		"The operator's plans, the default first, with their four limits (knowledge bases, questions per month, " +
		"active documents, widget keys; empty = unlimited) and how many tenants use each.",
	group: "plans",
	command: "list",
	kinds: ["admin"],
	access: "read",
	input: {
		include_inactive: z.boolean().optional().describe("Also list deactivated plans (default true)."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<PlanListResponse>("/api/v1/admin/plans", {
			include_inactive: input.include_inactive === undefined ? undefined : String(input.include_inactive),
		}),
	render: (data) => {
		const res = data as PlanListResponse;
		const rows = res.items.map((p) => ({
			...p,
			kbs: limit(p.max_knowledge_bases),
			questions: limit(p.monthly_questions),
			documents: limit(p.max_documents),
			widgets: limit(p.max_widget_keys),
			flags: [p.is_default ? "default" : "", p.is_active ? "" : "inactive"].filter(Boolean).join(", "),
		}));
		return table(rows, [
			{ key: "id" },
			{ key: "name", max: 30 },
			{ key: "kbs", label: "knowledge bases" },
			{ key: "questions", label: "questions/month" },
			{ key: "documents" },
			{ key: "widgets", label: "widget keys" },
			{ key: "tenant_count", label: "tenants" },
			{ key: "flags" },
		]);
	},
});

export const setTenantPlanTool = defineTool({
	name: "set_tenant_plan",
	title: "Move a tenant to a plan",
	description:
		"Move a tenant to another active plan; its new limits apply at once (existing content is kept even when it " +
		"is over a limit, but nothing more can be added until it is under).",
	group: "plans",
	command: "set",
	kinds: ["admin"],
	access: "write",
	positional: ["tenant_id", "plan_id"],
	input: {
		tenant_id: uuid("The tenant (from list_tenants)."),
		plan_id: uuid("The plan (from list_plans)."),
	},
	handler: async (input, ctx) => {
		const body: SetTenantPlanRequest = { plan_id: input.plan_id };
		return ctx.client.request<AdminTenantResponse>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/plan`, {
			body,
		});
	},
	render: (data) => keyValues(data, ["id", "name", "status", "plan_id", "plan_name", "effective_max_corpora"]),
});

export const getMyPlanTool = defineTool({
	name: "get_my_plan",
	title: "Plan and usage",
	description:
		"A tenant's plan, its limits and what it has used: questions this month (and when they reset), knowledge " +
		"bases, active documents and widget keys. A tenant key reads its own; the admin key names the tenant.",
	group: "plans",
	command: "usage",
	kinds: ["tenant", "admin"],
	access: "read",
	input: {
		tenant_id: uuid("Admin key: the tenant (from list_tenants). A tenant key leaves it out.").optional(),
	},
	handler: async (input, ctx) =>
		ctx.client.get<PlanUsageResponse>(
			input.tenant_id ? `/api/v1/admin/tenants/${seg(input.tenant_id)}/plan` : "/api/v1/tenants/me/plan",
		),
	render: (data) => {
		const res = data as PlanUsageResponse;
		const { usage: used, limits } = res;
		const rows = [
			{ what: "questions this month", used: used.questions, limit: limit(limits.monthly_questions) },
			{ what: "knowledge bases", used: used.knowledge_bases, limit: limit(limits.max_knowledge_bases) },
			{ what: "active documents", used: used.documents, limit: limit(limits.max_documents) },
			{ what: "widget keys", used: used.widget_keys, limit: limit(limits.max_widget_keys) },
		];
		return `Plan: ${res.plan.name}\n\n${table(rows, [{ key: "what" }, { key: "used" }, { key: "limit" }])}\n\nQuestions reset at ${res.resets_at}.`;
	},
});
