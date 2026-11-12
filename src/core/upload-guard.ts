/**
 * An MCP client asking to upload a file names a path on this machine. Without a fence, a prompt
 * injection could make it upload a private key or a password store into a knowledge base. So MCP
 * uploads are confined to one directory the user chose (COB_RAG_UPLOAD_DIR), checked after
 * resolving symlinks, and refused outright when no directory is set.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { CobRagError } from "./errors.js";

export async function resolveUploadPath(
	requested: string,
	allowedDir: string | undefined,
	platform: NodeJS.Platform = process.platform,
): Promise<string> {
	if (!allowedDir) {
		throw new CobRagError(
			"File upload over MCP is disabled: set COB_RAG_UPLOAD_DIR to the one directory it may read from.",
			"REFUSED",
		);
	}
	let base: string;
	try {
		base = await realpath(resolve(allowedDir));
	} catch {
		throw new CobRagError(`COB_RAG_UPLOAD_DIR does not exist: ${allowedDir}`, "CONFIG");
	}
	const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
	const outside = (p: string) => {
		const rel = relative(fold(base), fold(p));
		return rel === "" || rel.startsWith("..") || isAbsolute(rel);
	};
	const refuse = () => new CobRagError(`Refused: ${requested} is outside the upload directory (${base}).`, "REFUSED");

	// A relative path is taken relative to the upload directory, not the process cwd. Checked
	// before touching the filesystem, so a refusal never reveals whether an outside file exists.
	const lexical = resolve(base, requested);
	if (outside(lexical)) throw refuse();
	let target: string;
	try {
		target = await realpath(lexical);
	} catch {
		throw new CobRagError(`File not found: ${requested}`, "USAGE");
	}
	// And again after resolving symlinks, so a link inside cannot point outside.
	if (outside(target)) throw refuse();
	const info = await stat(target);
	if (!info.isFile()) throw new CobRagError(`Not a file: ${requested}`, "USAGE");
	return target;
}
