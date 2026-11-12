/**
 * Which tools an MCP client gets to see. A key only ever sees what it can use: a corpus key never
 * sees tenant or admin tools, destructive tools stay hidden unless explicitly allowed, and
 * read-only mode hides every write.
 */

import type { z } from "zod";
import type { KeyPermission } from "./api-types.js";
import type { Access, AnyTool, KeyKind } from "./tool.js";

export interface VisibilityOptions {
	kind: KeyKind;
	transport: "stdio" | "http";
	allowDestructive: boolean;
	readOnly: boolean;
	/**
	 * The key's permission (`whoami`): a read key never sees write or destructive tools, a write key no
	 * destructive ones. Absent (the admin key, a sign-in, an older engine): no restriction.
	 */
	permission?: KeyPermission | null;
	/** upload_file is offered only on stdio and only when an upload directory is configured. */
	uploadDir?: string;
}

/** The access levels each key permission may use (the engine's api/permissions.py has the route table). */
const PERMITTED: Record<KeyPermission, readonly Access[]> = {
	read: ["read"],
	write: ["read", "write"],
	full: ["read", "write", "destructive"],
};

export function isToolVisible(tool: AnyTool, options: VisibilityOptions): boolean {
	if (!tool.kinds.includes(options.kind)) return false;
	if (options.permission && !PERMITTED[options.permission].includes(tool.access)) return false;
	if (options.readOnly && tool.access !== "read") return false;
	if (tool.access === "destructive" && !options.allowDestructive) return false;
	const transports = tool.mcpTransports ?? ["stdio", "http"];
	if (!transports.includes(options.transport)) return false;
	if (tool.name === "upload_file" && !options.uploadDir) return false;
	return true;
}

export function visibleTools(tools: readonly AnyTool[], options: VisibilityOptions): AnyTool[] {
	return tools.filter((tool) => isToolVisible(tool, options));
}

/** The input schema a given key kind sees: corpus keys do not get a corpus_id they cannot use. */
export function inputShapeFor(tool: AnyTool, kind: KeyKind): z.ZodRawShape {
	if (kind !== "corpus" || !tool.corpusScoped) return tool.input;
	const { corpus_id: _omit, ...rest } = tool.input as z.ZodRawShape;
	return rest;
}
