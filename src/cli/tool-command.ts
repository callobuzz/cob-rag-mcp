/**
 * Turn a tool definition into a Commander command: options from its zod input, positional
 * arguments where the tool declares them, and the CLI's safety rules (read-only refuses writes,
 * destructive commands ask first or need --yes).
 */

import { Command } from "commander";
import { z } from "zod";
import { EngineClient } from "../core/client.js";
import { maskSecret, type ResolvedConfig, readConfigFile, writeConfigFile } from "../core/config.js";
import { CobRagError } from "../core/errors.js";
import { autoFormat } from "../core/format.js";
import type { AnyTool, ToolContext } from "../core/tool.js";
import { VERSION } from "../version.js";
import type { CliIO } from "./io.js";
import { addFieldOption, attrName, coerceField, flagName } from "./options.js";
import { type GlobalOptions, loadCliConfig } from "./shared.js";

export function toolToCommand(tool: AnyTool, io: CliIO): Command {
	const cmd = new Command(tool.command).description(tool.description).summary(firstSentence(tool.description));
	const positional = new Set<string>(tool.positional ?? []);

	for (const name of tool.positional ?? []) {
		cmd.argument(`[${name}]`, `same as --${flagName(name)}`);
	}
	for (const [key, schema] of Object.entries(tool.input as z.ZodRawShape)) {
		addFieldOption(cmd, key, schema);
	}
	if (tool.replacesOwnKey) {
		cmd.option("--save-key", "Save the new key to the config file without asking");
	}
	if (tool.streamable) {
		cmd.option(
			"--stream",
			"Print the answer as it is generated, then its sources; with --json, one JSON event per line",
		);
	}

	cmd.action(async (...args: unknown[]) => {
		const command = args[args.length - 1] as Command;
		const opts = command.optsWithGlobals() as GlobalOptions & Record<string, unknown>;
		const positionalValues = args.slice(0, (tool.positional ?? []).length) as Array<string | undefined>;

		const raw: Record<string, unknown> = {};
		for (const [key, schema] of Object.entries(tool.input as z.ZodRawShape)) {
			let value = opts[attrName(key)];
			if (value === undefined && positional.has(key)) {
				value = positionalValues[(tool.positional ?? []).indexOf(key)];
			}
			const coerced = coerceField(value, key, schema);
			if (coerced !== undefined) raw[key] = coerced;
		}

		const parsed = z
			.object(tool.input as z.ZodRawShape)
			.strict()
			.safeParse(raw);
		if (!parsed.success) {
			const problems = parsed.error.issues.map((i) => {
				const field = i.path[0] !== undefined ? `--${flagName(String(i.path[0]))}` : "input";
				const rest = i.path.slice(1).join(".");
				return `  ${field}${rest ? ` (${rest})` : ""}: ${i.message}`;
			});
			throw new CobRagError(`Invalid input for "${commandPath(command)}":\n${problems.join("\n")}`, "USAGE");
		}

		const config = loadCliConfig(opts, io);
		if (config.readOnly && tool.access !== "read") {
			throw new CobRagError(`"${commandPath(command)}" changes data and read-only mode is on.`, "REFUSED");
		}
		if (!config.apiKey) {
			throw new CobRagError(
				"No engine key. Run `cob-rag-engine login --url <engine url> --key <key>`, or set COB_RAG_API_KEY.",
				"CONFIG",
			);
		}
		if (tool.access === "destructive" && !(await confirmDestructive(tool, parsed.data, config, opts, io))) {
			throw new CobRagError("Cancelled.", "REFUSED");
		}

		const client = new EngineClient({
			url: config.url,
			apiKey: config.apiKey,
			llm: config.llm,
			userAgent: `cob-rag-engine-cli/${VERSION}`,
			fetch: io.fetch,
		});
		const ctx: ToolContext = { client, config, surface: "cli" };
		// A line of answer text is open until something ends it with a newline.
		let lineOpen = false;
		if (opts.stream && opts.json) {
			// JSON lines: one {"event", "data"} object per event, as it arrives.
			ctx.stream = (event) => io.out(JSON.stringify(event));
		} else if (opts.stream) {
			ctx.stream = (event) => {
				if (event.event !== "token" || !event.data.content) return;
				io.write(event.data.content);
				lineOpen = !event.data.content.endsWith("\n");
			};
		}

		let data: unknown;
		try {
			data = await tool.handler(parsed.data, ctx);
		} finally {
			// Close a half-printed answer so an error, or the sources, start on their own line.
			if (lineOpen) io.out("");
		}
		if (opts.stream && opts.json) return;
		if (opts.json) {
			io.out(JSON.stringify(data, null, 2));
		} else {
			const text = tool.render ? tool.render(data) : autoFormat(data);
			if (text) io.out(text);
		}
		if (tool.replacesOwnKey) await offerToSaveNewKey(data, config, opts, io);
	});

	return cmd;
}

function commandPath(cmd: Command): string {
	const parts: string[] = [];
	let current: Command | null = cmd;
	while (current?.parent) {
		parts.unshift(current.name());
		current = current.parent;
	}
	return parts.join(" ");
}

/** Where the key in use came from, in words a person can act on. */
function keySource(config: ResolvedConfig): string {
	switch (config.sources.api_key) {
		case "flag":
			return "--key";
		case "env":
			return "COB_RAG_API_KEY";
		default:
			return `the config file ${config.configPath}`;
	}
}

async function confirmDestructive(
	tool: AnyTool,
	input: Record<string, unknown>,
	config: ResolvedConfig,
	opts: GlobalOptions,
	io: CliIO,
): Promise<boolean> {
	if (tool.replacesOwnKey) {
		// Said even with --yes: afterwards, this CLI's own key is dead.
		io.err(
			`Warning: the key in use (${maskSecret(config.apiKey)}, from ${keySource(config)}) stops working immediately. ` +
				"Every client and MCP server holding it needs the new key.",
		);
	}
	if (opts.yes) return true;
	if (!io.interactive) {
		throw new CobRagError(
			`"${tool.title}" cannot be undone. Re-run with --yes to confirm when not at a terminal.`,
			"REFUSED",
		);
	}
	const target = Object.entries(input)
		.filter(([, v]) => typeof v === "string")
		.map(([k, v]) => `${k}=${v as string}`)
		.join(" ");
	const answer = await io.prompt(
		`${tool.title}${target ? ` (${target})` : ""}: this cannot be undone. Continue? [y/N] `,
	);
	return /^y(es)?$/i.test(answer);
}

/**
 * After a tool replaced the key in use: save the new key to the config file (with --save-key, or
 * when the person says yes), and say plainly what still holds the old one.
 */
async function offerToSaveNewKey(
	data: unknown,
	config: ResolvedConfig,
	opts: GlobalOptions & { saveKey?: boolean },
	io: CliIO,
): Promise<void> {
	const newKey = (data as { api_key?: unknown } | null)?.api_key;
	if (typeof newKey !== "string" || !newKey) return;
	const path = config.configPath;
	let save = Boolean(opts.saveKey);
	if (!save && io.interactive) {
		save = /^y(es)?$/i.test(await io.prompt(`Save the new key to ${path}? [y/N] `));
	}
	if (save) {
		writeConfigFile(path, { ...readConfigFile(path), api_key: newKey });
		io.err(`Saved the new key (${maskSecret(newKey)}) to ${path}.`);
	} else if (config.sources.api_key === "file") {
		io.err(
			`The key saved in ${path} no longer works. Save the new one with ` +
				"`cob-rag-engine config set api_key <new key>`, or re-run with --save-key next time.",
		);
	} else {
		io.err("The new key was not saved. Store it now: it is not shown again.");
	}
	if (config.sources.api_key === "env" || config.sources.api_key === "flag") {
		io.err(
			`${keySource(config)} still holds the old key, which no longer works: replace it with the new one` +
				(save ? " (it takes precedence over the config file)." : "."),
		);
	}
}

function firstSentence(text: string): string {
	const match = /^(.+?[.!?])(\s|$)/.exec(text);
	return match?.[1] ?? text;
}
