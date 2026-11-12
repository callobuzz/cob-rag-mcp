/**
 * The CLI program. Two bins share it: `cob-rag-engine` for the shell and `cob-rag-mcp` for MCP
 * client configs (`cob-rag-mcp start`). Every tool is a command; a few commands (start, login,
 * config, tools) are the CLI's own.
 */

import { Command, Option } from "commander";
import { formatTable } from "../core/format.js";
import { ALL_TOOLS } from "../tools/index.js";
import { VERSION } from "../version.js";
import { configCommand } from "./commands/config.js";
import { loginCommand } from "./commands/login.js";
import { startCommand } from "./commands/start.js";
import type { CliIO } from "./io.js";
import { toolToCommand } from "./tool-command.js";

const GROUPS: Record<string, string> = {
	documents: "Documents in a corpus, and the chunks the engine indexed",
	ingest: "Add content and follow ingest jobs",
	feedback: "Ratings people gave answers",
	leads: "Contact details website visitors shared with consent (tenant and admin keys)",
	settings: "A corpus's prompt and retrieval settings",
	assistant: "A knowledge base's assistant: persona, scope and rules (draft, publish)",
	corpora: "Knowledge bases (tenant and admin keys)",
	migrations: "Embedding migrations (tenant and admin keys)",
	"widget-keys": "Website chat widget keys",
	tenants: "Client businesses (admin key; a tenant key: me, rotate-my-key)",
	team: "A tenant's people and invitations (tenant key: its own; admin key: any tenant)",
	plans: "Plans and their limits (admin key; usage: a tenant key's own too)",
	engine: "Sign-up mode and white-label branding (admin key)",
};

export function buildProgram(io: CliIO): Command {
	const program = new Command("cob-rag-engine")
		.description(
			"CLI and MCP server for cob-rag-engine, the self-hosted knowledge layer for AI assistants and agents.\n" +
				"There is no hosted service: point it at the engine you run (--url / COB_RAG_URL).",
		)
		.version(VERSION)
		.option("--url <url>", "Engine URL (env COB_RAG_URL, default http://127.0.0.1:8000)")
		.option("--key <key>", "Engine key: admin, tk_ or ck_ (env COB_RAG_API_KEY)")
		.option("--config <path>", "Config file (env COB_RAG_CONFIG)")
		.option("--json", "Print JSON instead of tables")
		.option("-y, --yes", "Confirm destructive commands without asking")
		.option("--read-only", "Refuse every command that changes data (env COB_RAG_READ_ONLY)")
		.addOption(
			new Option("--allow-destructive", "Offer destructive tools to MCP clients (env COB_RAG_ALLOW_DESTRUCTIVE)"),
		)
		.showHelpAfterError()
		.configureOutput({
			writeOut: (s) => io.write(s),
			writeErr: (s) => io.err(s.trimEnd()),
		});

	program.addCommand(startCommand(io));
	program.addCommand(loginCommand(io));
	program.addCommand(configCommand(io));

	const groups = new Map<string, Command>();
	for (const tool of ALL_TOOLS) {
		const command = toolToCommand(tool, io);
		if (!tool.group) {
			program.addCommand(command);
			continue;
		}
		let group = groups.get(tool.group);
		if (!group) {
			group = new Command(tool.group).description(GROUPS[tool.group] ?? tool.group);
			groups.set(tool.group, group);
			program.addCommand(group);
		}
		group.addCommand(command);
	}

	program
		.command("tools")
		.description("List every tool, its CLI command, and which key kinds can use it")
		.action((_opts, c: Command) => {
			const rows = ALL_TOOLS.map((t) => ({
				tool: t.name,
				command: [t.group, t.command].filter(Boolean).join(" "),
				keys: t.kinds.join(", "),
				access: t.access,
			}));
			if ((c.optsWithGlobals() as { json?: boolean }).json) {
				io.out(JSON.stringify(rows, null, 2));
				return;
			}
			io.out(
				formatTable(
					["tool", "command", "keys", "access"],
					rows.map((r) => [r.tool, r.command, r.keys, r.access]),
				),
			);
		});

	return program;
}
