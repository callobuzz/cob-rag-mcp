/**
 * Named aliases over the types generated from the engine's OpenAPI spec (`pnpm gen:api`).
 * Every request body and response in this package is typed from here, so a field the engine
 * does not have fails the typecheck instead of reaching the wire.
 */
import type { components } from "../generated/engine-api.js";

type Schemas = components["schemas"];

export type WhoAmI = Schemas["WhoAmIResponse"];
/** A tk_/ck_ key's permission (WhoAmI.permission): read | write | full. */
export type KeyPermission = NonNullable<WhoAmI["permission"]>;
/** What a delete would remove and the name to confirm it with (GET .../delete-preview). */
export type DeletePreviewResponse = Schemas["DeletePreviewResponse"];
export type KeyKind = WhoAmI["kind"];

export type QueryOptions = Schemas["QueryOptions"];
export type RetrieveRequest = Schemas["RetrieveRequest"];
export type RetrieveResponse = Schemas["RetrieveResponse"];
export type RetrievedChunk = Schemas["RetrievedChunk"];
export type QueryRequest = Schemas["QueryRequest"];
export type QueryResponse = Schemas["QueryResponse"];

export type DocumentListResponse = Schemas["DocumentListResponse"];
export type DocumentDetailResponse = Schemas["DocumentDetailResponse"];
export type VersionListResponse = Schemas["VersionListResponse"];

export type IngestRecordsRequest = Schemas["IngestRecordsRequest"];
export type IngestRecordsResponse = Schemas["IngestRecordsResponse"];
export type IngestResponse = Schemas["IngestResponse"];
export type JobStatusResponse = Schemas["JobStatusResponse"];
export type JobListResponse = Schemas["JobListResponse"];
export type SimilarDocumentInfo = Schemas["SimilarDocumentInfo"];

export type UsageResponse = Schemas["UsageResponse"];

/** Leads visitors left in the website assistant (engine conversation layer C4). */
export type LeadListResponse = Schemas["LeadListResponse"];

export type TenantConfigResponse = Schemas["TenantConfigResponse"];
export type UpdateTenantConfigRequest = Schemas["UpdateTenantConfigRequest"];

export type CorpusListResponse = Schemas["CorpusListResponse"];
export type CorpusDetailResponse = Schemas["CorpusDetailResponse"];
export type CreateCorpusRequest = Schemas["CreateCorpusRequest"];
export type CreateCorpusResponse = Schemas["CreateCorpusResponse"];
export type UpdateCorpusRequest = Schemas["UpdateCorpusRequest"];
export type RotateKeyResponse = Schemas["RotateKeyResponse"];

export type WidgetKeyResponse = Schemas["WidgetKeyResponse"];
export type CreateWidgetKeyRequest = Schemas["CreateWidgetKeyRequest"];

/** The assistant of one knowledge base (engine conversation layer C2). */
export type AssistantStateResponse = Schemas["AssistantStateResponse"];
export type AssistantVersionResponse = Schemas["AssistantVersionResponse"];
export type AssistantDraftPatchRequest = Schemas["PatchDraftRequest"];
export type AssistantPublishRequest = Schemas["PublishRequest"];

export type TenantListResponse = Schemas["TenantListResponse"];
export type CreateTenantRequest = Schemas["CreateTenantRequest"];
export type CreateTenantResponse = Schemas["CreateTenantResponse"];
export type RotateTenantKeyResponse = Schemas["RotateTenantKeyResponse"];
export type TenantResponse = Schemas["TenantResponse"];
export type AdminTenantResponse = Schemas["AdminTenantResponse"];
export type ActivateTenantRequest = Schemas["ActivateTenantRequest"];
export type SuspendTenantRequest = Schemas["SuspendTenantRequest"];
export type DeclineTenantRequest = Schemas["DeclineTenantRequest"];

export type PlanOut = Schemas["PlanOut"];
export type PlanListResponse = Schemas["PlanListResponse"];
export type PlanUsageResponse = Schemas["PlanUsageResponse"];
export type SetTenantPlanRequest = Schemas["SetTenantPlanRequest"];

export type TeamResponse = Schemas["TeamResponse"];
export type InviteRequest = Schemas["InviteRequest"];
export type InvitationOut = Schemas["InvitationOut"];
export type AdminInvitationOut = Schemas["AdminInvitationOut"];

export type SettingsResponse = Schemas["SettingsResponse"];
export type SettingsPatch = Schemas["SettingsPatch"];

export type InfoResponse = Schemas["InfoResponse"];
export type FeedbackListResponse = Schemas["FeedbackListResponse"];
export type MigrationListResponse = Schemas["MigrationListResponse"];

/*
 * POST /api/v1/query/stream. The spec types the route's response only as text/event-stream, so
 * the event payloads are written out here from the route's documented contract: `sources` first,
 * then `token` repeatedly, then `done`; or `error` in place of the rest if generation fails.
 */

/** One citation in the `sources` event. `index` is the [n] the answer cites. */
export interface QueryStreamSource {
	index: number;
	chunk_id: string;
	document_id: string | null;
	external_id: string | null;
	file_name: string | null;
	section: string | null;
	page: number | null;
	snippet: string;
	score: number;
}

export interface QueryStreamUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export type QueryStreamEvent =
	| { event: "sources"; data: { query_id: string; sources: QueryStreamSource[] } }
	| { event: "token"; data: { content: string } }
	| { event: "done"; data: { query_id: string; model: string; latency_ms: number; usage: QueryStreamUsage } }
	| { event: "error"; data: { detail: string } };
