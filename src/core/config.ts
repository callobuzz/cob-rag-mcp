/**
 * Configuration: command-line flags beat environment variables, which beat the per-user config
 * file, which beats the defaults. The file lives in the user's own config directory with
 * owner-only permissions, and nothing here ever prints a secret unmasked.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CobRagError } from "./errors.js";

export const DEFAULT_URL = "http://127.0.0.1:8000";

type Kind = "string" | "boolean" | "url";

interface KeySpec {
	env: string;
	kind: Kind;
	secret: boolean;
	description: string;
}

/** Every setting, by its config-file name. */
export const CONFIG_KEYS = {
	url: { env: "COB_RAG_URL", kind: "url", secret: false, description: "Engine base URL" },
	api_key: {
		env: "COB_RAG_API_KEY",
		kind: "string",
		secret: true,
		description: "Engine key: admin, tenant (tk_) or corpus (ck_)",
	},
	corpus_id: {
		env: "COB_RAG_CORPUS_ID",
		kind: "string",
		secret: false,
		description: "Default corpus for tenant and admin keys",
	},
	llm_provider: {
		env: "COB_RAG_LLM_PROVIDER",
		kind: "string",
		secret: false,
		description: "X-LLM-Provider for search and ask",
	},
	llm_model: { env: "COB_RAG_LLM_MODEL", kind: "string", secret: false, description: "X-LLM-Model for search and ask" },
	llm_api_key: {
		env: "COB_RAG_LLM_API_KEY",
		kind: "string",
		secret: true,
		description: "X-LLM-API-Key for search and ask",
	},
	llm_base_url: {
		env: "COB_RAG_LLM_BASE_URL",
		kind: "url",
		secret: false,
		description: "X-LLM-Base-URL for search and ask",
	},
	upload_dir: {
		env: "COB_RAG_UPLOAD_DIR",
		kind: "string",
		secret: false,
		description: "The only directory MCP upload_file may read from",
	},
	allow_destructive: {
		env: "COB_RAG_ALLOW_DESTRUCTIVE",
		kind: "boolean",
		secret: false,
		description: "Show destructive tools to MCP clients",
	},
	read_only: { env: "COB_RAG_READ_ONLY", kind: "boolean", secret: false, description: "Hide every write tool" },
} as const satisfies Record<string, KeySpec>;

export type ConfigKey = keyof typeof CONFIG_KEYS;
export type ConfigSource = "flag" | "env" | "file" | "default";

export type ConfigValues = { [K in ConfigKey]?: (typeof CONFIG_KEYS)[K]["kind"] extends "boolean" ? boolean : string };

export interface ResolvedConfig {
	url: string;
	apiKey?: string;
	corpusId?: string;
	llm: { provider?: string; model?: string; apiKey?: string; baseUrl?: string };
	uploadDir?: string;
	allowDestructive: boolean;
	readOnly: boolean;
	configPath: string;
	sources: Record<ConfigKey, ConfigSource>;
}

export function isConfigKey(key: string): key is ConfigKey {
	return Object.hasOwn(CONFIG_KEYS, key);
}

/** Where the per-user config file lives. COB_RAG_CONFIG overrides it. */
export function defaultConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	if (env.COB_RAG_CONFIG) return env.COB_RAG_CONFIG;
	if (platform === "win32") {
		const base = env.APPDATA ?? join(home, "AppData", "Roaming");
		return join(base, "cob-rag-mcp", "config.json");
	}
	const base = env.XDG_CONFIG_HOME || join(home, ".config");
	return join(base, "cob-rag-mcp", "config.json");
}

export function parseBoolean(value: string | boolean | undefined, name: string): boolean | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value === "boolean") return value;
	const v = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(v)) return true;
	if (["0", "false", "no", "off"].includes(v)) return false;
	throw new CobRagError(`${name} must be true or false, got "${value}"`, "CONFIG");
}

function validateUrl(value: string, name: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new CobRagError(`${name} is not a valid URL: "${value}"`, "CONFIG");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new CobRagError(`${name} must be an http:// or https:// URL, got "${value}"`, "CONFIG");
	}
	return value.replace(/\/+$/, "");
}

/** Validate and normalise one value for a key. Used by the loader and by `config set`. */
export function coerceConfigValue(key: ConfigKey, raw: unknown, sourceName: string): string | boolean | undefined {
	if (raw === undefined || raw === null || raw === "") return undefined;
	const spec = CONFIG_KEYS[key];
	if (spec.kind === "boolean") {
		if (typeof raw !== "boolean" && typeof raw !== "string") {
			throw new CobRagError(`${sourceName} must be true or false`, "CONFIG");
		}
		return parseBoolean(raw, sourceName);
	}
	if (typeof raw !== "string") throw new CobRagError(`${sourceName} must be a string`, "CONFIG");
	return spec.kind === "url" ? validateUrl(raw, sourceName) : raw;
}

export function readConfigFile(path: string): ConfigValues {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new CobRagError(`Config file ${path} is not valid JSON: ${(err as Error).message}`, "CONFIG");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CobRagError(`Config file ${path} must hold a JSON object`, "CONFIG");
	}
	const values: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!isConfigKey(key)) continue; // unknown keys are ignored, not fatal
		values[key] = coerceConfigValue(key, value, `${key} in ${path}`);
	}
	return values as ConfigValues;
}

/**
 * Write the config file readable by its owner only. The write goes to a temp file first so a
 * crash never leaves a half-written file holding a key. On Windows, POSIX modes are ignored;
 * the file sits in the user's own profile directory, which other users cannot read by default.
 */
export function writeConfigFile(path: string, values: ConfigValues): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== "") clean[key] = value;
	}
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Not every filesystem supports it (FAT, some network mounts). The mode on create stands.
	}
}

export interface LoadConfigOptions {
	/** Values from command-line flags, by config-file name. */
	flags?: ConfigValues;
	env?: NodeJS.ProcessEnv;
	configPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
	const env = options.env ?? process.env;
	const configPath = options.configPath ?? defaultConfigPath(env);
	const file = readConfigFile(configPath);
	const flags = options.flags ?? {};

	const merged: Record<string, unknown> = {};
	const sources = {} as Record<ConfigKey, ConfigSource>;

	for (const key of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
		const spec = CONFIG_KEYS[key];
		const fromFlag = coerceConfigValue(key, flags[key], `--${key.replace(/_/g, "-")}`);
		const fromEnv = coerceConfigValue(key, env[spec.env], spec.env);
		const fromFile = file[key];
		if (fromFlag !== undefined) {
			merged[key] = fromFlag;
			sources[key] = "flag";
		} else if (fromEnv !== undefined) {
			merged[key] = fromEnv;
			sources[key] = "env";
		} else if (fromFile !== undefined) {
			merged[key] = fromFile;
			sources[key] = "file";
		} else {
			sources[key] = "default";
		}
	}

	const str = (key: ConfigKey) => merged[key] as string | undefined;
	return {
		url: str("url") ?? DEFAULT_URL,
		apiKey: str("api_key"),
		corpusId: str("corpus_id"),
		llm: {
			provider: str("llm_provider"),
			model: str("llm_model"),
			apiKey: str("llm_api_key"),
			baseUrl: str("llm_base_url"),
		},
		uploadDir: str("upload_dir"),
		allowDestructive: (merged.allow_destructive as boolean | undefined) ?? false,
		readOnly: (merged.read_only as boolean | undefined) ?? false,
		configPath,
		sources,
	};
}

/** Show the kind prefix and the last four characters, nothing more. */
export function maskSecret(value: string | undefined): string {
	if (!value) return "(not set)";
	if (value.length <= 12) return "****";
	const prefix = /^(ck|tk|pk)_/.test(value) ? value.slice(0, 3) : "";
	return `${prefix}****${value.slice(-4)}`;
}

/** A printable view of the resolved config, with every secret masked. */
export function describeConfig(config: ResolvedConfig): Array<{ key: string; value: string; source: string }> {
	const raw: Record<ConfigKey, unknown> = {
		url: config.url,
		api_key: config.apiKey,
		corpus_id: config.corpusId,
		llm_provider: config.llm.provider,
		llm_model: config.llm.model,
		llm_api_key: config.llm.apiKey,
		llm_base_url: config.llm.baseUrl,
		upload_dir: config.uploadDir,
		allow_destructive: config.allowDestructive,
		read_only: config.readOnly,
	};
	return (Object.keys(CONFIG_KEYS) as ConfigKey[]).map((key) => {
		const value = raw[key];
		const shown = CONFIG_KEYS[key].secret
			? maskSecret(value as string | undefined)
			: value === undefined
				? "(not set)"
				: String(value);
		return { key, value: shown, source: config.sources[key] };
	});
}
