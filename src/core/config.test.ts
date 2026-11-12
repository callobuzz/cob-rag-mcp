import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_URL,
	defaultConfigPath,
	describeConfig,
	loadConfig,
	maskSecret,
	readConfigFile,
	writeConfigFile,
} from "./config.js";

const tmpFile = (content?: object) => {
	const dir = mkdtempSync(join(tmpdir(), "cob-rag-cfg-"));
	const path = join(dir, "config.json");
	if (content) writeFileSync(path, JSON.stringify(content));
	return path;
};

describe("loadConfig precedence", () => {
	it("uses defaults when nothing is set", () => {
		const c = loadConfig({ env: {}, configPath: tmpFile() });
		expect(c.url).toBe(DEFAULT_URL);
		expect(c.apiKey).toBeUndefined();
		expect(c.allowDestructive).toBe(false);
		expect(c.readOnly).toBe(false);
		expect(c.sources.url).toBe("default");
	});

	it("flags beat env, env beats file, file beats default", () => {
		const configPath = tmpFile({ url: "http://file:1", api_key: "file-key-123456", llm_model: "file-model" });
		const env = { COB_RAG_URL: "http://env:2", COB_RAG_API_KEY: "env-key-1234567" };

		const fileOnly = loadConfig({ env: {}, configPath });
		expect(fileOnly.url).toBe("http://file:1");
		expect(fileOnly.sources.url).toBe("file");

		const withEnv = loadConfig({ env, configPath });
		expect(withEnv.url).toBe("http://env:2");
		expect(withEnv.apiKey).toBe("env-key-1234567");
		expect(withEnv.llm.model).toBe("file-model");
		expect(withEnv.sources.api_key).toBe("env");

		const withFlags = loadConfig({ env, configPath, flags: { url: "http://flag:3", read_only: true } });
		expect(withFlags.url).toBe("http://flag:3");
		expect(withFlags.sources.url).toBe("flag");
		expect(withFlags.readOnly).toBe(true);
		expect(withFlags.apiKey).toBe("env-key-1234567");
	});

	it("reads booleans and bring-your-own-key settings from env", () => {
		const c = loadConfig({
			configPath: tmpFile(),
			env: {
				COB_RAG_ALLOW_DESTRUCTIVE: "true",
				COB_RAG_READ_ONLY: "0",
				COB_RAG_LLM_PROVIDER: "openai",
				COB_RAG_LLM_API_KEY: "sk-abcdefghijk",
				COB_RAG_LLM_BASE_URL: "https://proxy.test/v1/",
				COB_RAG_UPLOAD_DIR: "/data/uploads",
				COB_RAG_CORPUS_ID: "c1",
			},
		});
		expect(c.allowDestructive).toBe(true);
		expect(c.readOnly).toBe(false);
		expect(c.llm).toEqual({
			provider: "openai",
			apiKey: "sk-abcdefghijk",
			baseUrl: "https://proxy.test/v1",
			model: undefined,
		});
		expect(c.uploadDir).toBe("/data/uploads");
		expect(c.corpusId).toBe("c1");
	});

	it("rejects bad values with the name of their source", () => {
		expect(() => loadConfig({ env: { COB_RAG_URL: "not a url" }, configPath: tmpFile() })).toThrow(/COB_RAG_URL/);
		expect(() => loadConfig({ env: { COB_RAG_URL: "ftp://x" }, configPath: tmpFile() })).toThrow(/http/);
		expect(() => loadConfig({ env: { COB_RAG_READ_ONLY: "maybe" }, configPath: tmpFile() })).toThrow(
			/COB_RAG_READ_ONLY must be true or false/,
		);
	});

	it("ignores unknown keys in the file and refuses invalid JSON", () => {
		const path = tmpFile({ url: "http://x:1", something_else: 1 });
		expect(readConfigFile(path)).toEqual({ url: "http://x:1" });
		writeFileSync(path, "{ nope");
		expect(() => readConfigFile(path)).toThrow(/not valid JSON/);
	});
});

describe("secrets", () => {
	it("masks keys to their kind prefix and last four characters", () => {
		expect(maskSecret("ck_abcdefghijklmnopqrstuv")).toBe("ck_****stuv");
		expect(maskSecret("tk_abcdefghijklmnopqrstuv")).toBe("tk_****stuv");
		expect(maskSecret("an-admin-key-0123456789")).toBe("****6789");
		expect(maskSecret("short")).toBe("****");
		expect(maskSecret(undefined)).toBe("(not set)");
	});

	it("never shows a secret in describeConfig", () => {
		const c = loadConfig({
			configPath: tmpFile(),
			env: { COB_RAG_API_KEY: "ck_supersecretvalue9999", COB_RAG_LLM_API_KEY: "sk-anothersecret8888" },
		});
		const text = JSON.stringify(describeConfig(c));
		expect(text).not.toContain("supersecretvalue");
		expect(text).not.toContain("anothersecret");
		expect(text).toContain("ck_****9999");
	});
});

describe("config file", () => {
	it("writes owner-only JSON and drops empty values", () => {
		const path = join(mkdtempSync(join(tmpdir(), "cob-rag-cfg-")), "nested", "config.json");
		writeConfigFile(path, { url: "http://x:1", api_key: "ck_1234567890abcd", corpus_id: "" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ url: "http://x:1", api_key: "ck_1234567890abcd" });
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("lives in the per-user config directory", () => {
		expect(defaultConfigPath({ COB_RAG_CONFIG: "/x/c.json" }, "linux", "/home/u")).toBe("/x/c.json");
		expect(defaultConfigPath({}, "linux", "/home/u").replace(/\\/g, "/")).toBe(
			"/home/u/.config/cob-rag-mcp/config.json",
		);
		expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "darwin", "/Users/u").replace(/\\/g, "/")).toBe(
			"/xdg/cob-rag-mcp/config.json",
		);
		expect(defaultConfigPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toContain(
			"cob-rag-mcp",
		);
	});
});
