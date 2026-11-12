import { z } from "zod";
import type {
	AssistantDraftPatchRequest,
	AssistantPublishRequest,
	AssistantStateResponse,
	AssistantVersionResponse,
} from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues } from "../core/format.js";
import { corpusIdInput, defineTool, resolveCorpusId } from "../core/tool.js";

// The assistant (engine conversation layer C2): who a knowledge base's assistant is and how it
// behaves. Drafts are edited with a JSON merge patch; publishing makes the draft live. Both are
// `write` for an API key, and both are reversible (an older version can be restored), so neither is
// destructive. A workspace member's sign-in cannot publish; a key is never a member.
const ALL = ["admin", "tenant", "corpus"] as const;

async function assistantPath(given: string | undefined, ctx: Parameters<typeof resolveCorpusId>[1]): Promise<string> {
	const id = await resolveCorpusId(given, ctx, { required: true });
	return `/api/v1/corpora/${seg(id as string)}/assistant`;
}

function renderState(data: unknown): string {
	const state = data as AssistantStateResponse;
	return keyValues({
		enabled: state.enabled,
		published_version: state.published?.version ?? "none",
		draft: state.draft ? `revision ${state.draft.draft_revision}` : "none",
	});
}

function renderVersion(data: unknown): string {
	const row = data as AssistantVersionResponse;
	return keyValues({
		status: row.status,
		version: row.version ?? "draft",
		draft_revision: row.draft_revision,
		by: row.created_by,
	});
}

export const getAssistantTool = defineTool({
	name: "get_assistant",
	title: "Get the assistant",
	description:
		"The knowledge base's assistant: whether it is switched on, the published configuration and the current " +
		"draft (identity, voice, language, scope, guidance rules, leads, handoff).",
	group: "assistant",
	command: "get",
	kinds: ALL,
	access: "read",
	corpusScoped: true,
	input: { corpus_id: corpusIdInput },
	handler: async (input, ctx) => ctx.client.get<AssistantStateResponse>(await assistantPath(input.corpus_id, ctx)),
	render: renderState,
});

export const updateAssistantDraftTool = defineTool({
	name: "update_assistant_draft",
	title: "Update the assistant draft",
	description:
		"Change the assistant's DRAFT with a JSON merge patch (null removes a field), for example " +
		'{"voice": {"tone_preset": "warm"}, "identity": {"business_name": "Shree Labs"}}. Nothing goes live until ' +
		"publish_assistant. With no draft yet, the patch applies to the published configuration.",
	group: "assistant",
	command: "draft",
	kinds: ALL,
	access: "write",
	corpusScoped: true,
	input: {
		patch: z.record(z.string(), z.unknown()).describe("RFC 7396 merge patch over the assistant configuration."),
		base_revision: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("The draft revision you read. Omitted: the current one (so a stale edit is not detected)."),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) => {
		const path = await assistantPath(input.corpus_id, ctx);
		const revision =
			input.base_revision ?? (await ctx.client.get<AssistantStateResponse>(path)).draft?.draft_revision ?? 0;
		const body: AssistantDraftPatchRequest = { patch: input.patch, base_revision: revision };
		return ctx.client.request<AssistantVersionResponse>("PATCH", `${path}/draft`, { body });
	},
	render: renderVersion,
});

export const publishAssistantTool = defineTool({
	name: "publish_assistant",
	title: "Publish the assistant draft",
	description:
		"Make the current draft live on every channel (website widget, API). Earlier versions stay restorable. " +
		"Pass base_revision, the draft_revision update_assistant_draft returned, so edits made by someone else after " +
		"your review are refused instead of going live. " +
		"Refused with a reason when the draft breaks a limit (30 rules, prompt size, an unknown topic).",
	group: "assistant",
	command: "publish",
	kinds: ALL,
	access: "write",
	corpusScoped: true,
	input: {
		note: z.string().max(200).optional().describe("A short note shown in the version history."),
		base_revision: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("The draft revision you reviewed (update_assistant_draft returns it); a newer draft is refused."),
		corpus_id: corpusIdInput,
	},
	handler: async (input, ctx) => {
		const path = await assistantPath(input.corpus_id, ctx);
		const revision =
			input.base_revision ?? (await ctx.client.get<AssistantStateResponse>(path)).draft?.draft_revision ?? 0;
		const body: AssistantPublishRequest = {
			base_revision: revision,
			...(input.note ? { note: input.note } : {}),
		};
		return ctx.client.request<AssistantVersionResponse>("POST", `${path}/publish`, { body });
	},
	render: renderVersion,
});
