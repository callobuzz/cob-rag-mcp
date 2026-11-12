#!/usr/bin/env node
// Regenerate src/generated/engine-api.ts from the engine's OpenAPI spec.
//
//   pnpm gen:api                                   # the spec committed in the engine repo
//   pnpm gen:api ../cob-rag-engine/docs/openapi.json
//   pnpm gen:api https://rag.example.com/openapi.json
//
// The engine repo commits its spec at docs/openapi.json; a checkout of it is the usual input.
// Fields with a default are optional in the generated types (--default-non-nullable=false): the
// engine fills them in, so a request may leave them out.
// The generated file is committed, so a build never needs a running engine.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const input =
	process.argv[2] ??
	process.env.COB_RAG_OPENAPI ??
	"https://raw.githubusercontent.com/callobuzz/cob-rag-engine/main/docs/openapi.json";
const output = fileURLToPath(new URL("../src/generated/engine-api.ts", import.meta.url));

const result = spawnSync("openapi-typescript", [input, "--output", output, "--default-non-nullable=false"], {
	stdio: "inherit",
	shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
