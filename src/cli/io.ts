/**
 * Everything the CLI does to the outside world goes through here, so tests can run the real
 * program against fake streams and a fake engine.
 */

import { createInterface } from "node:readline";

export interface CliIO {
	out(text: string): void;
	/** Write without adding a newline (streamed answers). */
	write(text: string): void;
	err(text: string): void;
	/** True when a person can answer a prompt (stdin and stderr are terminals). */
	interactive: boolean;
	prompt(question: string, options?: { hidden?: boolean }): Promise<string>;
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

export function processIO(): CliIO {
	return {
		out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
		write: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
		interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
		prompt: (question, options) => ask(question, options?.hidden ?? false),
		env: process.env,
	};
}

function ask(question: string, hidden: boolean): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
		if (hidden) {
			// Echo nothing while a secret is typed.
			const writer = rl as unknown as { _writeToOutput: (s: string) => void };
			writer._writeToOutput = (s: string) => {
				if (s.includes(question)) process.stderr.write(question);
			};
		}
		rl.question(question, (answer) => {
			rl.close();
			if (hidden) process.stderr.write("\n");
			resolve(answer.trim());
		});
	});
}
