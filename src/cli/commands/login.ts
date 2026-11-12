import { Command } from "commander";
import { EngineClient } from "../../core/client.js";
import {
	coerceConfigValue,
	DEFAULT_URL,
	defaultConfigPath,
	maskSecret,
	readConfigFile,
	writeConfigFile,
} from "../../core/config.js";
import { CobRagError } from "../../core/errors.js";
import { keyValues } from "../../core/format.js";
import { VERSION } from "../../version.js";
import type { CliIO } from "../io.js";
import type { GlobalOptions } from "../shared.js";

export function loginCommand(io: CliIO): Command {
	return new Command("login")
		.description("Check an engine URL and key with /whoami, then save them to your config file")
		.action(async (_opts, c: Command) => {
			const opts = c.optsWithGlobals() as GlobalOptions;
			const path = opts.config ?? defaultConfigPath(io.env);
			const saved = readConfigFile(path);
			const url = (coerceConfigValue("url", opts.url ?? io.env.COB_RAG_URL ?? saved.url ?? DEFAULT_URL, "--url") ??
				DEFAULT_URL) as string;

			let key = opts.key ?? io.env.COB_RAG_API_KEY;
			if (!key && io.interactive) key = await io.prompt("Engine key (admin, tk_ or ck_): ", { hidden: true });
			if (!key) {
				throw new CobRagError("Pass --key <key>, or set COB_RAG_API_KEY. Keys come from your own engine.", "USAGE");
			}

			const client = new EngineClient({
				url,
				apiKey: key,
				userAgent: `cob-rag-engine-cli/${VERSION}`,
				fetch: io.fetch,
			});
			const identity = await client.whoami();

			writeConfigFile(path, { ...saved, url, api_key: key });
			if (opts.json) {
				io.out(JSON.stringify({ saved_to: path, url, api_key: maskSecret(key), identity }, null, 2));
				return;
			}
			io.out(`Logged in to ${url} with ${maskSecret(key)}\n`);
			io.out(keyValues(identity, ["kind", "tenant_name", "tenant_id", "corpus_name", "corpus_id"]));
			io.out(`\nSaved to ${path} (readable by you only).`);
		});
}
