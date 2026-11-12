/**
 * Streamable HTTP transport, stateless: every POST carries the caller's own engine key, which is
 * checked with /whoami and forwarded to the engine. The server never answers with a key of its
 * own unless the operator sets COB_RAG_HTTP_USE_SERVER_KEY=true, so exposing this endpoint never
 * silently lends one key to everyone who can reach it.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WhoAmI } from "../core/api-types.js";
import { EngineClient, type LlmSettings } from "../core/client.js";
import type { ResolvedConfig } from "../core/config.js";
import { toCobRagError } from "../core/errors.js";
import { VERSION } from "../version.js";
import { createMcpServer } from "./create-server.js";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const IDENTITY_TTL_MS = 60_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface HttpServerOptions {
	config: ResolvedConfig;
	host: string;
	port: number;
	/** COB_RAG_HTTP_USE_SERVER_KEY=true: requests without a key use the configured one. */
	useServerKey: boolean;
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

export interface RunningHttpServer {
	url: string;
	address: AddressInfo;
	close(): Promise<void>;
}

/** The caller's engine key: `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function extractKey(req: IncomingMessage): string | undefined {
	const auth = req.headers.authorization;
	if (typeof auth === "string") {
		const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
		if (match?.[1]) return match[1].trim();
	}
	const header = req.headers["x-api-key"];
	const value = Array.isArray(header) ? header[0] : header;
	return value?.trim() || undefined;
}

/** Bring-your-own-key model settings the caller sent, forwarded as-is. */
export function extractLlmHeaders(req: IncomingMessage): LlmSettings {
	const get = (name: string) => {
		const v = req.headers[name];
		return (Array.isArray(v) ? v[0] : v) || undefined;
	};
	return {
		provider: get("x-llm-provider"),
		model: get("x-llm-model"),
		apiKey: get("x-llm-api-key"),
		baseUrl: get("x-llm-base-url"),
	};
}

function hostnameOf(hostHeader: string): string {
	if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
	return hostHeader.split(":")[0] ?? "";
}

function jsonRpcError(
	res: ServerResponse,
	status: number,
	message: string,
	headers: Record<string, string> = {},
): void {
	if (res.headersSent) return;
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
	const { config, host, port, useServerKey } = options;
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const loopback = LOOPBACK_HOSTS.has(host);
	// Identity lookups are cached briefly by key hash, so a chatty client does not double every call.
	const identities = new Map<string, { identity: WhoAmI; expires: number }>();

	const clientFor = (apiKey: string, llm: LlmSettings) =>
		new EngineClient({ url: config.url, apiKey, llm, userAgent: `cob-rag-mcp/${VERSION}`, fetch: options.fetch });

	async function identify(apiKey: string, client: EngineClient): Promise<WhoAmI> {
		const hash = createHash("sha256").update(apiKey).digest("hex");
		const hit = identities.get(hash);
		if (hit && hit.expires > Date.now()) return hit.identity;
		const identity = await client.whoami();
		identities.set(hash, { identity, expires: Date.now() + IDENTITY_TTL_MS });
		return identity;
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", version: VERSION }));
			return;
		}
		if (url.pathname !== "/mcp" && url.pathname !== "/") {
			jsonRpcError(res, 404, "Not found. The MCP endpoint is /mcp.");
			return;
		}

		// DNS-rebinding guard: bound to loopback, only loopback Host and Origin values are served,
		// so a web page cannot reach this server through a name that resolves to 127.0.0.1.
		if (loopback) {
			const hostHeader = req.headers.host ?? "";
			if (!LOOPBACK_HOSTS.has(hostnameOf(hostHeader))) {
				jsonRpcError(res, 403, `Host ${hostHeader || "(none)"} not allowed`);
				return;
			}
			const origin = req.headers.origin;
			if (origin) {
				let originHost = "";
				try {
					originHost = new URL(origin).hostname;
				} catch {
					// unparseable origin: refused below
				}
				if (!LOOPBACK_HOSTS.has(originHost) && !LOOPBACK_HOSTS.has(`[${originHost}]`)) {
					jsonRpcError(res, 403, `Origin ${origin} not allowed`);
					return;
				}
			}
		}

		if (req.method !== "POST") {
			// Stateless server: no standalone SSE stream and no sessions to delete.
			jsonRpcError(res, 405, "Method not allowed. This server is stateless: POST JSON-RPC to /mcp.", {
				Allow: "POST",
			});
			return;
		}

		let apiKey = extractKey(req);
		if (!apiKey && useServerKey && config.apiKey) apiKey = config.apiKey;
		if (!apiKey) {
			jsonRpcError(
				res,
				401,
				"Missing engine key. Send your cob-rag-engine key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.",
				{ "WWW-Authenticate": 'Bearer realm="cob-rag-mcp"' },
			);
			return;
		}

		const client = clientFor(apiKey, extractLlmHeaders(req));
		let identity: WhoAmI;
		try {
			identity = await identify(apiKey, client);
		} catch (err) {
			const e = toCobRagError(err);
			if (e.code === "UNAUTHORIZED") {
				jsonRpcError(res, 401, "The engine rejected this key.", { "WWW-Authenticate": 'Bearer realm="cob-rag-mcp"' });
			} else {
				jsonRpcError(res, 502, e.message);
			}
			return;
		}

		let body: unknown;
		try {
			body = JSON.parse(await readBody(req));
		} catch (err) {
			const tooLarge = (err as Error).message === "too large";
			jsonRpcError(res, tooLarge ? 413 : 400, tooLarge ? "Request body too large" : "Parse error");
			return;
		}

		const { server } = createMcpServer({
			client,
			config: { ...config, apiKey },
			identity,
			transport: "http",
		});
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	const httpServer: Server = createServer((req, res) => {
		handle(req, res).catch((err) => {
			log(`cob-rag-mcp: request failed: ${(err as Error).message}`);
			jsonRpcError(res, 500, "Internal error");
		});
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", (err: NodeJS.ErrnoException) => {
			reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use.`) : err);
		});
		httpServer.listen(port, host, () => resolve());
	});

	const address = httpServer.address() as AddressInfo;
	const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
	const url = `http://${shownHost}:${address.port}/mcp`;
	log(
		`cob-rag-mcp ${VERSION}: MCP over HTTP at ${url} -> ${config.url}` +
			`${useServerKey ? " (requests without a key use the server key)" : " (each request must carry its own key)"}`,
	);
	if (!loopback) log("cob-rag-mcp: listening beyond loopback. Put TLS in front of it: keys travel in headers.");

	return {
		url,
		address,
		close: () =>
			new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
				httpServer.closeAllConnections();
			}),
	};
}
