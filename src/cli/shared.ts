import { type ConfigValues, loadConfig, type ResolvedConfig } from "../core/config.js";
import type { CliIO } from "./io.js";

/** Options defined on the root program, available to every command. */
export interface GlobalOptions {
	url?: string;
	key?: string;
	config?: string;
	json?: boolean;
	yes?: boolean;
	readOnly?: boolean;
	allowDestructive?: boolean;
	stream?: boolean;
}

export function flagValues(opts: GlobalOptions): ConfigValues {
	return {
		url: opts.url,
		api_key: opts.key,
		read_only: opts.readOnly ? true : undefined,
		allow_destructive: opts.allowDestructive ? true : undefined,
	};
}

export function loadCliConfig(opts: GlobalOptions, io: CliIO): ResolvedConfig {
	return loadConfig({ flags: flagValues(opts), env: io.env, configPath: opts.config });
}
