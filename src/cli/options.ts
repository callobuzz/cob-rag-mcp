/**
 * Turn a tool's zod input into Commander options, and turn the strings Commander hands back into
 * the values the schema expects. `corpus_id` becomes `--corpus-id`; JSON-shaped inputs take JSON
 * text or `@path/to/file.json`.
 */

import { readFileSync } from "node:fs";
import { type Command, Option } from "commander";
import type { ZodTypeAny } from "zod";
import { CobRagError } from "../core/errors.js";

export type FieldKind = "string" | "number" | "boolean" | "enum" | "string-array" | "json";

export interface FieldInfo {
	kind: FieldKind;
	optional: boolean;
	/** The schema accepts null: on the command line, the literal `null` (JSON inputs: JSON null). */
	nullable: boolean;
	description?: string;
	values?: string[];
}

interface ZodDef {
	typeName?: string;
	innerType?: ZodTypeAny;
	schema?: ZodTypeAny;
	type?: ZodTypeAny;
	values?: string[];
	description?: string;
}

function defOf(schema: ZodTypeAny): ZodDef {
	return (schema as unknown as { _def: ZodDef })._def;
}

export function describeField(schema: ZodTypeAny): FieldInfo {
	let current = schema;
	let optional = false;
	let nullable = false;
	let description = defOf(schema).description;
	for (;;) {
		const def = defOf(current);
		description ??= def.description;
		if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable" || def.typeName === "ZodDefault") {
			optional = true;
			if (def.typeName === "ZodNullable") nullable = true;
			current = def.innerType as ZodTypeAny;
		} else if (def.typeName === "ZodEffects") {
			current = def.schema as ZodTypeAny;
		} else {
			break;
		}
	}
	const def = defOf(current);
	switch (def.typeName) {
		case "ZodNumber":
			return { kind: "number", optional, nullable, description };
		case "ZodBoolean":
			return { kind: "boolean", optional, nullable, description };
		case "ZodEnum":
			return { kind: "enum", optional, nullable, description, values: [...(def.values ?? [])] };
		case "ZodArray": {
			const itemType = defOf(def.type as ZodTypeAny).typeName;
			return { kind: itemType === "ZodString" ? "string-array" : "json", optional, nullable, description };
		}
		case "ZodObject":
		case "ZodRecord":
			return { kind: "json", optional, nullable, description };
		default:
			return { kind: "string", optional, nullable, description };
	}
}

export const flagName = (key: string) => key.replace(/_/g, "-");
export const attrName = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export function addFieldOption(cmd: Command, key: string, schema: ZodTypeAny): void {
	const info = describeField(schema);
	const flag = `--${flagName(key)}`;
	const description = info.description ?? "";
	switch (info.kind) {
		case "boolean":
			cmd.addOption(new Option(flag, description));
			return;
		case "number":
			cmd.addOption(new Option(`${flag} <n>`, description));
			return;
		case "enum":
			cmd.addOption(new Option(`${flag} <value>`, description).choices(info.values ?? []));
			return;
		case "string-array":
			cmd.addOption(new Option(`${flag} <values>`, `${description} (comma-separated or a JSON array)`));
			return;
		case "json":
			cmd.addOption(new Option(`${flag} <json>`, `${description} (JSON, or @file.json)`));
			return;
		default:
			cmd.addOption(new Option(`${flag} <value>`, description));
	}
}

function readJsonArg(raw: string, key: string): unknown {
	let text = raw;
	let source = `--${flagName(key)}`;
	if (raw.startsWith("@")) {
		const path = raw.slice(1);
		try {
			text = readFileSync(path, "utf8");
		} catch {
			throw new CobRagError(`${source}: cannot read ${path}`, "USAGE");
		}
		source = path;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		// A .jsonl file: one JSON value per line becomes an array.
		const lines = text.split(/\r?\n/).filter((l) => l.trim());
		if (lines.length > 1) {
			try {
				return lines.map((l) => JSON.parse(l));
			} catch {
				// fall through to the original error
			}
		}
		throw new CobRagError(`${source} is not valid JSON: ${(err as Error).message}`, "USAGE");
	}
}

/** Convert one raw CLI value to what the schema expects. Validation proper is zod's job. */
export function coerceField(raw: unknown, key: string, schema: ZodTypeAny): unknown {
	if (raw === undefined) return undefined;
	const info = describeField(schema);
	if (typeof raw !== "string") return raw;
	if (info.nullable && info.kind !== "json" && raw === "null") return null;
	switch (info.kind) {
		case "number": {
			const n = Number(raw);
			if (raw.trim() === "" || Number.isNaN(n)) {
				throw new CobRagError(`--${flagName(key)} must be a number, got "${raw}"`, "USAGE");
			}
			return n;
		}
		case "boolean":
			return raw === "true";
		case "string-array": {
			const trimmed = raw.trim();
			if (trimmed.startsWith("[")) return readJsonArg(trimmed, key);
			return trimmed
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		case "json":
			return readJsonArg(raw, key);
		default:
			return raw;
	}
}
