import { Command } from "commander";
import {
	CONFIG_KEYS,
	type ConfigKey,
	coerceConfigValue,
	defaultConfigPath,
	describeConfig,
	isConfigKey,
	maskSecret,
	readConfigFile,
	writeConfigFile,
} from "../../core/config.js";
import { CobRagError } from "../../core/errors.js";
import { formatTable } from "../../core/format.js";
import type { CliIO } from "../io.js";
import { type GlobalOptions, loadCliConfig } from "../shared.js";

function keyArg(key: string): ConfigKey {
	if (!isConfigKey(key)) {
		throw new CobRagError(`Unknown setting "${key}". Known: ${Object.keys(CONFIG_KEYS).join(", ")}`, "USAGE");
	}
	return key;
}

export function configCommand(io: CliIO): Command {
	const cmd = new Command("config").description("Show and change this CLI's saved settings (secrets are masked)");
	const pathOf = (c: Command) => (c.optsWithGlobals() as GlobalOptions).config ?? defaultConfigPath(io.env);

	cmd
		.command("show")
		.description("Show every setting, where it came from (flag, env, file, default), secrets masked")
		.action((_opts, c: Command) => {
			const opts = c.optsWithGlobals() as GlobalOptions;
			const config = loadCliConfig(opts, io);
			const rows = describeConfig(config);
			if (opts.json) {
				io.out(JSON.stringify({ config_file: config.configPath, settings: rows }, null, 2));
				return;
			}
			io.out(`Config file: ${config.configPath}\n`);
			io.out(
				formatTable(
					["setting", "value", "source", "env"],
					rows.map((r) => [r.key, r.value, r.source, CONFIG_KEYS[r.key as ConfigKey].env]),
				),
			);
		});

	cmd
		.command("get")
		.description("Print one setting's effective value (secrets masked unless --reveal)")
		.argument("<key>", "Setting name, e.g. url or api_key")
		.option("--reveal", "Print a secret unmasked")
		.action((key: string, local: { reveal?: boolean }, c: Command) => {
			const k = keyArg(key);
			const row = describeConfig(loadCliConfig(c.optsWithGlobals() as GlobalOptions, io)).find((r) => r.key === k);
			if (local.reveal && CONFIG_KEYS[k].secret) {
				const config = loadCliConfig(c.optsWithGlobals() as GlobalOptions, io);
				const value = k === "api_key" ? config.apiKey : config.llm.apiKey;
				io.out(value ?? "");
				return;
			}
			io.out(row?.value ?? "");
		});

	cmd
		.command("set")
		.description("Save a setting to the config file")
		.argument("<key>", "Setting name")
		.argument("<value>", "Value")
		.action((key: string, value: string, _local, c: Command) => {
			const k = keyArg(key);
			const path = pathOf(c);
			const coerced = coerceConfigValue(k, value, k);
			const values = readConfigFile(path) as Record<string, unknown>;
			values[k] = coerced;
			writeConfigFile(path, values);
			const shown = CONFIG_KEYS[k].secret ? maskSecret(String(coerced)) : String(coerced);
			io.out(`Saved ${k} = ${shown} to ${path}`);
		});

	cmd
		.command("unset")
		.description("Remove a setting from the config file")
		.argument("<key>", "Setting name")
		.action((key: string, _local, c: Command) => {
			const k = keyArg(key);
			const path = pathOf(c);
			const values = readConfigFile(path) as Record<string, unknown>;
			delete values[k];
			writeConfigFile(path, values);
			io.out(`Removed ${k} from ${path}`);
		});

	cmd
		.command("path")
		.description("Print where the config file lives")
		.action((_opts, c: Command) => io.out(pathOf(c)));

	return cmd;
}
