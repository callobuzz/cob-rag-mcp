/**
 * Plain-text tables for the CLI. No colours and no box-drawing characters, so the output reads
 * the same in any terminal, log file or CI job.
 */

const MAX_CELL = 60;

export function truncate(text: string, max = MAX_CELL): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

export function cell(value: unknown, max = MAX_CELL): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return truncate(JSON.stringify(value), max);
	return truncate(String(value), max);
}

export function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	const rule = widths.map((w) => "-".repeat(w)).join("  ");
	return [line(headers), rule, ...rows.map(line)].join("\n");
}

export interface Column {
	key: string;
	label?: string;
	max?: number;
}

/** A table of selected columns from a list of objects. */
export function table(items: readonly unknown[], columns: readonly Column[]): string {
	if (items.length === 0) return "(none)";
	const rows = items.map((item) => {
		const obj = (item ?? {}) as Record<string, unknown>;
		return columns.map((c) => cell(obj[c.key], c.max));
	});
	return formatTable(
		columns.map((c) => c.label ?? c.key),
		rows,
	);
}

/** Key/value lines for one object. */
export function keyValues(obj: unknown, keys?: readonly string[]): string {
	if (obj === null || typeof obj !== "object") return String(obj);
	const record = obj as Record<string, unknown>;
	const entries = (keys ?? Object.keys(record)).map((k) => [k, cell(record[k], 100)] as const);
	const width = Math.max(...entries.map(([k]) => k.length));
	return entries.map(([k, v]) => `${k.padEnd(width)}  ${v || "-"}`).join("\n");
}

/** What a delete would remove, for the CLI: the item, its counts, and the name to confirm with. */
export function renderPreview(preview: {
	kind: string;
	name: string;
	confirm_name: string;
	counts: Record<string, number>;
}): string {
	const counts = Object.entries(preview.counts)
		.map(([what, n]) => `  ${what.replace(/_/g, " ")}: ${n}`)
		.join("\n");
	return (
		`Deleting the ${preview.kind.replace(/_/g, " ")} "${preview.name}" would remove:\n${counts}\n\n` +
		`This cannot be undone. To go ahead, pass confirm_name "${preview.confirm_name}".`
	);
}

/** Generic fallback: a list becomes a table of its first item's scalar fields. */
export function autoFormat(data: unknown): string {
	if (data === undefined || data === null) return "";
	if (typeof data !== "object") return String(data);
	if (Array.isArray(data)) {
		const first = data[0];
		if (first === null || typeof first !== "object") return data.map(String).join("\n");
		const keys = Object.keys(first).filter((k) => {
			const v = (first as Record<string, unknown>)[k];
			return v === null || typeof v !== "object";
		});
		return table(
			data,
			keys.map((key) => ({ key })),
		);
	}
	const record = data as Record<string, unknown>;
	if (Array.isArray(record.items)) return autoFormat(record.items);
	return keyValues(record);
}

/**
 * One line under a paged list: which items these are out of how many, and the option that gets
 * the next page when there is one. `count` is the number of items on this page.
 */
export function pageFooter(
	noun: string,
	page: { count: number; total?: number | null; offset?: number | null },
	nextFlag = "--offset",
	/** Another option that gets the rest, e.g. `--all`. */
	allFlag?: string,
): string {
	const offset = page.offset ?? 0;
	const total = page.total ?? offset + page.count;
	if (page.count === 0) return total > 0 ? `No ${noun} at offset ${offset} (${total} in all).` : `0 ${noun}`;
	const next = offset + page.count;
	if (offset === 0 && next >= total) return `${total} ${noun}`;
	const shown = `${noun} ${offset + 1}-${next} of ${total}`;
	if (next >= total) return shown;
	return `${shown}. More: ${nextFlag} ${next}${allFlag ? `, or ${allFlag} for every page` : ""}`;
}

/** Where a passage came from, in one line. */
export function sourceLabel(chunk: {
	file_name?: string | null;
	external_id?: string | null;
	section?: string | null;
	page?: number | null;
}): string {
	// For records the engine sets file_name to the record's title, and a one-section record's
	// section is that same title: show the record id once and skip the repeat.
	let name = chunk.file_name ?? chunk.external_id ?? "unknown source";
	if (chunk.file_name && chunk.external_id && chunk.external_id !== chunk.file_name) {
		name = `${chunk.file_name} [${chunk.external_id}]`;
	}
	const parts = [name];
	if (chunk.section && chunk.section !== chunk.file_name) parts.push(chunk.section);
	if (chunk.page !== null && chunk.page !== undefined) parts.push(`p. ${chunk.page}`);
	return parts.join(" > ");
}
