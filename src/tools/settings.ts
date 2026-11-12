import { z } from "zod";
import type {
	SettingsPatch,
	SettingsResponse,
	TenantConfigResponse,
	UpdateTenantConfigRequest,
} from "../core/api-types.js";
import { CobRagError } from "../core/errors.js";
import { keyValues } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";
import { CLEARING_RULES, compact, promptConfigUpdateSchema, retrievalConfigUpdateSchema } from "./schemas.js";

// /api/v1/config is a corpus's self-service settings. A corpus key reaches its own; tenant keys
// (their corpora) and the admin key (any) name the corpus with `?corpus_id=` and get the same
// view and the same bounds. The model and its key change only through update_corpus.
const ALL = ["admin", "tenant", "corpus"] as const;

function renderConfig(data: unknown): string {
	const res = data as TenantConfigResponse;
	return JSON.stringify(res, null, 2);
}

export const getCorpusSettingsTool = defineTool({
	name: "get_corpus_settings",
	title: "Get corpus settings",
	description: "Show a corpus's model, prompt and retrieval settings (the model API key is redacted).",
	group: "settings",
	command: "get",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: { corpus_id: corpusIdInput },
	handler: async (input, ctx) =>
		ctx.client.get<TenantConfigResponse>("/api/v1/config", {
			corpus_id: await resolveCorpusId(input.corpus_id, ctx),
		}),
	render: renderConfig,
});

export const updateCorpusSettingsTool = defineTool({
	name: "update_corpus_settings",
	title: "Update corpus settings",
	description:
		"Change a corpus's prompt and retrieval settings. Only the fields you send change. " +
		`${CLEARING_RULES} ` +
		"The model and its key can only be changed with a tenant or admin key (update_corpus).",
	group: "settings",
	command: "update",
	kinds: ALL,
	access: "write",
	corpusScoped: true,
	input: {
		corpus_id: corpusIdInput,
		prompt_config: promptConfigUpdateSchema
			.nullable()
			.optional()
			.describe("System prompt, constraints, response language. null resets them all."),
		retrieval_config: retrievalConfigUpdateSchema
			.nullable()
			.optional()
			.describe("Retrieval settings; a preset plus overrides. null resets them all."),
	},
	handler: async (input, ctx) => {
		if (input.prompt_config === undefined && input.retrieval_config === undefined) {
			throw new CobRagError("Nothing to update: pass prompt_config and/or retrieval_config.", "USAGE");
		}
		const body: UpdateTenantConfigRequest = compact({
			prompt_config: input.prompt_config,
			retrieval_config: input.retrieval_config,
		});
		return ctx.client.request<TenantConfigResponse>("PATCH", "/api/v1/config", {
			body,
			query: { corpus_id: await resolveCorpusId(input.corpus_id, ctx) },
		});
	},
	render: renderConfig,
});

// /api/v1/admin/settings (engine accounts A7): the operator's sign-up mode and white-label
// branding, shown on the sign-up and login pages, the dashboard and every e-mail. The "Powered by
// cob-rag-engine" line is not a setting.
const SIGNUP_MODES = ["open", "approval", "closed"] as const;

function renderEngineSettings(data: unknown): string {
	const res = data as SettingsResponse;
	return `${keyValues(res, ["signup_mode", "updated_at", "updated_by"])}\n\nBranding\n${keyValues(res.branding)}`;
}

const nullableText = (max: number, description: string) =>
	z.string().min(1).max(max).nullable().optional().describe(`${description} null resets it.`);

export const getSettingsTool = defineTool({
	name: "get_settings",
	title: "Get engine settings",
	description:
		"Operator: the sign-up mode (open, approval or closed) and the white-label branding (product name, logo, " +
		"colour, support e-mail, contact text and link), with who changed them last.",
	group: "engine",
	command: "settings",
	kinds: ["admin"],
	access: "read",
	input: {},
	handler: async (_input, ctx) => ctx.client.get<SettingsResponse>("/api/v1/admin/settings"),
	render: renderEngineSettings,
});

export const updateSettingsTool = defineTool({
	name: "update_settings",
	title: "Update engine settings",
	description:
		"Operator: change the sign-up mode and/or branding. Only what you send changes; null resets a field to its " +
		"default (branding: null resets all of it). open: new sign-ups are active at once; approval: they wait " +
		"for you (activate_tenant); closed: sign-up is off and shows your contact text. Audited.",
	group: "engine",
	command: "update-settings",
	kinds: ["admin"],
	access: "write",
	input: {
		signup_mode: z.enum(SIGNUP_MODES).nullable().optional().describe("open, approval or closed. null: approval."),
		branding: z
			.object({
				product_name: nullableText(80, "Your product's name."),
				logo_url: nullableText(2048, "https:// URL of the logo."),
				primary_color: z
					.string()
					.regex(/^#[0-9a-fA-F]{6}$/)
					.nullable()
					.optional()
					.describe("#RRGGBB. null resets it."),
				support_email: z.string().email().nullable().optional().describe("Support address. null resets it."),
				contact_text: nullableText(500, "What closed sign-up and plan limits show (e.g. 'Contact us for pricing')."),
				contact_url: nullableText(2048, "https:// link next to the contact text."),
			})
			.strict()
			.nullable()
			.optional()
			.describe("Branding fields to change."),
	},
	handler: async (input, ctx) => {
		if (input.signup_mode === undefined && input.branding === undefined) {
			throw new CobRagError("Nothing to update: pass signup_mode and/or branding.", "USAGE");
		}
		const body = compact({ signup_mode: input.signup_mode, branding: input.branding }) as SettingsPatch;
		return ctx.client.request<SettingsResponse>("PATCH", "/api/v1/admin/settings", { body });
	},
	render: renderEngineSettings,
});
