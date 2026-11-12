/**
 * A scripted stand-in for cob-rag-engine's HTTP API, injected as `fetch`. Each route is
 * "METHOD /path" and returns either a JSON body (200) or reply(status, body). Every call is
 * recorded with its headers and body so tests can check exactly what went over the wire.
 */

export interface RecordedCall {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Record<string, string>;
	body: unknown;
	form?: FormData;
}

export interface Reply {
	__reply: true;
	status: number;
	body?: unknown;
	/** Raw event-stream text (or bytes), one entry per network chunk. */
	sse?: Array<string | Uint8Array>;
}

export function reply(status: number, body?: unknown): Reply {
	return { __reply: true, status, body };
}

/** An SSE response carrying these named events, the way the engine writes them. */
export function sse(events: Array<[event: string, data: unknown]>): Reply {
	return sseChunks([sseText(events)]);
}

/** The engine's wire format for these events: `event: <name>\ndata: <json>\n\n` each. */
export function sseText(events: Array<[event: string, data: unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** An SSE response delivered as exactly these chunks of raw text, split wherever they are split. */
export function sseChunks(chunks: Array<string | Uint8Array>): Reply {
	return { __reply: true, status: 200, sse: chunks };
}

export type Route = (call: RecordedCall) => unknown;

export const WHOAMI = {
	corpus: {
		kind: "corpus",
		tenant_id: "11111111-1111-4111-8111-111111111111",
		tenant_name: "Acme",
		corpus_id: "22222222-2222-4222-8222-222222222222",
		corpus_name: "acme-faq",
	},
	tenant: {
		kind: "tenant",
		tenant_id: "11111111-1111-4111-8111-111111111111",
		tenant_name: "Acme",
		corpus_id: null,
		corpus_name: null,
	},
	admin: { kind: "admin", tenant_id: null, tenant_name: null, corpus_id: null, corpus_name: null },
} as const;

export const IDS = {
	corpus: "22222222-2222-4222-8222-222222222222",
	other: "33333333-3333-4333-8333-333333333333",
	doc: "44444444-4444-4444-8444-444444444444",
	job: "55555555-5555-4555-8555-555555555555",
	key: "66666666-6666-4666-8666-666666666666",
	tenant: "11111111-1111-4111-8111-111111111111",
	plan: "77777777-7777-4777-8777-777777777777",
	user: "88888888-8888-4888-8888-888888888888",
	invitation: "99999999-9999-4999-8999-999999999999",
};

export function fakeEngine(routes: Record<string, Route | unknown> = {}) {
	const calls: RecordedCall[] = [];

	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[k.toLowerCase()] = v;
		}
		let body: unknown;
		let form: FormData | undefined;
		if (init?.body instanceof FormData) {
			form = init.body;
		} else if (typeof init?.body === "string") {
			body = JSON.parse(init.body);
		}
		const call: RecordedCall = { method, path: url.pathname, query: url.searchParams, headers, body, form };
		calls.push(call);

		const route = routes[`${method} ${url.pathname}`];
		if (route === undefined) {
			return new Response(JSON.stringify({ detail: `no fake route for ${method} ${url.pathname}` }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		}
		const result = typeof route === "function" ? await (route as Route)(call) : route;
		const r = result as Partial<Reply> | undefined;
		if (r?.__reply) {
			if (r.sse) {
				const encoder = new TextEncoder();
				const chunks = r.sse;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
						controller.close();
					},
				});
				return new Response(stream, { status: r.status, headers: { "content-type": "text/event-stream" } });
			}
			return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
				status: r.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
	};

	return { fetch: fetchImpl as typeof fetch, calls, last: () => calls[calls.length - 1] as RecordedCall };
}

/**
 * POST /api/v1/corpora as the engine answers it: every corpus belongs to a tenant, so a body
 * without tenant_id (the admin key must name one) is a 422 `tenant_required`. A tenant key's
 * request would get its own tenant; tests pass `tenantOf` to play that.
 */
export function createCorpusRoute(tenantOf?: string): Route {
	return (call) => {
		const body = (call.body ?? {}) as Record<string, unknown>;
		const tenant_id = body.tenant_id ?? tenantOf;
		if (!tenant_id) {
			return reply(422, {
				detail: "tenant_id is required: every knowledge base belongs to a tenant",
				code: "tenant_required",
			});
		}
		return reply(201, { id: IDS.corpus, api_key: "ck_new", ...body, tenant_id });
	};
}

/** A complete /query/stream answer, as the engine sends it. */
export const STREAM_EVENTS: Array<[event: string, data: unknown]> = [
	[
		"sources",
		{
			query_id: IDS.job,
			sources: [
				{
					index: 1,
					chunk_id: "c1",
					document_id: IDS.doc,
					external_id: "faq-lipid",
					file_name: "Fasting",
					section: "Fasting",
					page: null,
					snippet: "Fast for 10-12 hours before a lipid profile.",
					score: 0.91,
				},
				{
					index: 2,
					chunk_id: "c2",
					document_id: IDS.doc,
					external_id: null,
					file_name: "prep.pdf",
					section: "Thyroid",
					page: 3,
					snippet: "No fasting is needed for a thyroid test.",
					score: 0.52,
				},
			],
		},
	],
	["token", { content: "Fast for " }],
	["token", { content: "10-12 hours [1]." }],
	[
		"done",
		{
			query_id: IDS.job,
			model: "qwen2.5:3b",
			latency_ms: 950,
			usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
		},
	],
];
