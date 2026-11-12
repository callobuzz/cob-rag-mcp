import { z } from "zod";
import type {
	QueryRequest,
	QueryResponse,
	RetrievedChunk,
	RetrieveRequest,
	RetrieveResponse,
} from "../core/api-types.js";
import type { StreamedAnswer } from "../core/client.js";
import { sourceLabel } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";
import { categoryInput, compact, finalKInput, metadataFiltersInput, searchModeInput, topKInput } from "./schemas.js";

const ALL = ["admin", "tenant", "corpus"] as const;

export interface SearchResult {
	query: string;
	total_chunks: number;
	latency_ms: number;
	chunks: Array<Omit<RetrievedChunk, "score_breakdown"> & Partial<Pick<RetrievedChunk, "score_breakdown">>>;
	stage_timings_ms?: Record<string, number>;
}

export const searchTool = defineTool({
	name: "search",
	title: "Search the knowledge base",
	description:
		"Search this business's knowledge base and return the most relevant passages, each with its source " +
		"(file name or record id, section, page). No answer is generated: read the passages, answer from them, " +
		"and cite the sources you used. Prefer this over `ask` when you can reason over the text yourself.",
	group: "",
	command: "search",
	kinds: ALL,
	access: "read",
	positional: ["query"],
	corpusScoped: true,
	input: {
		query: z.string().min(1).max(8000).describe("What to look for: a question, keywords, or a whole passage."),
		corpus_id: corpusIdInput,
		final_k: finalKInput,
		top_k: topKInput,
		search_mode: searchModeInput,
		category: categoryInput,
		metadata_filters: metadataFiltersInput,
		verbose: z.boolean().optional().describe("Include per-stage scores and timings."),
	},
	handler: async (input, ctx): Promise<SearchResult> => {
		const body: RetrieveRequest = {
			query: input.query,
			...compact({ corpus_id: await resolveCorpusId(input.corpus_id, ctx) }),
			options: compact({
				final_k: input.final_k,
				top_k: input.top_k,
				search_mode: input.search_mode,
				category: input.category,
				metadata_filters: input.metadata_filters,
			}),
		};
		const res = await ctx.client.request<RetrieveResponse>("POST", "/api/v1/query/retrieve", {
			body,
			llmHeaders: true,
		});
		const chunks = input.verbose ? res.chunks : res.chunks.map(({ score_breakdown: _drop, ...rest }) => rest);
		return {
			query: res.processed_query,
			total_chunks: res.total_chunks,
			latency_ms: res.latency_ms,
			chunks,
			...(input.verbose ? { stage_timings_ms: res.stage_timings_ms } : {}),
		};
	},
	render: (data) => {
		const res = data as SearchResult;
		if (res.chunks.length === 0) return "No matching passages.";
		const blocks = res.chunks.map(
			(c, i) => `[${i + 1}] ${sourceLabel(c)}  (score ${c.score.toFixed(3)})\n${indent(c.text.trim())}`,
		);
		return `${blocks.join("\n\n")}\n\n${res.total_chunks} passages in ${res.latency_ms} ms`;
	},
});

export const askTool = defineTool({
	name: "ask",
	title: "Ask for a cited answer",
	description:
		"Ask the knowledge base a question and get a complete answer written by the engine's configured model, " +
		"with citations and a confidence score. Needs a model configured in the engine (or bring-your-own-key " +
		"settings). Use `search` instead when you want the raw passages.",
	group: "",
	command: "ask",
	kinds: ALL,
	access: "read",
	positional: ["query"],
	corpusScoped: true,
	streamable: true,
	input: {
		query: z.string().min(1).max(2000).describe("The question."),
		corpus_id: corpusIdInput,
		system_prompt: z.string().max(4000).optional().describe("Override the system prompt for this request only."),
		final_k: finalKInput,
		search_mode: searchModeInput,
		category: categoryInput,
		metadata_filters: metadataFiltersInput,
	},
	handler: async (input, ctx) => {
		const body: QueryRequest = {
			query: input.query,
			...compact({
				corpus_id: await resolveCorpusId(input.corpus_id, ctx),
				system_prompt: input.system_prompt,
			}),
			options: compact({
				final_k: input.final_k,
				search_mode: input.search_mode,
				category: input.category,
				metadata_filters: input.metadata_filters,
			}),
		};
		if (ctx.stream) {
			// CLI only: an MCP tool call returns one result, so MCP clients get /query's complete
			// answer. The stream has sources and timing but no confidence (it is never validated).
			const streamed: StreamedAskResult = { streamed: true, ...(await ctx.client.streamQuery(body, ctx.stream)) };
			return streamed;
		}
		return ctx.client.request<QueryResponse>("POST", "/api/v1/query", { body, llmHeaders: true });
	},
	render: (data) => {
		if ((data as { streamed?: boolean }).streamed) return renderStreamedTrailer(data as StreamedAskResult);
		const res = data as QueryResponse;
		const lines = [res.answer.trim()];
		const citations = res.citations ?? [];
		if (citations.length > 0) {
			lines.push("", "Sources:");
			citations.forEach((c, i) => {
				lines.push(`  [${i + 1}] ${sourceLabel(c)}`);
			});
		}
		lines.push("", `confidence ${res.confidence.toFixed(2)} | ${res.model_used} | ${res.latency_ms} ms`);
		return lines.join("\n");
	},
});

export type StreamedAskResult = StreamedAnswer & { streamed: true };

/** What follows a streamed answer (its text was already printed token by token). */
function renderStreamedTrailer(res: StreamedAskResult): string {
	const lines: string[] = [];
	if (res.sources.length > 0) {
		lines.push("", "Sources:");
		for (const s of res.sources) lines.push(`  [${s.index}] ${sourceLabel(s)}`);
	}
	lines.push("", `${res.model} | ${res.latency_ms} ms`);
	return lines.join("\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}
