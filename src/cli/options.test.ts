import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { attrName, coerceField, describeField, flagName } from "./options.js";

describe("CLI option conversion", () => {
	it("maps snake_case inputs to kebab-case flags and camelCase attributes", () => {
		expect(flagName("corpus_id")).toBe("corpus-id");
		expect(attrName("corpus_id")).toBe("corpusId");
		expect(attrName("rate_limit_per_minute")).toBe("rateLimitPerMinute");
	});

	it("reads each schema's kind through optional and described wrappers", () => {
		expect(describeField(z.number().int().optional().describe("n"))).toMatchObject({ kind: "number", optional: true });
		expect(describeField(z.enum(["a", "b"]))).toMatchObject({ kind: "enum", values: ["a", "b"], optional: false });
		expect(describeField(z.array(z.string()))).toMatchObject({ kind: "string-array" });
		expect(describeField(z.array(z.object({})))).toMatchObject({ kind: "json" });
		expect(describeField(z.record(z.string()))).toMatchObject({ kind: "json" });
		expect(describeField(z.boolean().optional().describe("flag"))).toMatchObject({
			kind: "boolean",
			description: "flag",
		});
	});

	it("coerces numbers and refuses non-numbers", () => {
		expect(coerceField("5", "final_k", z.number())).toBe(5);
		expect(() => coerceField("five", "final_k", z.number())).toThrow("--final-k must be a number");
	});

	it("takes the literal null only where the schema allows null", () => {
		expect(coerceField("null", "description", z.string().nullable().optional())).toBeNull();
		expect(coerceField("null", "name", z.string().optional())).toBe("null");
		expect(coerceField("null", "llm_config", z.object({}).nullable().optional())).toBeNull();
		expect(describeField(z.string().nullable().optional())).toMatchObject({ nullable: true, optional: true });
		expect(describeField(z.string().optional())).toMatchObject({ nullable: false });
	});

	it("parses JSON inline or from @file", () => {
		const dir = mkdtempSync(join(tmpdir(), "cob-rag-opt-"));
		writeFileSync(join(dir, "f.json"), '{"final_k": 8}');
		const schema = z.object({ final_k: z.number() });
		expect(coerceField('{"final_k": 3}', "retrieval_config", schema)).toEqual({ final_k: 3 });
		expect(coerceField(`@${join(dir, "f.json")}`, "retrieval_config", schema)).toEqual({ final_k: 8 });
		expect(() => coerceField("{bad", "retrieval_config", schema)).toThrow("not valid JSON");
		expect(() => coerceField("@/no/such/file.json", "retrieval_config", schema)).toThrow("cannot read");
	});

	it("accepts a list as commas or a JSON array", () => {
		const schema = z.array(z.string());
		expect(coerceField("a, b,,c", "allowed_origins", schema)).toEqual(["a", "b", "c"]);
		expect(coerceField('["x","y"]', "allowed_origins", schema)).toEqual(["x", "y"]);
	});
});
