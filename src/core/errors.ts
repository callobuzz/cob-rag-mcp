/**
 * Every failure this package reports is a CobRagError with a stable `code`, so the CLI and the
 * MCP server can print the same clear message, and scripts can branch on the code.
 */

export type ErrorCode =
	| "ENGINE_UNREACHABLE"
	| "TIMEOUT"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "VALIDATION"
	| "ENGINE_ERROR"
	| "CONFIG"
	| "USAGE"
	| "REFUSED"
	| "LIMIT";

export class CobRagError extends Error {
	constructor(
		message: string,
		readonly code: ErrorCode,
		readonly status?: number,
	) {
		super(message);
		this.name = "CobRagError";
	}
}

/** Pull a readable message out of a FastAPI error body (`{"detail": "..."}` or a 422 list). */
export function formatEngineDetail(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const detail = (body as { detail?: unknown }).detail;
	if (typeof detail === "string") return detail;
	if (Array.isArray(detail)) {
		const parts = detail.map((item) => {
			if (item === null || typeof item !== "object") return String(item);
			const { loc, msg } = item as { loc?: unknown; msg?: unknown };
			const where = Array.isArray(loc) ? loc.filter((p) => p !== "body").join(".") : "";
			return where ? `${where}: ${String(msg)}` : String(msg);
		});
		return parts.join("; ");
	}
	if (detail !== undefined) return JSON.stringify(detail);
	return undefined;
}

/** The engine's machine-readable error code (`{"detail": ..., "code": ...}`), if any. */
export function engineCode(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const code = (body as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function extra(body: unknown, field: string): unknown {
	return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
}

/** A plan limit the tenant hit (engine accounts A6), in words. */
const PLAN_LIMITS: Record<string, string> = {
	kb_limit_reached: "knowledge-base",
	document_limit_reached: "document",
	widget_key_limit_reached: "widget-key",
};

/** The message for an error the engine gave a machine-readable code, or undefined for the rest. */
function messageForCode(code: string | undefined, body: unknown, detail: string | undefined): string | undefined {
	switch (code) {
		case "workspace_not_active":
			return "This workspace is not active (pending or suspended); ask the operator.";
		case "owner_required":
			return `Only a workspace owner can do this${detail ? ` (${detail})` : ""}.`;
		case "key_permission_denied": {
			const have = extra(body, "permission");
			const need = extra(body, "required");
			return (
				`This API key only has ${typeof have === "string" ? have : "limited"} permission` +
				`${typeof need === "string" ? `; this action needs ${need}` : ""}. ` +
				"Use a key with more permission: in the dashboard, open the knowledge base's Keys panel (or Agents, " +
				"Connect an agent) and create or edit a key. read = search and ask, write = also add and change " +
				"content, full = also delete and manage keys."
			);
		}
		case "confirmation_required": {
			const name = extra(body, "confirm_name");
			return (
				"Deleting with an API key needs confirm_name: the item's exact name" +
				`${typeof name === "string" ? ` (here: "${name}")` : ""}. Nothing was deleted. ` +
				"Run the matching preview_delete_* tool first to see what would be removed, then repeat the delete " +
				"with confirm_name."
			);
		}
		case "question_cap_reached": {
			const resets = extra(body, "resets_at");
			return (
				"This workspace has used all the questions its plan allows this month" +
				(typeof resets === "string" ? `; they reset at ${resets}` : "") +
				". Ask the operator for a larger plan."
			);
		}
		default: {
			const which = code ? PLAN_LIMITS[code] : undefined;
			if (!which) return undefined;
			const limit = extra(body, "limit");
			return (
				`The tenant has reached its plan's ${which} limit` +
				(typeof limit === "number" ? ` (${limit})` : "") +
				`${detail ? `: ${detail}` : ""}. Remove one, or ask the operator for a larger plan.`
			);
		}
	}
}

export function errorFromResponse(status: number, body: unknown, url: string): CobRagError {
	const detail = formatEngineDetail(body) ?? (typeof body === "string" && body ? body.slice(0, 500) : undefined);
	const code = engineCode(body);
	const coded = messageForCode(code, body, detail);
	if (coded) {
		const kind: ErrorCode =
			code === "workspace_not_active" || code === "owner_required" || code === "key_permission_denied"
				? "FORBIDDEN"
				: code === "confirmation_required"
					? "VALIDATION"
					: "LIMIT";
		return new CobRagError(coded, kind, status);
	}
	switch (status) {
		case 401:
			return new CobRagError(
				`The engine at ${url} rejected the API key${detail ? ` (${detail})` : ""}. ` +
					"Check COB_RAG_API_KEY, or run `cob-rag-engine login` again.",
				"UNAUTHORIZED",
				status,
			);
		case 403:
			return new CobRagError(
				`Not allowed with this key: ${detail ?? "forbidden"}. ` +
					"Run `cob-rag-engine whoami` to see which kind of key this is.",
				"FORBIDDEN",
				status,
			);
		case 404:
			return new CobRagError(`Not found: ${detail ?? "the engine returned 404"}`, "NOT_FOUND", status);
		case 400:
		case 409:
		case 413:
		case 422:
			return new CobRagError(`The engine refused the request: ${detail ?? `HTTP ${status}`}`, "VALIDATION", status);
		default:
			return new CobRagError(
				`The engine returned HTTP ${status}${detail ? `: ${detail}` : ""}`,
				"ENGINE_ERROR",
				status,
			);
	}
}

export function toCobRagError(err: unknown): CobRagError {
	if (err instanceof CobRagError) return err;
	if (err instanceof Error) return new CobRagError(err.message, "ENGINE_ERROR");
	return new CobRagError(String(err), "ENGINE_ERROR");
}
