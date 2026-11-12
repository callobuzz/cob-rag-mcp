import { z } from "zod";
import type { LeadListResponse } from "../core/api-types.js";
import { table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { compact, uuid } from "./schemas.js";

// Leads (engine conversation layer C4): contact details visitors shared with consent. They are
// contact data, so the engine gives them to a `write` key and no lower (it classifies GET /api/v1/leads as
// `write`). Both tools are `write` here, so a read key never sees them and read-only mode hides them;
// list_leads is the one named exception to "every list_* tool is a read" (visibility.test.ts).
// Tenant and admin keys only: a corpus key never sees them.
const KINDS = ["admin", "tenant"] as const;
const statusInput = z.enum(["new", "contacted", "won", "lost", "spam"]).optional().describe("Only this status.");
const day = (description: string) =>
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
		.optional()
		.describe(description);

export const listLeadsTool = defineTool({
	name: "list_leads",
	title: "List leads",
	description:
		"Leads visitors left in the website assistant (newest first) with name, phone, status and why they were " +
		"offered the form. Contains personal data: use it only to follow up with those visitors.",
	group: "leads",
	command: "list",
	kinds: KINDS,
	access: "write",
	input: {
		corpus_id: uuid("Only this knowledge base.").optional(),
		status: statusInput,
		q: z.string().max(254).optional().describe("A full phone number or e-mail (exact match)."),
		date_from: day("From this day (YYYY-MM-DD, UTC)."),
		date_to: day("Up to this day (YYYY-MM-DD, UTC)."),
		limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
		offset: z.number().int().min(0).optional(),
	},
	handler: async (input, ctx) =>
		ctx.client.get<LeadListResponse>(
			"/api/v1/leads",
			compact({
				corpus_id: input.corpus_id,
				status: input.status,
				q: input.q,
				date_from: input.date_from,
				date_to: input.date_to,
				limit: input.limit,
				offset: input.offset,
			}),
		),
	render: (data) => {
		const res = data as LeadListResponse;
		const rows = res.items.map((l) => ({ ...l, name: l.contact.name ?? "", phone: l.contact.phone ?? "" }));
		return `${table(rows, [
			{ key: "created_at", label: "when" },
			{ key: "name", max: 30 },
			{ key: "phone" },
			{ key: "status" },
			{ key: "trigger", label: "why" },
			{ key: "knowledge_base", max: 30 },
		])}\n${res.items.length} of ${res.total}`;
	},
});

export const exportLeadsTool = defineTool({
	name: "export_leads",
	title: "Export leads as CSV",
	description:
		"CSV of the matching leads with every field and the notes. Owners only (a tenant or admin key acts as an " +
		"owner); the engine records every export in the audit log. Contains personal data.",
	group: "leads",
	command: "export",
	kinds: KINDS,
	access: "write",
	input: {
		corpus_id: uuid("Only this knowledge base.").optional(),
		status: statusInput,
		date_from: day("From this day (YYYY-MM-DD, UTC)."),
		date_to: day("Up to this day (YYYY-MM-DD, UTC)."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<string>(
			"/api/v1/leads/export.csv",
			compact({
				corpus_id: input.corpus_id,
				status: input.status,
				date_from: input.date_from,
				date_to: input.date_to,
			}),
		),
	render: (data) => String(data),
});
