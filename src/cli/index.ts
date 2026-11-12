#!/usr/bin/env node
import { CommanderError } from "commander";
import { toCobRagError } from "../core/errors.js";
import { processIO } from "./io.js";
import { buildProgram } from "./program.js";

export async function main(argv: string[] = process.argv): Promise<number> {
	const io = processIO();
	const program = buildProgram(io).exitOverride();
	try {
		await program.parseAsync(argv);
		return 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		const e = toCobRagError(err);
		if (argv.includes("--json")) {
			io.out(JSON.stringify({ error: { code: e.code, message: e.message } }, null, 2));
		} else {
			io.err(`error: ${e.message}`);
		}
		return e.code === "USAGE" ? 2 : 1;
	}
}

// Keep the process alive while a server runs; exit with the code otherwise.
main().then((code) => {
	if (code !== 0) process.exitCode = code;
});
