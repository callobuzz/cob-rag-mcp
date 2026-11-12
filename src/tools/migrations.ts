import { z } from "zod";
import type { MigrationListResponse } from "../core/api-types.js";
import { pageFooter, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { uuid } from "./schemas.js";

// Embedding migrations (blue-green re-embeds after an embedding change or detected drift). The
// admin key sees every corpus's, a tenant key its own corpora's. Approving, cancelling, retrying
// and rolling back stay admin-only in the engine and are not tools here: this is a read.

export const listMigrationsTool = defineTool({
	name: "list_migrations",
	title: "List embedding migrations",
	description:
		"List embedding migrations across corpora, newest first, with their status and progress. `pending_approval` " +
		"rows are re-embeds the engine's drift check or an embedding change created and an admin has yet to approve. " +
		"Paged: `total` is every match.",
	group: "migrations",
	command: "list",
	kinds: ["admin", "tenant"],
	access: "read",
	input: {
		corpus_id: uuid("Only this corpus's migrations (a filter: no default corpus applies).").optional(),
		status: z
			.string()
			.min(1)
			.max(50)
			.optional()
			.describe("Only migrations in this status, e.g. pending_approval, queued, running, completed, failed."),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
		limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, at most 200)."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<MigrationListResponse>("/api/v1/migrations", {
			corpus_id: input.corpus_id,
			status: input.status,
			offset: input.offset,
			limit: input.limit,
		}),
	render: (data) => {
		const res = data as MigrationListResponse;
		const rows = table(
			res.items.map((m) => ({
				...m,
				to: [m.to_config.provider, m.to_config.model].filter(Boolean).join(" / "),
				progress: `${m.chunks_done}/${m.chunks_total}`,
			})),
			[
				{ key: "id" },
				{ key: "corpus_id" },
				{ key: "status" },
				{ key: "to", max: 40 },
				{ key: "progress", label: "chunks" },
				{ key: "created_at" },
				{ key: "error", max: 40 },
			],
		);
		return `${rows}\n\n${pageFooter("migration(s)", { count: res.items.length, total: res.total, offset: res.offset })}`;
	},
});
