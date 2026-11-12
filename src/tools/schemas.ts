/**
 * Zod mirrors of the engine's request schemas (docs/openapi.json in cob-rag-engine). Field names,
 * bounds and enums match the spec; the `satisfies` checks against the generated types make the
 * typecheck fail if the spec drops or renames a field.
 */

import { z } from "zod";
import type { components } from "../generated/engine-api.js";

type Schemas = components["schemas"];

/** Keys of T that are not in the engine's schema S. Must be never. */
type Extra<T, S> = Exclude<keyof T, keyof S>;
function assertSubset<T, S>(_check: Extra<T, S> extends never ? true : Extra<T, S>): void {}

export const uuid = (description: string) => z.string().uuid().describe(description);

export const searchModeInput = z
	.enum(["dense", "hybrid", "keyword"])
	.optional()
	.describe(
		"'hybrid' = meaning plus keywords (finds exact ids, SKUs, codes); 'dense' = meaning only; 'keyword' = BM25 only. Omit for the corpus setting.",
	);

export const finalKInput = z
	.number()
	.int()
	.min(1)
	.max(100)
	.optional()
	.describe("How many passages to return. Omit for the corpus setting.");

export const topKInput = z
	.number()
	.int()
	.min(1)
	.max(100)
	.optional()
	.describe("Retrieval width: candidates pulled before ranking. Not the number returned (that is final_k).");

export const categoryInput = z.string().max(50).optional().describe("Only search content in this category.");

export const metadataFiltersInput = z
	.record(z.string())
	.optional()
	.describe('Exact-match filters on document metadata, e.g. {"lang": "en"}.');

export const promptConfigSchema = z
	.object({
		system_prompt: z.string().max(10000).optional().describe("Custom system prompt for this corpus."),
		constraints: z.string().max(5000).optional().describe("Additional constraints appended to the system prompt."),
		response_language: z.string().max(50).optional().describe("Preferred response language, e.g. 'en'."),
	})
	.strict();
assertSubset<z.infer<typeof promptConfigSchema>, Schemas["PromptConfigInput"]>(true);

export const retrievalConfigSchema = z
	.object({
		preset: z.string().optional().describe("'economy', 'standard' or 'premium'; individual fields below override it."),
		top_k: topKInput,
		final_k: finalKInput,
		hybrid_search_enabled: z.boolean().optional(),
		fusion_strategy: z.enum(["convex", "rrf"]).optional(),
		hybrid_dense_weight: z.number().min(0).max(1).optional(),
		rrf_k: z.number().int().min(1).max(1000).optional(),
		reranking_enabled: z.boolean().optional(),
		rerank_provider: z.enum(["local", "llm"]).optional(),
		rerank_llm_model: z.string().optional(),
		mmr_enabled: z.boolean().optional(),
		mmr_lambda: z.number().min(0).max(1).optional(),
		hyde_enabled: z.boolean().optional(),
		multi_query_count: z.number().int().min(1).max(5).optional(),
		query_classification_enabled: z.boolean().optional(),
		temporal_decay_enabled: z.boolean().optional(),
		validation_enabled: z.boolean().optional(),
		cache_enabled: z.boolean().optional(),
		pipeline_order_enabled: z.boolean().optional(),
	})
	.strict();
assertSubset<z.infer<typeof retrievalConfigSchema>, Schemas["RetrievalConfigInput"]>(true);

export const llmConfigSchema = z
	.object({
		provider: z.string().max(64).optional().describe("LiteLLM provider id, e.g. 'openai', 'anthropic', 'ollama'."),
		model: z.string().optional().describe("LiteLLM model string."),
		api_key: z.string().optional().describe("Provider API key (encrypted at rest by the engine)."),
		base_url: z.string().optional().describe("Custom API base URL, e.g. an Ollama server."),
		fast_model: z.string().optional().describe("Cheaper model for query understanding."),
		temperature: z.number().min(0).max(2).optional(),
		max_tokens: z.number().int().min(1).max(100000).optional(),
	})
	.strict();
assertSubset<z.infer<typeof llmConfigSchema>, Schemas["LLMConfigInput"]>(true);

/**
 * The update form of a config section: every field may also be null, which the engine takes as
 * "remove this override" so the next tier (corpus preset, then engine default) applies again.
 * Leaving a field out changes nothing.
 */
function clearable<Shape extends z.ZodRawShape>(section: z.ZodObject<Shape>) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, field] of Object.entries(section.shape)) {
		const inner = field instanceof z.ZodOptional ? (field.unwrap() as z.ZodTypeAny) : field;
		const said = field.description ?? inner.description;
		shape[key] = inner
			.nullable()
			.optional()
			.describe(said ? `${said} null removes it.` : "null removes it.");
	}
	return z.object(shape).strict() as unknown as z.ZodObject<{
		[K in keyof Shape]: z.ZodOptional<z.ZodNullable<Shape[K] extends z.ZodOptional<infer T> ? T : Shape[K]>>;
	}>;
}

export const promptConfigUpdateSchema = clearable(promptConfigSchema);
assertSubset<z.infer<typeof promptConfigUpdateSchema>, Schemas["PromptConfigInput"]>(true);
export const retrievalConfigUpdateSchema = clearable(retrievalConfigSchema);
assertSubset<z.infer<typeof retrievalConfigUpdateSchema>, Schemas["RetrievalConfigInput"]>(true);
export const llmConfigUpdateSchema = clearable(llmConfigSchema);
assertSubset<z.infer<typeof llmConfigUpdateSchema>, Schemas["LLMConfigInput"]>(true);

/** How the engine applies nulls on an update, for tool descriptions. */
export const CLEARING_RULES =
	"Inside a settings object, a field set to null is removed (the engine default applies again), a field left " +
	"out is unchanged, and {} changes nothing; a whole object set to null resets it to engine defaults.";

export const embeddingConfigSchema = z
	.object({
		provider: z.string().optional().describe("'local', 'tei' or 'jina'."),
		model: z.string().optional().describe("Model from the engine's embedding catalog, e.g. 'BAAI/bge-m3'."),
		api_key: z.string().optional().describe("API key for an external provider."),
	})
	.strict();
assertSubset<z.infer<typeof embeddingConfigSchema>, Schemas["EmbeddingConfigInput"]>(true);

export const widgetAppearanceSchema = z
	.object({
		title: z.string().max(80).optional().describe("Header text of the chat panel."),
		greeting: z.string().max(500).optional().describe("First assistant message a visitor sees."),
		placeholder: z.string().max(120).optional().describe("Input placeholder text."),
		primary_color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional()
			.describe("Brand colour, e.g. #4f46e5."),
		position: z.enum(["right", "left"]).optional(),
		show_sources: z.boolean().optional().describe("Show the documents an answer used."),
	})
	.strict();
assertSubset<z.infer<typeof widgetAppearanceSchema>, Schemas["WidgetAppearance"]>(true);

export const recordSchema = z
	.object({
		id: z.string().min(1).max(500).describe("Your id for this record. Sending the same id again replaces it."),
		text: z.string().min(1).max(200000).describe("The record's content."),
		title: z.string().max(1000).optional(),
		url: z.string().max(2000).optional(),
		metadata: z
			.record(z.string())
			.optional()
			.describe("Filterable metadata; 'category' and 'user_id' have their own filters."),
	})
	.strict();
assertSubset<z.infer<typeof recordSchema>, Schemas["RecordInput"]>(true);

/** Drop undefined values so request bodies carry only what the caller set. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) (out as Record<string, unknown>)[key] = value;
	}
	return out;
}
