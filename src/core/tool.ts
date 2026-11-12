/**
 * One definition per tool. The MCP server registers it as a tool and the CLI turns it into a
 * command, so the two surfaces can never drift apart.
 */

import { z } from "zod";
import type { KeyKind, QueryStreamEvent, WhoAmI } from "./api-types.js";
import type { EngineClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { CobRagError } from "./errors.js";

export type { KeyKind };

/** read = no side effects; write = creates or changes; destructive = deletes, revokes or invalidates. */
export type Access = "read" | "write" | "destructive";
export type Surface = "stdio" | "http" | "cli";

export interface ToolContext {
	client: EngineClient;
	config: ResolvedConfig;
	surface: Surface;
	/** Known up front on the MCP server (it calls /whoami at start); undefined in the CLI. */
	identity?: WhoAmI;
	/** Set by the CLI for `--stream`: the handler sends each stream event here as it arrives. */
	stream?: (event: QueryStreamEvent) => void;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
	/** snake_case MCP tool name. */
	name: string;
	title: string;
	description: string;
	/** CLI group ("" for a top-level command) and action. */
	group: string;
	command: string;
	/** Which key kinds this tool is offered to. */
	kinds: readonly KeyKind[];
	access: Access;
	input: Shape;
	/** Input fields the CLI also accepts positionally, in order. */
	positional?: ReadonlyArray<keyof Shape & string>;
	/**
	 * The tool has a `corpus_id` input that a corpus key never needs: the MCP server hides the
	 * field from corpus keys. Where it names the corpus to act on, the handler lets tenant and
	 * admin keys fall back to the configured default (resolveCorpusId); where it only filters a
	 * list, no default applies.
	 */
	corpusScoped?: boolean;
	/**
	 * The result's `api_key` replaces the key making the call, which stops working at once. The
	 * CLI warns before running it and offers to save the new key to the config file.
	 */
	replacesOwnKey?: boolean;
	/** MCP transports that may offer the tool. Default: both. */
	mcpTransports?: ReadonlyArray<"stdio" | "http">;
	/** The CLI offers `--stream` for this tool. */
	streamable?: boolean;
	handler: (input: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<unknown>;
	/** Human-readable CLI output. Falls back to a generic table. */
	render?: (data: unknown) => string;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds tools with different input shapes
export type AnyTool = ToolDefinition<any>;

const SNAKE = /^[a-z][a-z0-9_]*$/;

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
	if (!SNAKE.test(def.name)) throw new Error(`Tool name "${def.name}" must be snake_case`);
	if (def.kinds.length === 0) throw new Error(`Tool "${def.name}" must be offered to at least one key kind`);
	if (def.corpusScoped && !("corpus_id" in def.input)) {
		throw new Error(`Tool "${def.name}" is corpusScoped but has no corpus_id input`);
	}
	for (const field of def.positional ?? []) {
		if (!(field in def.input)) throw new Error(`Tool "${def.name}" positional "${field}" is not an input`);
	}
	return Object.freeze(def);
}

/** The shared corpus_id input. */
export const corpusIdInput = z
	.string()
	.uuid()
	.optional()
	.describe(
		"Corpus to act on. Not needed with a corpus (ck_) key. Required with a tenant or admin key unless a default corpus is configured (COB_RAG_CORPUS_ID).",
	);

/**
 * The corpus a request should name, or undefined to let the engine derive it from a corpus key.
 * With `required`, a corpus key resolves to its own corpus (for routes with the id in the path).
 */
export async function resolveCorpusId(
	given: string | undefined,
	ctx: ToolContext,
	options: { required?: boolean } = {},
): Promise<string | undefined> {
	if (given) return given;
	const identity = ctx.identity ?? (options.required ? await ctx.client.whoami() : undefined);
	if (identity?.kind === "corpus") return options.required ? (identity.corpus_id ?? undefined) : undefined;
	if (ctx.config.corpusId) return ctx.config.corpusId;
	if (identity) {
		throw new CobRagError(
			`corpus_id is required with a ${identity.kind} key. Pass corpus_id, or set COB_RAG_CORPUS_ID ` +
				"(cob-rag-engine config set corpus_id <id>) to a default corpus.",
			"USAGE",
		);
	}
	return undefined;
}
