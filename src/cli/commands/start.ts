import { Command, Option } from "commander";
import { parseBoolean } from "../../core/config.js";
import { startHttpServer } from "../../server/http.js";
import { startStdio } from "../../server/stdio.js";
import type { CliIO } from "../io.js";
import { type GlobalOptions, loadCliConfig } from "../shared.js";

interface StartOptions {
	transport: "stdio" | "http";
	host: string;
	port: string;
}

export function startCommand(io: CliIO): Command {
	return new Command("start")
		.description("Run the MCP server (stdio by default; streamable HTTP with --transport http)")
		.addOption(new Option("--transport <type>", "stdio or http").choices(["stdio", "http"]).default("stdio"))
		.option("--host <host>", "HTTP bind address", "127.0.0.1")
		.option("--port <port>", "HTTP port", "3333")
		.action(async (local: StartOptions, c: Command) => {
			const opts = c.optsWithGlobals() as GlobalOptions & StartOptions;
			const config = loadCliConfig(opts, io);
			if (local.transport === "stdio") {
				await startStdio(config, io.fetch);
				return;
			}
			const port = Number(local.port);
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${local.port}`);
			const server = await startHttpServer({
				config,
				host: local.host,
				port,
				useServerKey: parseBoolean(io.env.COB_RAG_HTTP_USE_SERVER_KEY, "COB_RAG_HTTP_USE_SERVER_KEY") ?? false,
				fetch: io.fetch,
				log: (line) => io.err(line),
			});
			const stop = () => {
				void server.close().then(() => process.exit(0));
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
}
