import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../tools/index.js";
import type { KeyKind } from "./tool.js";
import { inputShapeFor, type VisibilityOptions, visibleTools } from "./visibility.js";

const names = (opts: Partial<VisibilityOptions> & { kind: KeyKind }) =>
	visibleTools(ALL_TOOLS, {
		transport: "stdio",
		allowDestructive: false,
		readOnly: false,
		...opts,
	}).map((t) => t.name);

const TENANT_OR_ADMIN = [
	"list_corpora",
	"get_corpus",
	"create_corpus",
	"update_corpus",
	"preview_delete_corpus",
	"list_migrations",
	"list_leads",
	"export_leads",
	"list_team",
	"get_my_plan",
];
const ADMIN_ONLY = [
	"list_tenants",
	"preview_delete_tenant",
	"create_tenant",
	"activate_tenant",
	"reactivate_tenant",
	"admin_invite",
	"list_plans",
	"set_tenant_plan",
	"get_settings",
	"update_settings",
];
const TENANT_ONLY = ["get_my_tenant", "invite_member"];
const EVERY_KIND = [
	"whoami",
	"get_engine_info",
	"search",
	"ask",
	"list_documents",
	"get_document",
	"list_document_versions",
	"preview_delete_document",
	"add_records",
	"get_ingest_job",
	"list_ingest_jobs",
	"get_usage",
	"list_feedback",
	"get_corpus_settings",
	"update_corpus_settings",
	"get_assistant",
	"update_assistant_draft",
	"publish_assistant",
	"list_widget_keys",
	"create_widget_key",
];
const ORDER = ALL_TOOLS.map((t) => t.name);
const byToolOrder = (a: string, b: string) => ORDER.indexOf(a) - ORDER.indexOf(b);
const DESTRUCTIVE = ALL_TOOLS.filter((t) => t.access === "destructive").map((t) => t.name);

describe("tool visibility", () => {
	it("gives a corpus key its own tools and never tenant or admin tools", () => {
		const visible = names({ kind: "corpus" });
		expect(visible).toEqual(EVERY_KIND);
		for (const name of [...TENANT_OR_ADMIN, ...ADMIN_ONLY, ...TENANT_ONLY]) expect(visible).not.toContain(name);
	});

	it("gives a tenant key corpus management, its own tenant, and the corpus tools, but not tenant administration", () => {
		const visible = names({ kind: "tenant" });
		expect(visible).toEqual([...EVERY_KIND, ...TENANT_OR_ADMIN, ...TENANT_ONLY].sort(byToolOrder));
		for (const name of ADMIN_ONLY) expect(visible).not.toContain(name);
	});

	it("gives the admin key tenant administration and the corpus tools, but not the tenant-self tools", () => {
		const visible = names({ kind: "admin" });
		expect(visible).toEqual([...EVERY_KIND, ...TENANT_OR_ADMIN, ...ADMIN_ONLY].sort(byToolOrder));
		for (const name of TENANT_ONLY) expect(visible).not.toContain(name);
		expect(names({ kind: "admin", allowDestructive: true })).not.toContain("rotate_my_tenant_key");
	});

	it("offers rotate_my_tenant_key to a tenant key only when destructive tools are allowed", () => {
		expect(names({ kind: "tenant" })).not.toContain("rotate_my_tenant_key");
		expect(names({ kind: "tenant", allowDestructive: true })).toContain("rotate_my_tenant_key");
		expect(names({ kind: "tenant", allowDestructive: true, readOnly: true })).not.toContain("rotate_my_tenant_key");
		expect(names({ kind: "corpus", allowDestructive: true })).not.toContain("rotate_my_tenant_key");
	});

	it("keeps list_migrations away from corpus keys, and it is read-only", () => {
		expect(names({ kind: "corpus", readOnly: true })).not.toContain("list_migrations");
		expect(names({ kind: "tenant", readOnly: true })).toContain("list_migrations");
	});

	it("hides destructive tools unless allowed", () => {
		for (const kind of ["admin", "tenant", "corpus"] as const) {
			const hidden = names({ kind });
			for (const name of DESTRUCTIVE) expect(hidden).not.toContain(name);
		}
		const allowed = names({ kind: "admin", allowDestructive: true });
		expect(allowed).toEqual(
			expect.arrayContaining(["delete_corpus", "rotate_corpus_key", "suspend_tenant", "delete_tenant"]),
		);
		expect(names({ kind: "corpus", allowDestructive: true })).toEqual(
			expect.arrayContaining(["delete_document", "revoke_widget_key"]),
		);
	});

	it("read-only mode hides every write, even when destructive tools are allowed", () => {
		for (const kind of ["admin", "tenant", "corpus"] as const) {
			const visible = visibleTools(ALL_TOOLS, { kind, transport: "stdio", allowDestructive: true, readOnly: true });
			expect(visible.length).toBeGreaterThan(0);
			expect(visible.every((t) => t.access === "read")).toBe(true);
		}
	});

	it("shows a key only the tools its permission allows", () => {
		const read = names({ kind: "corpus", allowDestructive: true, permission: "read" });
		const write = names({ kind: "corpus", allowDestructive: true, permission: "write" });
		const full = names({ kind: "corpus", allowDestructive: true, permission: "full" });
		const every = names({ kind: "corpus", allowDestructive: true });
		const access = (name: string) => ALL_TOOLS.find((t) => t.name === name)?.access;
		expect(read.length).toBeGreaterThan(0);
		expect(read.every((n) => access(n) === "read")).toBe(true);
		expect(read).toEqual(expect.arrayContaining(["search", "ask", "preview_delete_document"]));
		expect(read).not.toContain("add_records");
		expect(write.every((n) => access(n) !== "destructive")).toBe(true);
		expect(write).toEqual(expect.arrayContaining(["search", "add_records", "update_corpus_settings"]));
		expect(write).not.toContain("delete_document");
		expect(full).toEqual(every); // full is what a key without a permission always had
		expect(full).toContain("delete_document");
	});

	it("treats a key without a permission (admin, sign-in, older engine) as unrestricted", () => {
		const none = names({ kind: "admin", allowDestructive: true });
		expect(names({ kind: "admin", allowDestructive: true, permission: null })).toEqual(none);
		expect(names({ kind: "admin", allowDestructive: true, permission: undefined })).toEqual(none);
	});

	it("offers upload_file only on stdio with an upload directory", () => {
		expect(names({ kind: "corpus" })).not.toContain("upload_file");
		expect(names({ kind: "corpus", uploadDir: "/up" })).toContain("upload_file");
		expect(names({ kind: "corpus", uploadDir: "/up", transport: "http" })).not.toContain("upload_file");
	});

	it("drops corpus_id from the schema a corpus key sees, and keeps it for others", () => {
		for (const name of [
			"search",
			"list_documents",
			"get_document",
			"list_document_versions",
			"delete_document",
			"get_corpus_settings",
			"update_corpus_settings",
			"list_ingest_jobs",
			"list_feedback",
		]) {
			const tool = ALL_TOOLS.find((t) => t.name === name);
			if (!tool) throw new Error(`${name} missing`);
			expect(Object.keys(inputShapeFor(tool, "corpus"))).not.toContain("corpus_id");
			expect(Object.keys(inputShapeFor(tool, "tenant"))).toContain("corpus_id");
			expect(Object.keys(inputShapeFor(tool, "admin"))).toContain("corpus_id");
		}
	});
});

describe("tool definitions", () => {
	it("have unique names and unique CLI commands", () => {
		const toolNames = ALL_TOOLS.map((t) => t.name);
		expect(new Set(toolNames).size).toBe(toolNames.length);
		const commands = ALL_TOOLS.map((t) => `${t.group} ${t.command}`);
		expect(new Set(commands).size).toBe(commands.length);
	});

	it("mark every delete, revoke, rotate, suspend and decline as destructive", () => {
		for (const tool of ALL_TOOLS) {
			if (/^(delete|revoke|rotate|suspend|decline)_/.test(tool.name)) expect(tool.access).toBe("destructive");
			// list_leads returns contact data, which the engine gives to a `write` key and no lower.
			if (tool.name === "list_leads") continue;
			if (/^(list|get)_|^(search|ask|whoami)$/.test(tool.name)) expect(tool.access).toBe("read");
		}
	});

	it("keeps the lead tools away from a read key and shows them to a write key", () => {
		expect(ALL_TOOLS.find((t) => t.name === "list_leads")?.access).toBe("write");
		for (const kind of ["tenant", "admin"] as const) {
			const read = names({ kind, allowDestructive: true, permission: "read" });
			const write = names({ kind, allowDestructive: true, permission: "write" });
			expect(read).not.toContain("list_leads");
			expect(read).not.toContain("export_leads");
			expect(write).toEqual(expect.arrayContaining(["list_leads", "export_leads"]));
			expect(names({ kind, readOnly: true })).not.toContain("list_leads");
		}
	});
});
