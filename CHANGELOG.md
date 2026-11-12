# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-12

The first public release, for cob-rag-engine 0.2.0.

### Changed

- **Licence: MIT.** cob-rag-mcp is now under the MIT licence, like the client libraries of cob-rag-engine.
  The engine itself stays AGPL-3.0. Earlier releases were AGPL-3.0-only.

Catches up with the engine's current API (`docs/openapi.json` regenerated). Needs an engine with
paged corpus and job lists, `/info`, `/tenants/me`, `/documents/{id}`, `/feedback` (GET) and
`/migrations`, and, for the team, plan and settings tools, the engine's accounts layer (plans,
teams, engine settings).

Engine types: handoffs (C5).

### Added
- **Lead tools** (engine conversation layer C4): `list_leads` (filters by status, knowledge base, dates and an exact phone or e-mail) and `export_leads` (CSV; the engine allows owners only and audits every export). Tenant and admin keys only; the engine gives lead data to a `write` key, so both tools are `write`: a read key does not see them and read-only mode hides them. CLI: `leads list`, `leads export`. Needs an engine with `phase12_003`.
- **Assistant tools** (engine conversation layer): `get_assistant`, `update_assistant_draft` (a JSON
  merge patch over the draft, sent with the draft revision it read so a stale edit is refused) and
  `publish_assistant`. All three are offered to every key kind; reading is `read`, the other two are
  `write` (publishing is reversible in the engine, so it is not destructive). CLI: `assistant get`,
  `assistant draft`, `assistant publish`. Needs an engine with `phase12_001`.
- **Key permissions** (engine named keys): the server reads the key's `permission` (`read`, `write`
  or `full`, new in `whoami`) and offers only the tools it allows, so a read key never sees a write
  or destructive tool. A refused call says what permission it needs (`key_permission_denied`).
- **Delete guardrails**: `delete_corpus`, `delete_document` and `delete_tenant` require
  `confirm_name`, the item's exact name, and new read-only tools `preview_delete_corpus`,
  `preview_delete_document` and `preview_delete_tenant` (CLI: `... delete-preview`) show what a
  delete would remove and the name to confirm with. The engine's `confirmation_required` error is
  explained in words.
- README: "Install before npm publish" (`git clone`, `pnpm install && pnpm build && npm link`) and a
  "Key permissions" section.
- **Website** at https://callobuzz.github.io/cob-rag-mcp (GitHub Pages from `docs/`, not shipped in the npm package); `homepage` points to it, and the README links to the engine, its site and npm.
- **Skipped uploads**: the engine can now drop a near-duplicate upload (`skipped` job status); `get_ingest_job` and `--wait` treat it as settled. Types regenerated.

### Changed
- **Team tools** (engine accounts A5): `list_team` (`team list`; a tenant key its own team, the
  admin key any tenant's with `tenant_id`: owners and members with their last sign-in, and open
  invitations), `invite_member` (`team invite`, tenant key: the engine e-mails the link, never
  returned) and `admin_invite` (`team admin-invite`, admin key: returns `accept_url`, the link to
  send the person yourself, for example a customer's first owner on an engine without SMTP).
- **Plan tools** (engine accounts A6): `list_plans` (`plans list`, admin: the four limits and how
  many tenants use each), `set_tenant_plan` (`plans set`, admin) and `get_my_plan`
  (`plans usage`; a tenant key its own, the admin key any tenant's: questions this month and when
  they reset, knowledge bases, documents and widget keys against the limits). `activate_tenant`
  takes `plan_id`; `create_tenant` takes `plan_id`, and `max_corpora` up to 10,000 (a per-tenant
  override of the plan's knowledge-base limit).
- **Engine settings tools** (engine accounts A7): `get_settings` (`engine settings`) and
  `update_settings` (`engine update-settings`), admin key: the sign-up mode (`open`, `approval`,
  `closed`) and white-label branding; null resets a field.
- **Errors by the engine's code**: `question_cap_reached` reads "This workspace has used all the
  questions its plan allows this month; they reset at …" with the engine's `resets_at`;
  `kb_limit_reached`, `document_limit_reached` and `widget_key_limit_reached` name the plan limit
  (with the engine's `limit`); these carry the new error code `LIMIT`. `owner_required` reads "Only
  a workspace owner can do this". Any other error keeps the engine's `detail`.
- The live integration test covers the tenant-required corpus create, suspend and reactivate with
  the typed name, plans, plan usage, an admin invitation, the team list and the settings; it
  deletes its tenant with the typed name (the engine's hard delete refuses it otherwise).
- **Tenant lifecycle** (engine accounts A4). `deactivate_tenant` is gone: the engine's
  `DELETE /api/v1/admin/tenants/{id}` is now a hard delete that needs the tenant's name typed, and
  answers the old call with 422. New tools: `suspend_tenant` (destructive; `confirm_name`, the
  tenant's exact name, required; every key, widget and sign-in of the tenant stops),
  `reactivate_tenant`, `activate_tenant` (a pending sign-up, optional `note`), `decline_tenant`
  (destructive; removes a pending sign-up) and `delete_tenant` (destructive; `confirm_name`
  required; the tenant and everything it owns). `list_tenants` shows status and owners and takes
  `status`, `search`, `offset` and `limit` (the engine's list is paged now). A 403 with the
  engine's code `workspace_not_active` reads "This workspace is not active (pending or
  suspended); ask the operator." Generated engine types regenerated.
- **Every corpus belongs to a tenant** (engine accounts A1). `create_corpus` with the admin key
  needs `tenant_id` (the engine answers 422 `tenant_required` without it; a tenant key still
  creates for itself), and `update_corpus` no longer accepts `tenant_id: null`: a corpus can be
  moved to another tenant but not detached. Generated engine types regenerated.
- **`list_corpora` is paged**, as the engine's `GET /api/v1/corpora` now is (100 per page unless
  `limit` says otherwise, at most 500). It takes `offset`, `limit` and `tenant_id`, and `all: true`
  fetches every page. Results carry `count` (this page) and `total`; each corpus carries its tenant,
  document and chunk counts and last activity. The CLI shows those columns and says when more pages
  exist (`corpora 1-100 of 240. More: --offset 100, or --all for every page`).
- **Documents and settings tools work with admin and tenant keys**: `list_documents`,
  `list_document_versions`, `delete_document`, `get_corpus_settings` and `update_corpus_settings`
  take `corpus_id` (or the `COB_RAG_CORPUS_ID` default) and are offered to every key kind. A corpus
  key still never sees the field.
- `list_documents` takes `search` (part of the file name or record id) and shows record ids and
  metadata; the CLI says which page it is.
- `list_ingest_jobs` takes `status`, `corpus_id`, `offset` and `limit` (at most 100 now, as the
  engine enforces) and shows each job's corpus, file and mode with the page and total.
  `get_ingest_job` shows the new job fields and, for an upload held in `pending_review`, the
  existing documents it resembles.
- `create_corpus` takes `embedding_config`; `update_corpus` takes `tenant_id` (admin key: move a
  corpus to another tenant).
- A `corpus_id` that only filters a list (jobs, feedback, migrations) never takes the configured
  default corpus.

### Added
- `get_engine_info` (`info`, any key): engine version, features, embedding and LLM models, public
  URL and limits.
- `get_document` (`documents get`, any key, *corpus_id*): a document with its versions and the
  chunks the engine indexed, paged with `chunk_offset` / `chunk_limit`, or another version's with
  `version_id`.
- `list_feedback` (`feedback list`, any key): ratings with their questions, filtered by corpus,
  rating range and time, paged.
- `list_migrations` (`migrations list`, admin and tenant keys, read-only): embedding migrations
  across corpora, filtered by corpus and status, paged.
- `get_my_tenant` (`tenants me`) and `rotate_my_tenant_key` (`tenants rotate-my-key`), tenant keys
  only. Rotation is destructive: hidden over MCP unless destructive tools are allowed, and the CLI
  warns that the key in use (and where it came from) stops working at once, asks or needs `--yes`,
  then offers to save the new key to the config file (`--save-key` saves without asking) and
  reminds you when `COB_RAG_API_KEY` or `--key` still holds the old one.

### Fixed
- CLI command summaries in `--help` were the whole description instead of its first sentence.

## [0.1.0] - 2026-09-29

First release. An MCP server and a CLI for a self-hosted
[cob-rag-engine](https://github.com/callobuzz/cob-rag-engine), from one set of tool definitions.

### Added
- **26 tools**, each an MCP tool and a CLI command: `whoami`; `search` (passages with sources from
  `/query/retrieve`) and `ask` (a cited answer from `/query`); documents
  (list, versions, delete); ingest (text records, file upload, job status, job list); usage;
  corpus self-service settings; corpora (list, get, create, update, rotate key, delete); widget
  keys (list, create, revoke); tenants (list, create, rotate key, deactivate).
- **Streaming answers in the CLI.** `ask --stream` reads the engine's named `/query/stream` events
  (`sources`, `token`, `done`, `error`): it prints the answer as it is generated, then its
  sources and the model and latency; `--stream --json` prints one JSON event per line. An `error`
  event, a stream cut off before `done`, and HTTP 422/502 before the stream starts are reported as
  errors; an engine still sending the older unnamed `data:` format is named as such. MCP `ask`
  stays a single complete answer from `/query`. Needs an engine with the named-event stream.
- **Clearing settings.** `update_corpus` and `update_corpus_settings` accept null: a field set to
  null inside `llm_config` / `prompt_config` / `retrieval_config` is removed (the engine default
  applies again), `llm_config.api_key: null` deletes the stored key, a whole section set to null
  resets it, and `description: null` clears the description. On the command line, pass `null`
  (`--description null`, `--llm-config '{"api_key": null}'`).
- `get_usage` lists the engine's `conversation` usage source.
- **Key-aware tool lists.** The MCP server calls `/api/v1/whoami` at start and registers only what
  that key kind can use: a corpus key never sees tenant or admin tools, and never sees a
  `corpus_id` field it cannot use.
- **Safety gates.** Destructive tools are hidden from MCP clients unless
  `COB_RAG_ALLOW_DESTRUCTIVE=true` / `--allow-destructive`; the CLI asks before each one, or takes
  `--yes`, and refuses when it cannot ask. `--read-only` / `COB_RAG_READ_ONLY` hides or refuses
  every write. Tool annotations (`readOnlyHint`, `destructiveHint`) match.
- **Transports.** stdio (default) and stateless streamable HTTP (`start --transport http`), where
  every request carries its own engine key (`Authorization: Bearer` or `X-API-Key`) and is
  forwarded as-is. No fallback to a server-side key unless `COB_RAG_HTTP_USE_SERVER_KEY=true`.
  Binds `127.0.0.1` by default, with a Host/Origin check against DNS rebinding.
- **Bring your own model key.** `COB_RAG_LLM_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL` are
  sent as the engine's `X-LLM-*` headers on the routes that read them.
- **Upload fence.** Over MCP, `upload_file` is stdio-only and reads only inside
  `COB_RAG_UPLOAD_DIR`, checked before touching the filesystem and again after resolving symlinks.
- **Config.** Flags, then environment, then a per-user config file written owner-only;
  `login` (validates with `/whoami` before saving), `config show/get/set/unset/path`, secrets
  masked everywhere.
- **CLI output.** Readable tables by default, `--json` for machines; JSON options accept
  `@file.json` and JSON lines.
- **`answer-with-citations` MCP prompt.**
- **Types generated from the engine's OpenAPI spec** (`pnpm gen:api`), so every request and
  response is checked against the API at compile time.
- Unit tests for every tool, visibility, gating, config precedence and masking, both transports
  and the upload guard; live integration tests gated on `COB_RAG_URL` + `COB_RAG_API_KEY`.
- Dockerfile for HTTP mode, CI workflow (lint, typecheck, test, build).
