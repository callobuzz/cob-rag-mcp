import { z } from "zod";
import type { AdminInvitationOut, InvitationOut, InviteRequest, TeamResponse } from "../core/api-types.js";
import { seg } from "../core/client.js";
import { keyValues, table } from "../core/format.js";
import { defineTool } from "../core/tool.js";
import { uuid } from "./schemas.js";

// A tenant's team: the people who sign in to its dashboard, as owners or members (engine accounts
// A5). A tenant key acts as an owner of its own tenant (/api/v1/tenants/me/...); the admin key
// reaches any tenant's team (/api/v1/admin/tenants/{id}/...). The engine e-mails invitation links
// and never returns them, except to the admin, so an operator can onboard a customer without SMTP.

const email = z.string().email().max(320).describe("The person's e-mail address.");
const role = z.enum(["owner", "member"]).describe("owner (can manage keys and the team) or member.");
const SEND_LINK =
	"Send this link to the person yourself (it works once, for 7 days; it is e-mailed too when the engine has SMTP).";

function renderTeam(data: unknown): string {
	const res = data as TeamResponse;
	const members = table(res.members, [
		{ key: "email", max: 40 },
		{ key: "name", max: 30 },
		{ key: "role" },
		{ key: "joined_at" },
		{ key: "last_login_at", label: "last login" },
	]);
	const invitations = table(res.invitations, [
		{ key: "email", max: 40 },
		{ key: "role" },
		{ key: "invited_by", max: 30 },
		{ key: "expires_at" },
	]);
	return `Members\n${members}\n\nOpen invitations\n${invitations}`;
}

export const listTeamTool = defineTool({
	name: "list_team",
	title: "List a team",
	description:
		"The people of a tenant (owners and members, with their last sign-in) and its open invitations. A tenant " +
		"key lists its own team; the admin key names the tenant with tenant_id.",
	group: "team",
	command: "list",
	kinds: ["admin", "tenant"],
	access: "read",
	input: {
		tenant_id: uuid("Admin key: the tenant (from list_tenants). A tenant key leaves it out.").optional(),
	},
	handler: async (input, ctx) =>
		ctx.client.get<TeamResponse>(
			input.tenant_id ? `/api/v1/admin/tenants/${seg(input.tenant_id)}/members` : "/api/v1/tenants/me/members",
		),
	render: renderTeam,
});

export const inviteMemberTool = defineTool({
	name: "invite_member",
	title: "Invite a teammate",
	description:
		"Invite someone to this tenant's team as owner or member. The engine e-mails them a link (single use, 7 " +
		"days); it is never returned here. Inviting the same address again replaces the earlier link.",
	group: "team",
	command: "invite",
	kinds: ["tenant"],
	access: "write",
	positional: ["email"],
	input: { email, role: role.default("member") },
	handler: async (input, ctx) => {
		const body: InviteRequest = { email: input.email, role: input.role };
		return ctx.client.request<InvitationOut>("POST", "/api/v1/tenants/me/members", { body });
	},
	render: (data) => `${keyValues(data, ["id", "email", "role", "expires_at"])}\n\nThe invitation link was e-mailed.`,
});

export const adminInviteTool = defineTool({
	name: "admin_invite",
	title: "Invite someone to a tenant",
	description:
		"Operator: invite someone to any tenant, typically its first owner. The response carries accept_url, the " +
		`link to send them: ${SEND_LINK}`,
	group: "team",
	command: "admin-invite",
	kinds: ["admin"],
	access: "write",
	positional: ["tenant_id", "email"],
	input: {
		tenant_id: uuid("The tenant (from list_tenants)."),
		email,
		role: role.default("owner"),
	},
	handler: async (input, ctx) => {
		const body: InviteRequest = { email: input.email, role: input.role };
		return ctx.client.request<AdminInvitationOut>("POST", `/api/v1/admin/tenants/${seg(input.tenant_id)}/invitations`, {
			body,
		});
	},
	render: (data) =>
		`${keyValues(data, ["id", "email", "role", "expires_at"])}\n\n` +
		`Accept link: ${(data as AdminInvitationOut).accept_url}\n${SEND_LINK}`,
});
