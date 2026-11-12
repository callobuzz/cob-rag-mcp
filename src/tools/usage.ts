import { z } from "zod";
import type { UsageResponse } from "../core/api-types.js";
import { table } from "../core/format.js";
import { corpusIdInput, defineTool } from "../core/tool.js";
import { uuid } from "./schemas.js";

const date = (description: string) =>
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
		.optional()
		.describe(description);

export const getUsageTool = defineTool({
	name: "get_usage",
	title: "Usage and cost",
	description:
		"Requests, tokens and estimated LLM cost for answered questions, grouped by day, corpus, source or tenant. " +
		"Sources: api (ask), stream (streamed ask), conversation (conversation messages) and widget:<key id> " +
		"(the website chat widget).",
	group: "",
	command: "usage",
	kinds: ["admin", "tenant", "corpus"],
	access: "read",
	// corpus_id here is a filter, never defaulted: a corpus key is already limited to its corpus.
	corpusScoped: true,
	input: {
		corpus_id: corpusIdInput.describe("Limit to one corpus (tenant and admin keys)."),
		tenant_id: uuid("Admin keys only: limit to one tenant.").optional(),
		start: date("First day, UTC (default 30 days ago)."),
		end: date("Last day, UTC (default today)."),
		group_by: z.enum(["day", "corpus", "source", "tenant"]).optional().describe("Default: day."),
	},
	handler: async (input, ctx) =>
		ctx.client.get<UsageResponse>("/api/v1/usage", {
			corpus_id: input.corpus_id,
			tenant_id: input.tenant_id,
			start: input.start,
			end: input.end,
			group_by: input.group_by,
		}),
	render: (data) => {
		const res = data as UsageResponse;
		const columns = [
			{ key: "key", label: res.group_by },
			{ key: "requests" },
			{ key: "prompt_tokens" },
			{ key: "completion_tokens" },
			{ key: "cost_usd" },
		];
		const totals = { ...res.totals, key: "TOTAL" };
		return `${res.start} to ${res.end}\n\n${table([...res.rows, totals], columns)}`;
	},
});
