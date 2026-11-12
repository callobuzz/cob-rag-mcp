/**
 * A small HTTP client for cob-rag-engine. It knows three things the tools should not have to:
 * how to authenticate (X-API-Key), which routes take the bring-your-own-key X-LLM-* headers,
 * and how to turn every failure into a CobRagError that says what to do next.
 */

import type { QueryRequest, QueryStreamEvent, QueryStreamSource, QueryStreamUsage, WhoAmI } from "./api-types.js";
import { CobRagError, errorFromResponse } from "./errors.js";

/** Per-request model settings, sent as the engine's X-LLM-* headers. */
export interface LlmSettings {
	provider?: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
}

export interface EngineClientOptions {
	url: string;
	apiKey: string;
	llm?: LlmSettings;
	timeoutMs?: number;
	userAgent?: string;
	/** Injected in tests. */
	fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
	query?: Query;
	/** JSON body. */
	body?: unknown;
	/** Multipart body; takes precedence over `body`. */
	form?: FormData;
	/**
	 * Send the X-LLM-* headers. Only the query routes read them — /query, /query/stream and
	 * /query/retrieve (retrieval still resolves a model for HyDE, classification and LLM
	 * reranking) — so they are never sent anywhere else.
	 */
	llmHeaders?: boolean;
	accept?: string;
}

export const DEFAULT_TIMEOUT_MS = 180_000;

export class EngineClient {
	readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly llm: LlmSettings;
	private readonly timeoutMs: number;
	private readonly userAgent: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: EngineClientOptions) {
		this.baseUrl = options.url.replace(/\/+$/, "");
		this.apiKey = options.apiKey;
		this.llm = options.llm ?? {};
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.userAgent = options.userAgent ?? "cob-rag-mcp";
		this.fetchImpl = options.fetch ?? fetch;
	}

	/** Build the X-LLM-* headers from whichever settings are present. */
	llmHeaderValues(): Record<string, string> {
		const headers: Record<string, string> = {};
		if (this.llm.provider) headers["X-LLM-Provider"] = this.llm.provider;
		if (this.llm.model) headers["X-LLM-Model"] = this.llm.model;
		if (this.llm.apiKey) headers["X-LLM-API-Key"] = this.llm.apiKey;
		if (this.llm.baseUrl) headers["X-LLM-Base-URL"] = this.llm.baseUrl;
		return headers;
	}

	private buildUrl(path: string, query?: Query): string {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
		const headers: Record<string, string> = {
			"X-API-Key": this.apiKey,
			Accept: options.accept ?? "application/json",
			"User-Agent": this.userAgent,
		};
		let body: RequestInit["body"];
		if (options.form) {
			body = options.form;
		} else if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.body);
		}
		if (options.llmHeaders) Object.assign(headers, this.llmHeaderValues());

		const url = this.buildUrl(path, options.query);
		try {
			return await this.fetchImpl(url, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const name = (err as { name?: string })?.name;
			if (name === "TimeoutError" || name === "AbortError") {
				throw new CobRagError(
					`cob-rag-engine at ${this.baseUrl} did not answer within ${Math.round(this.timeoutMs / 1000)}s.`,
					"TIMEOUT",
				);
			}
			const cause = (err as { cause?: { code?: string } })?.cause?.code;
			throw new CobRagError(
				`Cannot reach cob-rag-engine at ${this.baseUrl}${cause ? ` (${cause})` : ""}. ` +
					"Is the engine running, and is COB_RAG_URL right? There is no hosted service: " +
					"this package talks to the engine you run yourself.",
				"ENGINE_UNREACHABLE",
			);
		}
	}

	private async readBody(res: Response): Promise<unknown> {
		const text = await res.text();
		if (!text) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const res = await this.send(method, path, options);
		const body = await this.readBody(res);
		if (!res.ok) throw errorFromResponse(res.status, body, this.baseUrl);
		return body as T;
	}

	get<T>(path: string, query?: Query): Promise<T> {
		return this.request<T>("GET", path, { query });
	}

	whoami(): Promise<WhoAmI> {
		return this.get<WhoAmI>("/api/v1/whoami");
	}

	/**
	 * POST to an SSE route and yield each event as it completes, however the bytes are split
	 * across network chunks. `data` is the parsed JSON payload (the raw text when it is not JSON).
	 * A failure before the stream starts is the engine's HTTP error, as for any request.
	 */
	async *streamEvents(path: string, body: unknown): AsyncGenerator<SseEvent> {
		const res = await this.send("POST", path, { body, llmHeaders: true, accept: "text/event-stream" });
		if (!res.ok) throw errorFromResponse(res.status, await this.readBody(res), this.baseUrl);
		if (!res.body) return;

		const parser = new SseParser();
		const decoder = new TextDecoder();
		const chunks = (res.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
		try {
			for (;;) {
				let next: IteratorResult<Uint8Array>;
				try {
					next = await chunks.next();
				} catch (err) {
					throw this.streamFailure(err);
				}
				if (next.done) break;
				yield* parser.push(decoder.decode(next.value, { stream: true }));
			}
		} finally {
			// Stop reading when the consumer stops early (an error event, a thrown callback).
			try {
				await chunks.return?.();
			} catch {
				// Already closed.
			}
		}
		yield* parser.push(decoder.decode());
		yield* parser.end();
	}

	private streamFailure(err: unknown): CobRagError {
		const name = (err as { name?: string })?.name;
		if (name === "TimeoutError" || name === "AbortError") {
			return new CobRagError(
				`The answer from cob-rag-engine at ${this.baseUrl} did not finish within ${Math.round(this.timeoutMs / 1000)}s.`,
				"TIMEOUT",
			);
		}
		return new CobRagError(
			`The stream from cob-rag-engine at ${this.baseUrl} broke off: ${(err as Error)?.message ?? String(err)}`,
			"ENGINE_ERROR",
		);
	}

	/**
	 * Stream an answer from /query/stream. Every event goes to `onEvent` as it arrives, tokens
	 * included, and the result gathers them. An `error` event, a stream that ends before `done`,
	 * and an engine still sending the old unnamed `data:` format each throw a CobRagError.
	 */
	async streamQuery(body: QueryRequest, onEvent?: (event: QueryStreamEvent) => void): Promise<StreamedAnswer> {
		let sources: QueryStreamSource[] = [];
		const parts: string[] = [];
		for await (const raw of this.streamEvents("/api/v1/query/stream", body)) {
			const event = toQueryStreamEvent(raw);
			onEvent?.(event);
			switch (event.event) {
				case "sources":
					sources = event.data.sources;
					break;
				case "token":
					parts.push(event.data.content);
					break;
				case "error":
					throw new CobRagError(`The engine stopped part-way through the answer: ${event.data.detail}`, "ENGINE_ERROR");
				case "done":
					return {
						query_id: event.data.query_id,
						answer: parts.join(""),
						sources,
						model: event.data.model,
						latency_ms: event.data.latency_ms,
						usage: event.data.usage,
					};
			}
		}
		throw new CobRagError(
			"The engine closed the stream before the answer was finished (no `done` event).",
			"ENGINE_ERROR",
		);
	}
}

/** A complete answer gathered from /query/stream. */
export interface StreamedAnswer {
	query_id: string;
	answer: string;
	sources: QueryStreamSource[];
	model: string;
	latency_ms: number;
	/** Estimated by the engine: providers report no usage on a stream. */
	usage: QueryStreamUsage;
}

/** One Server-Sent Event: its name (`message` when unnamed) and its parsed `data`. */
export interface SseEvent {
	event: string;
	data: unknown;
}

const QUERY_STREAM_EVENTS = new Set(["sources", "token", "done", "error"]);

function toQueryStreamEvent(raw: SseEvent): QueryStreamEvent {
	if (!QUERY_STREAM_EVENTS.has(raw.event)) {
		if (raw.event === "message") {
			throw new CobRagError(
				"This cob-rag-engine sends the old /query/stream format (unnamed data lines). " +
					"Upgrade the engine, or run ask without --stream.",
				"ENGINE_ERROR",
			);
		}
		throw new CobRagError(`Unexpected event "${raw.event}" from /query/stream.`, "ENGINE_ERROR");
	}
	if (raw.data === null || typeof raw.data !== "object") {
		throw new CobRagError(`Malformed "${raw.event}" event from /query/stream.`, "ENGINE_ERROR");
	}
	return raw as QueryStreamEvent;
}

/**
 * An incremental Server-Sent Events parser, following the event-stream rules that matter here:
 * lines end in LF, CRLF or CR; `event:` names the event; `data:` lines join with LF; a line
 * starting with ":" is a comment; a blank line dispatches. Text may arrive split anywhere.
 */
export class SseParser {
	private buffer = "";
	private event = "";
	private data: string[] = [];

	/** Feed decoded text; returns the events it completed. */
	push(text: string): SseEvent[] {
		this.buffer += text;
		const out: SseEvent[] = [];
		for (;;) {
			const match = /\r\n|\r|\n/.exec(this.buffer);
			// A CR at the very end may be the first half of a CRLF split across chunks.
			if (!match || (match[0] === "\r" && match.index === this.buffer.length - 1)) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const event = this.line(line);
			if (event) out.push(event);
		}
		return out;
	}

	/** The stream ended: dispatch whatever is complete. */
	end(): SseEvent[] {
		const out: SseEvent[] = [];
		for (const line of [this.buffer.replace(/\r$/, ""), ""]) {
			const event = this.line(line);
			if (event) out.push(event);
		}
		this.buffer = "";
		return out;
	}

	private line(line: string): SseEvent | undefined {
		if (line === "") {
			const event =
				this.data.length > 0 ? { event: this.event || "message", data: parseData(this.data.join("\n")) } : undefined;
			this.event = "";
			this.data = [];
			return event;
		}
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		return undefined;
	}
}

function parseData(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Encode one path segment. Ids are UUIDs, but nothing a caller passes may change the route. */
export function seg(value: string): string {
	return encodeURIComponent(value);
}
