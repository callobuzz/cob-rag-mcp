import { z } from "zod";
import type { FeedbackListResponse } from "../core/api-types.js";
import { CobRagError } from "../core/errors.js";
import { pageFooter, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { uuid } from "./schemas.js";

// GET /api/v1/feedback answers every key kind, scoped through the rated answer's corpus: a corpus
// key sees its own, a tenant key its corpora, the admin key all.
const ALL = ["admin", "tenant", "corpus"] as const;

/** An ISO 8601 date or date-time, as the engine's datetime query parameters take it. */
const isoTime = (description: string) =>
	z
		.string()
		.regex(
			/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
			"Use an ISO 8601 date or date-time, e.g. 2026-09-01 or 2026-09-01T00:00:00Z",
		)
		.optional()
		.describe(description);

const rating = (description: string) => z.number().int().min(1).max(5).optional().describe(description);

export const listFeedbackTool = defineTool({
	name: "list_feedback",
	title: "List feedback",
	description:
		"List the ratings people gave answers, newest first, each with its question, query_id and corpus. Filter by " +
		"corpus, rating range and time. Paged: `total` is every match.",
	group: "feedback",
	command: "list",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: {
		corpus_id: uuid("Only feedback on this corpus's answers (a filter: no default corpus applies).").optional(),
		min_rating: rating("Lowest rating to include (1-5)."),
		max_rating: rating("Highest rating to include (1-5)."),
		start: isoTime("Given at or after this time (ISO 8601)."),
		end: isoTime("Given before this time (ISO 8601)."),
		offset: z.number().int().min(0).optional().describe("How many to skip (default 0)."),
		limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20, at most 100)."),
	},
	handler: async (input, ctx) => {
		if (input.min_rating !== undefined && input.max_rating !== undefined && input.min_rating > input.max_rating) {
			throw new CobRagError("min_rating is above max_rating.", "USAGE");
		}
		return ctx.client.get<FeedbackListResponse>("/api/v1/feedback", {
			corpus_id: input.corpus_id,
			min_rating: input.min_rating,
			max_rating: input.max_rating,
			start: input.start,
			end: input.end,
			offset: input.offset,
			limit: input.limit,
		});
	},
	render: (data) => {
		const res = data as FeedbackListResponse;
		const rows = table(res.items, [
			{ key: "rating" },
			{ key: "question", max: 50 },
			{ key: "correction", max: 30 },
			{ key: "feedback_type", label: "type" },
			{ key: "corpus_id" },
			{ key: "query_id" },
			{ key: "created_at" },
		]);
		return `${rows}\n\n${pageFooter("rating(s)", { count: res.items.length, total: res.total, offset: res.offset })}`;
	},
});
