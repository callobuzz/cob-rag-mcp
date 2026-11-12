import { z } from "zod";
import type {
	ActivateTenantRequest,
	AdminTenantResponse,
	CreateTenantRequest,
	CreateTenantResponse,
	DeclineTenantRequest,
	DeletePreviewResponse,
	RotateTenantKeyResponse,
	SuspendTenantRequest,
	TenantListResponse,
	TenantResponse,
} from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues, pageFooter, renderPreview, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { compact, uuid } from "./schemas.js";

// Tenants sit above corpora: one per client business. The admin key manages them all; a tenant
// key reads and rotates only its own record (/api/v1/tenants/me), which admin and corpus keys
// are refused. A tenant is pending (a sign-up waiting for the operator), active or suspended;
// every key and sign-in of a pending or suspended tenant is refused by the engine.
const tenantId = uuid("Tenant id (from list_tenants).");
const KEY_ONCE = "The tenant key is shown only in this response: store it now.";
const confirmName = z
	.string()
	.min(1)
	.max(255)
	.describe("The tenant's name, typed exactly (case-sensitive): the engine refuses anything else.");

export const TENANT_STATUSES = ["pending", "active", "suspended"] as const;

/** The engine's largest page for GET /api/v1/admin/tenants. */
export const MAX_TENANTS_PAGE = 500;

const ADMIN_FIELDS = [
	"id",
	"name",
	"status",
	"plan_name",
	"activated_at",
	"activation_note",
	"owner_emails",
	"corpus_count",
];

export const listTenantsTool = defineTool({
	name: "list_tenants",
	title: "List tenants",
	description:
		"List tenants, newest first, with their status (pending sign-ups, active, suspended), owners and corpus " +
		"counts. Filter by status or part of the name. Paged: `count` is this page, `total` all that match.",
	group: "tenants",
	command: "list",
	kinds: ["admin"],
	access: "read",
	input: {
		status: z.enum(TENANT_STATUSES).optional().describe("Only tenants in this status."),
		search: z.string().max(255).optional().describe("Part of the name (any case)."),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_TENANTS_PAGE)
			.optional()
			.describe(`Page size (default 100, at most ${MAX_TENANTS_PAGE}).`),
	},
	handler: async (input, ctx) =>
		ctx.client.get<TenantListResponse>("/api/v1/admin/tenants", {
			status: input.status,
			search: input.search,
			offset: input.offset,
			limit: input.limit,
		}),
	render: (data) => {
		const res = data as TenantListResponse;
		const rows = res.items.map((t) => ({ ...t, owners: (t.owner_emails ?? []).join(", ") }));
		return `${table(rows, [
			{ key: "id" },
			{ key: "name", max: 40 },
			{ key: "status" },
			{ key: "owners", max: 40 },
			{ key: "corpus_count", label: "corpora" },
			{ key: "max_corpora", label: "max" },
			{ key: "created_at" },
		])}\n\n${pageFooter("tenants", { count: res.items.length, total: res.total, offset: res.offset })}`;
	},
});

export const createTenantTool = defineTool({
	name: "create_tenant",
	title: "Create a tenant",
	description: `Create an active tenant (one client business) with its own tenant key (tk_). ${KEY_ONCE}`,
	group: "tenants",
	command: "create",
	kinds: ["admin"],
	access: "write",
	positional: ["name"],
	input: {
		name: z.string().min(1).max(255),
		description: z.string().optional(),
		plan_id: uuid("Plan (from list_plans); default: the default plan.").optional(),
		max_corpora: z
			.number()
			.int()
			.min(1)
			.max(10000)
			.optional()
			.describe("Knowledge-base limit for this tenant only, overriding its plan's."),
	},
	handler: async (input, ctx) => {
		const body: CreateTenantRequest = {
			name: input.name,
			...compact({ description: input.description, plan_id: input.plan_id, max_corpora: input.max_corpora }),
		};
		return ctx.client.request<CreateTenantResponse>("POST", "/api/v1/admin/tenants", { body });
	},
	render: (data) => `${keyValues(data, ["id", "name", "api_key", "max_corpora", "status"])}\n\n${KEY_ONCE}`,
});

export const rotateTenantKeyTool = defineTool({
	name: "rotate_tenant_key",
	title: "Rotate a tenant key",
	description: `Issue a new tenant key (tk_). The old key stops working immediately. ${KEY_ONCE}`,
	group: "tenants",
	command: "rotate-key",
	kinds: ["admin"],
	access: "destructive",
	positional: ["tenant_id"],
	input: { tenant_id: tenantId },
	handler: async (input, ctx) =>
		ctx.client.request<RotateTenantKeyResponse>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/rotate-key`),
	render: (data) => `${keyValues(data)}\n\n${KEY_ONCE}`,
});

export const activateTenantTool = defineTool({
	name: "activate_tenant",
	title: "Activate a tenant",
	description:
		"Activate a pending sign-up: its owners get a welcome e-mail (naming the plan) and can use the workspace. " +
		"Optionally put it on a plan (default: the plan it has) and record a note (for example how they paid). " +
		"Only a pending tenant can be activated.",
	group: "tenants",
	command: "activate",
	kinds: ["admin"],
	access: "write",
	positional: ["tenant_id"],
	input: {
		tenant_id: tenantId,
		plan_id: uuid("Plan (from list_plans); default: the plan it has.").optional(),
		note: z.string().max(1000).optional().describe("Operator's note."),
	},
	handler: async (input, ctx) => {
		const body: ActivateTenantRequest = compact({ plan_id: input.plan_id, note: input.note });
		return ctx.client.request<AdminTenantResponse>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/activate`, {
			body,
		});
	},
	render: (data) => keyValues(data, ADMIN_FIELDS),
});

export const suspendTenantTool = defineTool({
	name: "suspend_tenant",
	title: "Suspend a tenant",
	description:
		"Suspend an active tenant: its tenant key, every corpus key, its website widgets and its members' sign-ins " +
		"stop working at once (data is kept; reactivate_tenant undoes it). Needs the tenant's name typed exactly.",
	group: "tenants",
	command: "suspend",
	kinds: ["admin"],
	access: "destructive",
	positional: ["tenant_id", "confirm_name"],
	input: {
		tenant_id: tenantId,
		confirm_name: confirmName,
		reason: z.string().max(1000).optional().describe("Kept in the engine's audit log."),
	},
	handler: async (input, ctx) => {
		const body: SuspendTenantRequest = { confirm_name: input.confirm_name, ...compact({ reason: input.reason }) };
		return ctx.client.request<AdminTenantResponse>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/suspend`, {
			body,
		});
	},
	render: (data) => keyValues(data, ADMIN_FIELDS),
});

export const reactivateTenantTool = defineTool({
	name: "reactivate_tenant",
	title: "Reactivate a tenant",
	description: "Reactivate a suspended tenant: its keys, widgets and sign-ins work again on their next request.",
	group: "tenants",
	command: "reactivate",
	kinds: ["admin"],
	access: "write",
	positional: ["tenant_id"],
	input: { tenant_id: tenantId },
	handler: async (input, ctx) =>
		ctx.client.request<AdminTenantResponse>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/reactivate`),
	render: (data) => keyValues(data, ADMIN_FIELDS),
});

export const declineTenantTool = defineTool({
	name: "decline_tenant",
	title: "Decline a sign-up",
	description:
		"Decline a pending sign-up: the tenant and the account that signed it up are removed and the owner gets a " +
		"polite e-mail (the reason is not sent). Only a pending tenant can be declined.",
	group: "tenants",
	command: "decline",
	kinds: ["admin"],
	access: "destructive",
	positional: ["tenant_id"],
	input: {
		tenant_id: tenantId,
		reason: z.string().max(1000).optional().describe("Kept in the engine's audit log."),
	},
	handler: async (input, ctx) => {
		const body: DeclineTenantRequest = compact({ reason: input.reason });
		await ctx.client.request("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/decline`, { body });
		return { declined: true, tenant_id: input.tenant_id };
	},
});

export const previewDeleteTenantTool = defineTool({
	name: "preview_delete_tenant",
	title: "Preview deleting a tenant",
	description:
		"Dry run: what deleting a tenant would remove (its knowledge bases and everything in them, members, API keys) " +
		"and the exact name to pass as confirm_name to delete_tenant. Changes nothing.",
	group: "tenants",
	command: "delete-preview",
	kinds: ["admin"],
	access: "read",
	positional: ["tenant_id"],
	input: { tenant_id: tenantId },
	handler: async (input, ctx) =>
		ctx.client.get<DeletePreviewResponse>(`/api/v1/admin/tenants/${seg(input.tenant_id)}/delete-preview`),
	render: (data) => renderPreview(data as DeletePreviewResponse),
});

export const deleteTenantTool = defineTool({
	name: "delete_tenant",
	title: "Delete a tenant",
	description:
		"Delete a tenant and everything it owns: every corpus (documents, vectors, files), its members, and the " +
		"accounts that belonged only to it. Cannot be undone. Needs the tenant's name typed exactly " +
		"(preview_delete_tenant shows what would go and the name).",
	group: "tenants",
	command: "delete",
	kinds: ["admin"],
	access: "destructive",
	positional: ["tenant_id", "confirm_name"],
	input: { tenant_id: tenantId, confirm_name: confirmName },
	handler: async (input, ctx) => {
		await ctx.client.request("DELETE", `/api/v1/admin/tenants/${seg(input.tenant_id)}`, {
			query: { confirm_name: input.confirm_name },
		});
		return { deleted: true, tenant_id: input.tenant_id };
	},
});

export const getMyTenantTool = defineTool({
	name: "get_my_tenant",
	title: "My tenant",
	description: "Show this tenant key's own tenant: name, description, status, its corpus count and corpus limit.",
	group: "tenants",
	command: "me",
	kinds: ["tenant"],
	access: "read",
	input: {},
	handler: async (_input, ctx) => ctx.client.get<TenantResponse>("/api/v1/tenants/me"),
	render: (data) =>
		keyValues(data, ["id", "name", "description", "status", "corpus_count", "max_corpora", "created_at"]),
});

export const rotateMyTenantKeyTool = defineTool({
	name: "rotate_my_tenant_key",
	title: "Rotate my tenant key",
	description:
		"Replace the tenant key making this call with a new one. The key in use stops working immediately: every " +
		"client, config file and MCP server holding it must be given the new key. " +
		KEY_ONCE,
	group: "tenants",
	command: "rotate-my-key",
	kinds: ["tenant"],
	access: "destructive",
	replacesOwnKey: true,
	input: {},
	handler: async (_input, ctx) => ctx.client.request<RotateTenantKeyResponse>("POST", "/api/v1/tenants/me/rotate-key"),
	render: (data) => `${keyValues(data)}\n\n${KEY_ONCE} The old key no longer works.`,
});
