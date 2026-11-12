import type { AnyTool } from "../core/tool.js";
import { getAssistantTool, publishAssistantTool, updateAssistantDraftTool } from "./assistant.js";
import {
	createCorpusTool,
	deleteCorpusTool,
	getCorpusTool,
	listCorporaTool,
	previewDeleteCorpusTool,
	rotateCorpusKeyTool,
	updateCorpusTool,
} from "./corpora.js";
import {
	deleteDocumentTool,
	getDocumentTool,
	listDocumentsTool,
	listDocumentVersionsTool,
	previewDeleteDocumentTool,
} from "./documents.js";
import { listFeedbackTool } from "./feedback.js";
import { getEngineInfoTool, whoamiTool } from "./identity.js";
import { addRecordsTool, getIngestJobTool, listIngestJobsTool, uploadFileTool } from "./ingest.js";
import { exportLeadsTool, listLeadsTool } from "./leads.js";
import { listMigrationsTool } from "./migrations.js";
import { getMyPlanTool, listPlansTool, setTenantPlanTool } from "./plans.js";
import { askTool, searchTool } from "./query.js";
import { getCorpusSettingsTool, getSettingsTool, updateCorpusSettingsTool, updateSettingsTool } from "./settings.js";
import { adminInviteTool, inviteMemberTool, listTeamTool } from "./team.js";
import {
	activateTenantTool,
	createTenantTool,
	declineTenantTool,
	deleteTenantTool,
	getMyTenantTool,
	listTenantsTool,
	previewDeleteTenantTool,
	reactivateTenantTool,
	rotateMyTenantKeyTool,
	rotateTenantKeyTool,
	suspendTenantTool,
} from "./tenants.js";
import { getUsageTool } from "./usage.js";
import { createWidgetKeyTool, listWidgetKeysTool, revokeWidgetKeyTool } from "./widget-keys.js";

/** Every tool, in the order MCP clients and `--help` list them. */
export const ALL_TOOLS: readonly AnyTool[] = [
	whoamiTool,
	getEngineInfoTool,
	searchTool,
	askTool,
	listDocumentsTool,
	getDocumentTool,
	listDocumentVersionsTool,
	previewDeleteDocumentTool,
	deleteDocumentTool,
	addRecordsTool,
	uploadFileTool,
	getIngestJobTool,
	listIngestJobsTool,
	getUsageTool,
	listLeadsTool,
	exportLeadsTool,
	listFeedbackTool,
	getCorpusSettingsTool,
	updateCorpusSettingsTool,
	getAssistantTool,
	updateAssistantDraftTool,
	publishAssistantTool,
	listCorporaTool,
	getCorpusTool,
	createCorpusTool,
	updateCorpusTool,
	rotateCorpusKeyTool,
	previewDeleteCorpusTool,
	deleteCorpusTool,
	listMigrationsTool,
	listWidgetKeysTool,
	createWidgetKeyTool,
	revokeWidgetKeyTool,
	getMyTenantTool,
	rotateMyTenantKeyTool,
	listTenantsTool,
	createTenantTool,
	rotateTenantKeyTool,
	activateTenantTool,
	suspendTenantTool,
	reactivateTenantTool,
	declineTenantTool,
	previewDeleteTenantTool,
	deleteTenantTool,
	listTeamTool,
	inviteMemberTool,
	adminInviteTool,
	getMyPlanTool,
	listPlansTool,
	setTenantPlanTool,
	getSettingsTool,
	updateSettingsTool,
];

export function findTool(name: string): AnyTool | undefined {
	return ALL_TOOLS.find((tool) => tool.name === name);
}
