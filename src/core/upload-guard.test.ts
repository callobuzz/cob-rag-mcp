import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveUploadPath } from "./upload-guard.js";

let root: string;
let allowed: string;
let outside: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cob-rag-upload-")));
	allowed = join(root, "allowed");
	outside = join(root, "outside");
	mkdirSync(join(allowed, "sub"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(allowed, "faq.md"), "# FAQ");
	writeFileSync(join(allowed, "sub", "deep.txt"), "x");
	writeFileSync(join(outside, "secret.txt"), "private");
});

describe("upload directory guard", () => {
	it("refuses every path when no upload directory is set", async () => {
		await expect(resolveUploadPath(join(allowed, "faq.md"), undefined)).rejects.toMatchObject({ code: "REFUSED" });
	});

	it("accepts files inside the directory, by absolute or relative path", async () => {
		// The guard returns the native real path. On Windows CI the temp folder is an 8.3 short name
		// (RUNNER~1) that realpathSync keeps and the native realpath expands, so the expectation is
		// resolved the same way as the result.
		await expect(resolveUploadPath(join(allowed, "faq.md"), allowed)).resolves.toBe(
			realpathSync.native(join(allowed, "faq.md")),
		);
		await expect(resolveUploadPath("sub/deep.txt", allowed)).resolves.toBe(
			realpathSync.native(join(allowed, "sub", "deep.txt")),
		);
	});

	it("refuses traversal and absolute paths outside the directory", async () => {
		await expect(resolveUploadPath("../outside/secret.txt", allowed)).rejects.toMatchObject({ code: "REFUSED" });
		await expect(resolveUploadPath(join(outside, "secret.txt"), allowed)).rejects.toMatchObject({ code: "REFUSED" });
	});

	it("refuses the directory itself and subdirectories", async () => {
		await expect(resolveUploadPath(".", allowed)).rejects.toMatchObject({ code: "REFUSED" });
		await expect(resolveUploadPath("sub", allowed)).rejects.toMatchObject({ code: "USAGE" });
	});

	it("reports missing files and a missing upload directory", async () => {
		await expect(resolveUploadPath("nope.md", allowed)).rejects.toMatchObject({ code: "USAGE" });
		await expect(resolveUploadPath("x", join(root, "missing"))).rejects.toMatchObject({ code: "CONFIG" });
	});

	it("refuses a symlink inside the directory that points outside it", async (ctx) => {
		const link = join(allowed, "escape.txt");
		try {
			symlinkSync(join(outside, "secret.txt"), link, "file");
		} catch {
			ctx.skip(); // creating symlinks needs extra rights on some Windows setups
		}
		await expect(resolveUploadPath("escape.txt", allowed)).rejects.toMatchObject({ code: "REFUSED" });
	});

	it("refuses a linked directory inside that points outside (junction on Windows, symlink elsewhere)", async () => {
		const link = join(allowed, "linked");
		symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
		await expect(resolveUploadPath("linked/secret.txt", allowed)).rejects.toMatchObject({ code: "REFUSED" });
	});

	it("compares case-insensitively on Windows", async () => {
		const upper = allowed.toUpperCase();
		if (process.platform === "win32") {
			await expect(resolveUploadPath("faq.md", upper, "win32")).resolves.toBeTruthy();
		}
	});
});
