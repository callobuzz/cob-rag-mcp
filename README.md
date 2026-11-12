# cob-rag-mcp

**[Website](https://callobuzz.github.io/cob-rag-mcp)** · **[cob-rag-engine](https://github.com/callobuzz/cob-rag-engine)** · **[Engine website](https://callobuzz.github.io/cob-rag-engine)** · **[npm](https://www.npmjs.com/package/cob-rag-mcp)** · **[Callobuzz open source](https://callobuzz.com/open-source)**

[![npm version](https://img.shields.io/npm/v/cob-rag-mcp?color=blue)](https://www.npmjs.com/package/cob-rag-mcp)
[![build](https://img.shields.io/github/actions/workflow/status/callobuzz/cob-rag-mcp/ci.yml?branch=main)](https://github.com/callobuzz/cob-rag-mcp/actions)
[![release](https://img.shields.io/github/v/release/callobuzz/cob-rag-mcp?color=blue)](https://github.com/callobuzz/cob-rag-mcp/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub stars](https://img.shields.io/github/stars/callobuzz/cob-rag-mcp?style=social)](https://github.com/callobuzz/cob-rag-mcp)

**An MCP server and a full CLI for [cob-rag-engine](https://github.com/callobuzz/cob-rag-engine)**,
the [self-hosted knowledge layer](https://callobuzz.github.io/cob-rag-engine) for AI assistants and agents. Plug a business's own knowledge base
into Claude, Cursor, VS Code, n8n or any MCP client, or work with it straight from the shell. One
set of 52 tools, two ways in.

> [!IMPORTANT]
> **You host the engine. There is no hosted service, and there never will be.**
> cob-rag-mcp is only a client: it talks to a cob-rag-engine that you run yourself, on your laptop,
> your server or your cloud, using the URL and key you give it. Nothing is sent anywhere else. If
> you do not have an engine yet, start with the engine's
> **[quick start](https://github.com/callobuzz/cob-rag-engine#quick-start)** (one
> `docker compose up`), then come back here.

## Why

An agent is only as useful as what it knows about the business it works for: the returns policy,
the price list, which tests need fasting. [cob-rag-engine](https://github.com/callobuzz/cob-rag-engine) holds that knowledge, one isolated
knowledge base (a *corpus*) per business, with hybrid search, citations and usage metering. This
package puts it where agents and people work:

- **In any MCP client.** The agent calls `search` to pull the right passages, with sources, and
  answers from them with its own model. Or it calls `ask` for a complete cited answer written by
  the model configured in your engine.
- **In the shell.** `cob-rag-engine search "..."`, `ingest records`, `corpora create`, `usage`:
  every tool is also a command, with readable tables by default and `--json` for scripts.
- **Scoped by the key you hand it.** A corpus key (`ck_`) sees one knowledge base and nothing
  else. A tenant key (`tk_`) manages that tenant's corpora. The admin key runs the engine. The
  server asks the engine who the key is and offers only the tools that key can use.

| | **CLI** (`cob-rag-engine`) | **MCP server** (`cob-rag-mcp start`) |
|---|---|---|
| Who it is for | You, scripts, CI, an agent's own terminal | Claude, Cursor, VS Code, n8n, any MCP client |
| Output | Tables; `--json` for machines | JSON tool results |
| Destructive actions | Asks first, or `--yes` | Hidden unless `COB_RAG_ALLOW_DESTRUCTIVE=true` |
| Transports | n/a | stdio (default) and streamable HTTP |

## Prerequisites

- **A running [cob-rag-engine](https://github.com/callobuzz/cob-rag-engine)** you can reach, and a key for it: the admin key
  (`RAG_ADMIN_API_KEY` in the engine's `.env`), a tenant key (`tk_...`) or a corpus key (`ck_...`).
  See the engine's [quick start](https://github.com/callobuzz/cob-rag-engine#quick-start).
- **Node.js 22 or newer.**
- For `ask`: a model configured in the engine (engine default, per corpus, or per request with
  the bring-your-own-key settings below). `search` needs no model at all.

## Install

```bash
# Run without installing (what MCP client configs below use)
npx -y cob-rag-mcp start

# Or install globally: gives you both commands
npm i -g cob-rag-mcp
cob-rag-engine --help      # the CLI
cob-rag-mcp start          # the MCP server (same program, second name)
```

### Install before npm publish

Until the package is on npm, install it from a checkout. You need Node.js 22+ and
[pnpm](https://pnpm.io/installation):

```bash
git clone https://github.com/callobuzz/cob-rag-mcp.git
cd cob-rag-mcp
pnpm install && pnpm build && npm link
```

`npm link` puts both commands on your `PATH` (`cob-rag-mcp` and `cob-rag-engine`). Check with
`cob-rag-mcp --help`, then configure (below) and use `cob-rag-mcp start` wherever a snippet in
[Connect an MCP client](#connect-an-mcp-client) says `npx -y cob-rag-mcp start`: the `command` is
`cob-rag-mcp` and the `args` are `["start"]`. Pull and `pnpm build` again to update; `npm unlink -g
cob-rag-mcp` removes the link.

The engine's dashboard does this for you: **Agents, Connect an agent** makes a named key for the
client you pick, with the permission you choose (read by default), and shows the exact config for
it, including these local-install commands.

## Configure

Settings come from, in order of priority: **command-line flags, then environment variables, then
your config file, then defaults.**

| Setting | Environment variable | Flag | Default |
|---|---|---|---|
| Engine URL | `COB_RAG_URL` | `--url` | `http://127.0.0.1:8000` |
| Engine key (admin, `tk_` or `ck_`) | `COB_RAG_API_KEY` | `--key` | none |
| Default corpus for tenant/admin keys | `COB_RAG_CORPUS_ID` | `--corpus-id` per command | none |
| Offer destructive tools over MCP | `COB_RAG_ALLOW_DESTRUCTIVE` | `--allow-destructive` | `false` |
| Hide or refuse every write | `COB_RAG_READ_ONLY` | `--read-only` | `false` |
| The only directory MCP `upload_file` may read | `COB_RAG_UPLOAD_DIR` | | none (upload off) |
| HTTP mode: let keyless requests use the server key | `COB_RAG_HTTP_USE_SERVER_KEY` | | `false` |
| Config file location | `COB_RAG_CONFIG` | `--config` | see below |

**Bring your own model key.** These are sent as the engine's `X-LLM-Provider`, `X-LLM-Model`,
`X-LLM-API-Key` and `X-LLM-Base-URL` headers on `search` and `ask` only (the only routes that read
them: `/query`, `/query/stream`, `/query/retrieve`). They override the corpus and engine model for
that request, so a client can pay its model provider directly.

| Setting | Environment variable |
|---|---|
| LiteLLM provider id (`openai`, `anthropic`, `openrouter`, `ollama`...) | `COB_RAG_LLM_PROVIDER` |
| Model | `COB_RAG_LLM_MODEL` |
| Provider API key | `COB_RAG_LLM_API_KEY` |
| Custom base URL (Ollama, a proxy) | `COB_RAG_LLM_BASE_URL` |

**Save them once with `login`:**

```bash
cob-rag-engine login --url http://127.0.0.1:8000 --key ck_...
# Logged in to http://127.0.0.1:8000 with ck_****a1b2
# kind         corpus
# corpus_name  acme-faq
# ...
# Saved to ~/.config/cob-rag-mcp/config.json (readable by you only).
```

`login` checks the key with the engine's `/api/v1/whoami` before saving anything. Leave `--key`
out at a terminal and it prompts without echoing, so the key stays out of your shell history. The
file is written with owner-only permissions (`0600`) at:

| OS | Path |
|---|---|
| Linux | `$XDG_CONFIG_HOME/cob-rag-mcp/config.json`, else `~/.config/cob-rag-mcp/config.json` |
| macOS | `~/.config/cob-rag-mcp/config.json` |
| Windows | `%APPDATA%\cob-rag-mcp\config.json` |

```bash
cob-rag-engine config show              # every setting, its source (flag/env/file/default), secrets masked
cob-rag-engine config get api_key       # ck_****a1b2
cob-rag-engine config get api_key --reveal
cob-rag-engine config set corpus_id 7b221003-...
cob-rag-engine config unset llm_api_key
cob-rag-engine config path
```

## Connect an MCP client

Each snippet runs the server over stdio with a corpus key. Swap in a tenant or admin key to manage
corpora; the tool list follows the key. Give an agent its **own named key with the lowest
permission it needs** (see [Key permissions](#key-permissions)): the dashboard's Agents page makes
one in a click, and you can revoke it without touching anything else.

### Claude Code

```bash
claude mcp add cob-rag \
  -e COB_RAG_URL=http://127.0.0.1:8000 \
  -e COB_RAG_API_KEY=ck_your_corpus_key \
  -- npx -y cob-rag-mcp start
```

Already ran `cob-rag-engine login`? Then `claude mcp add cob-rag -- npx -y cob-rag-mcp start` is
enough: the server reads the saved config.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "cob-rag": {
      "command": "npx",
      "args": ["-y", "cob-rag-mcp", "start"],
      "env": {
        "COB_RAG_URL": "http://127.0.0.1:8000",
        "COB_RAG_API_KEY": "ck_your_corpus_key"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "cob-rag": {
      "command": "npx",
      "args": ["-y", "cob-rag-mcp", "start"],
      "env": {
        "COB_RAG_URL": "http://127.0.0.1:8000",
        "COB_RAG_API_KEY": "ck_your_corpus_key"
      }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. The `inputs` block makes VS Code ask for the key once and store it securely,
so it never sits in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "cob-rag-key", "description": "cob-rag-engine key", "password": true }
  ],
  "servers": {
    "cob-rag": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cob-rag-mcp", "start"],
      "env": {
        "COB_RAG_URL": "http://127.0.0.1:8000",
        "COB_RAG_API_KEY": "${input:cob-rag-key}"
      }
    }
  }
}
```

### Any other stdio client

Command `npx`, arguments `-y cob-rag-mcp start`, plus the `COB_RAG_*` environment variables. With
a global install, the command is simply `cob-rag-mcp start`.

### n8n, remote agents and anything that speaks HTTP

Run the streamable HTTP transport:

```bash
cob-rag-mcp start --transport http --host 127.0.0.1 --port 3333
# cob-rag-mcp 0.2.0: MCP over HTTP at http://127.0.0.1:3333/mcp -> http://127.0.0.1:8000 (each request must carry its own key)
```

**Every request must carry the caller's own engine key**, as `Authorization: Bearer <key>` or
`X-API-Key: <key>`. The server checks it with the engine and forwards it; each caller sees only
what its own key allows. A request without a key gets `401`, even if the server has a key
configured, unless you set `COB_RAG_HTTP_USE_SERVER_KEY=true` on purpose. Callers may also send
their own `X-LLM-*` headers; the server's `COB_RAG_LLM_*` settings are not used in HTTP mode, so
the server's model key is never spent on a caller's behalf.

- **n8n:** add an *MCP Client Tool* node, endpoint `http://127.0.0.1:3333/mcp`, transport
  *HTTP Streamable*, authentication *Bearer*, token = the corpus key.
- **Claude Code over HTTP:**
  `claude mcp add --transport http cob-rag http://127.0.0.1:3333/mcp --header "Authorization: Bearer ck_..."`
- **Health check:** `GET /health` answers `{"status":"ok"}` without a key.

The server is stateless (one fresh MCP server per request), so it scales horizontally and needs no
sticky sessions. It binds `127.0.0.1` by default and, while on loopback, refuses requests whose
`Host` or `Origin` is not local (a DNS-rebinding guard). If you bind wider, put TLS in front of
it: keys travel in headers.

### Docker (HTTP mode)

```bash
docker build -t cob-rag-mcp .
docker run --rm -p 127.0.0.1:3333:3333 \
  -e COB_RAG_URL=http://host.docker.internal:8000 \
  cob-rag-mcp
```

Inside the container the server binds `0.0.0.0` (it has to, to be reachable); the `-p
127.0.0.1:...` mapping keeps it local to your machine. The engine URL must be reachable from the
container: `host.docker.internal` for an engine on the host, or the engine's service name on a
shared Docker network.

## CLI

`cob-rag-engine <command> [options]`. Global options: `--url`, `--key`, `--config`, `--json`,
`--yes`, `--read-only`. Every command has `--help`.

```bash
# Who is this key?
cob-rag-engine whoami

# Search: passages with sources, no model needed
cob-rag-engine search "How long should I fast before a cholesterol test?" --final-k 3
# [1] Fasting before a lipid profile [faq-fasting-lipid]  (score 0.066)
#     For a lipid profile (cholesterol test) fast for 10 to 12 hours before your sample is taken. ...

# Ask: a cited answer from the engine's model
cob-rag-engine ask "Do I need to fast for a thyroid test?"
# No, you do not need to fast for a thyroid test. ... [1]
#
# Sources:
#   [1] Thyroid test (TSH, T3, T4) [faq-thyroid]
#
# confidence 1.00 | openai/gpt-oss-20b | 11287 ms

# Stream it: the answer prints as it is generated, then its sources, model and latency
# (no confidence score: a streamed answer is not validated)
cob-rag-engine ask "How long should I fast before a cholesterol test?" --stream
# You should fast for **10 to 12 hours** before a cholesterol (lipid profile) test. Water is allowed during this period.[1]
#
# Sources:
#   [1] Lipid profile fasting [faq-lipid]
#   [2] Thyroid test [faq-thyroid]
#   [3] Report timing [faq-reports]
#
# openai/gpt-oss-20b | 7840 ms

# The raw events, one JSON object per line: sources, token..., done (or error)
cob-rag-engine ask "Do I need to fast for a thyroid test?" --stream --json

# Add FAQ entries, products or articles (JSON array or JSON lines), and wait until indexed
cob-rag-engine ingest records --records @faq.json --wait
cob-rag-engine ingest upload ./price-list.pdf --wait
cob-rag-engine ingest jobs --status pending_review
cob-rag-engine ingest job <job id>          # a held upload lists the documents it resembles

# Documents, usage, feedback, settings
cob-rag-engine documents list --search price
cob-rag-engine documents get <document id> --chunk-limit 5   # the chunks the engine indexed
cob-rag-engine usage --group-by source --start 2026-09-01
cob-rag-engine feedback list --max-rating 2 --start 2026-09-01
cob-rag-engine settings update --retrieval-config '{"final_k": 8}'
cob-rag-engine settings update --retrieval-config '{"final_k": null}'   # null: back to the default

# The engine itself: version, features, models, limits (any key)
cob-rag-engine info

# Tenant or admin keys: manage knowledge bases and widget keys
cob-rag-engine corpora create "pune-path-lab" --description "Test prep FAQ"   # a tenant key: its own
cob-rag-engine corpora create "pune-path-lab" --tenant-id <tenant id>          # the admin key names the tenant
cob-rag-engine corpora list                  # 100 per page; says when there are more
# corpora 1-100 of 240. More: --offset 100, or --all for every page
cob-rag-engine corpora list --all
cob-rag-engine documents list --corpus-id <id>   # documents, settings: name the corpus
cob-rag-engine widget-keys create "Lab website" --corpus-id <id> --allowed-origins https://lab.example
cob-rag-engine migrations list --status pending_approval
cob-rag-engine corpora delete <id>          # asks first; --yes to skip

# The admin key: plans, a customer's first owner (send them the printed link), settings
cob-rag-engine plans list
cob-rag-engine tenants activate <tenant id> --plan-id <plan id> --note "paid via UPI"
cob-rag-engine team admin-invite <tenant id> owner@shree.example
cob-rag-engine plans usage --tenant-id <tenant id>
cob-rag-engine engine update-settings --signup-mode approval --branding '{"product_name": "Sahayak AI"}'

# A tenant key: its own record, plan and team, and a new key for itself
cob-rag-engine plans usage                   # questions this month, and when they reset
cob-rag-engine team list
cob-rag-engine team invite ravi@shree.example --role member
cob-rag-engine tenants me
cob-rag-engine tenants rotate-my-key        # warns, asks, then offers to save the new key
cob-rag-engine tenants rotate-my-key --yes --save-key   # scripts: rotate and save in one go

# Machine-readable output
cob-rag-engine documents list --json | jq '.items[].id'

# Every tool and which keys can use it
cob-rag-engine tools
```

JSON-shaped options (`--records`, `--retrieval-config`, `--metadata-filters`, ...) take inline
JSON or `@path/to/file.json`; `--records @file.jsonl` reads one record per line. Lists
(`--allowed-origins`) take commas or a JSON array.

Updates change only what you send. Inside `--llm-config`, `--prompt-config` and
`--retrieval-config` a field set to `null` is removed so the engine default applies again
(`{"api_key": null}` deletes a stored model key), `{}` changes nothing, and the whole option set
to `null` resets that section. `corpora update <id> --description null` clears the description.

Lists are paged by the engine. Under each table the CLI says which items these are and, when
there are more, the option that gets the next page; `--json` output carries the engine's `count`,
`total`, `offset` and `limit` as they are.

`tenants rotate-my-key` replaces the very key the CLI is using, and the old key fails on its next
request. The CLI says so (and where that key came from) before asking, then offers to save the new
key to your config file; `--save-key` saves without asking. If the key came from
`COB_RAG_API_KEY` or `--key`, it reminds you to replace it there too.

Streaming (`ask --stream`) is a CLI feature. An MCP tool call returns one result, so MCP `ask`
always returns the complete answer from `/query`, with its confidence score.

Exit codes: `0` success, `1` engine or configuration error, `2` invalid input.

## Tools

The MCP server registers only the tools the key can use, and hides destructive tools unless they
are allowed. With a tenant or admin key, tools marked *corpus_id* need one (or a
`COB_RAG_CORPUS_ID` default); a corpus key never sees that field.

| Tool | CLI command | Keys | Access | What it does |
|---|---|---|---|---|
| `whoami` | `whoami` | admin, tenant, corpus | read | Which kind of key this is and what it reaches |
| `get_engine_info` | `info` | admin, tenant, corpus | read | Engine version, features, embedding and LLM models, limits (no secrets) |
| `search` | `search` | admin, tenant, corpus | read | Relevant passages with sources, no generation (*corpus_id*) |
| `ask` | `ask` | admin, tenant, corpus | read | A cited answer from the engine's model (*corpus_id*) |
| `list_documents` | `documents list` | admin, tenant, corpus | read | Documents, with record ids and metadata; `search` by file name or record id; paged (*corpus_id*) |
| `get_document` | `documents get` | admin, tenant, corpus | read | One document, its versions and its indexed chunks, paged (*corpus_id*) |
| `list_document_versions` | `documents versions` | admin, tenant, corpus | read | Versions of one document (*corpus_id*) |
| `preview_delete_document` | `documents delete-preview` | admin, tenant, corpus | read | Dry run: what deleting a document removes (versions, chunks) and the `confirm_name` to use (*corpus_id*) |
| `delete_document` | `documents delete` | admin, tenant, corpus | destructive | Delete a document, its versions and vectors; needs `confirm_name`, its exact file name or record id (*corpus_id*) |
| `add_records` | `ingest records` | admin, tenant, corpus | write | Add or update up to 1000 text records (*corpus_id*) |
| `upload_file` | `ingest upload` | admin, tenant, corpus | write | Upload a local file; MCP: stdio only, inside `COB_RAG_UPLOAD_DIR` (*corpus_id*) |
| `get_ingest_job` | `ingest job` | admin, tenant, corpus | read | One ingest job: status, corpus, file, mode, and the documents a held upload resembles |
| `list_ingest_jobs` | `ingest jobs` | admin, tenant, corpus | read | Ingest jobs in scope; filter by `status` and `corpus_id`; paged |
| `get_usage` | `usage` | admin, tenant, corpus | read | Requests, tokens and estimated cost, by day, corpus, tenant or source (`api`, `stream`, `conversation`, `widget:<id>`) |
| `list_leads` | `leads list` | admin, tenant | write | Contact details website visitors shared with consent, newest first (*status*, *q* exact phone or e-mail, dates). A read key does not see it |
| `export_leads` | `leads export` | admin, tenant | write | The matching leads as CSV (owners only; every export is audited). Contains personal data |
| `list_feedback` | `feedback list` | admin, tenant, corpus | read | Ratings of answers with their questions; filter by corpus, rating, time; paged |
| `get_corpus_settings` | `settings get` | admin, tenant, corpus | read | A corpus's model, prompt and retrieval settings (*corpus_id*) |
| `update_corpus_settings` | `settings update` | admin, tenant, corpus | write | Change prompt and retrieval settings; null clears one (*corpus_id*) |
| `get_assistant` | `assistant get` | admin, tenant, corpus | read | The knowledge base's assistant: on or off, the published configuration and the current draft (*corpus_id*) |
| `update_assistant_draft` | `assistant draft` | admin, tenant, corpus | write | Change the assistant's draft with a JSON merge patch; nothing goes live until it is published (*corpus_id*) |
| `publish_assistant` | `assistant publish` | admin, tenant, corpus | write | Make the draft live on every channel; earlier versions stay restorable (*corpus_id*) |
| `list_corpora` | `corpora list` | admin, tenant | read | Knowledge bases in scope with owner, document and chunk counts, last activity; `tenant_id` filter; paged, or `all` |
| `get_corpus` | `corpora get` | admin, tenant | read | One corpus with its settings |
| `create_corpus` | `corpora create` | admin, tenant | write | New corpus, optionally with its embedding model; the admin key must give `tenant_id` (every corpus belongs to a tenant); returns its `ck_` key once |
| `update_corpus` | `corpora update` | admin, tenant | write | Name, model, prompt, retrieval, embedding settings; admin: move to another tenant (a corpus always has one); null clears one |
| `rotate_corpus_key` | `corpora rotate-key` | admin, tenant | destructive | New `ck_` key; the old one stops working |
| `preview_delete_corpus` | `corpora delete-preview` | admin, tenant | read | Dry run: documents, chunks, widget keys, conversations and memories a delete removes, and the `confirm_name` to use |
| `delete_corpus` | `corpora delete` | admin, tenant | destructive | Delete a corpus and everything in it; needs `confirm_name`, its exact name |
| `list_migrations` | `migrations list` | admin, tenant | read | Embedding migrations across corpora (`pending_approval` ones included); paged |
| `list_widget_keys` | `widget-keys list` | admin, tenant, corpus | read | Website widget keys (`pk_`) (*corpus_id*) |
| `create_widget_key` | `widget-keys create` | admin, tenant, corpus | write | New widget key and embed snippet (*corpus_id*) |
| `revoke_widget_key` | `widget-keys revoke` | admin, tenant, corpus | destructive | Delete a widget key (*corpus_id*) |
| `get_my_tenant` | `tenants me` | tenant | read | This tenant key's own tenant: name, status, corpus count and limit |
| `rotate_my_tenant_key` | `tenants rotate-my-key` | tenant | destructive | New `tk_` key for the key making the call; it stops working at once |
| `list_tenants` | `tenants list` | admin | read | Tenants with status (pending sign-ups, active, suspended) and owners; *status*, *search*, paged |
| `create_tenant` | `tenants create` | admin | write | New active tenant, optionally on a plan (`plan_id`) with its own knowledge-base limit (`max_corpora`); returns its `tk_` key once |
| `rotate_tenant_key` | `tenants rotate-key` | admin | destructive | New `tk_` key; the old one stops working |
| `activate_tenant` | `tenants activate` | admin | write | Activate a pending sign-up (optional *plan_id*, default the plan it has, and *note*) |
| `suspend_tenant` | `tenants suspend` | admin | destructive | Every key, widget and sign-in of the tenant stops (data kept); needs `confirm_name`, the tenant's exact name |
| `reactivate_tenant` | `tenants reactivate` | admin | write | Undo a suspension |
| `decline_tenant` | `tenants decline` | admin | destructive | Remove a pending sign-up and its account; the owner gets a polite e-mail |
| `preview_delete_tenant` | `tenants delete-preview` | admin | read | Dry run: what deleting a tenant removes (knowledge bases and their contents, members, keys) and the `confirm_name` to use |
| `delete_tenant` | `tenants delete` | admin | destructive | Delete a tenant and everything it owns; needs `confirm_name` |
| `list_team` | `team list` | admin, tenant | read | A tenant's owners and members (last sign-in) and open invitations; a tenant key its own, the admin key names `tenant_id` |
| `invite_member` | `team invite` | tenant | write | Invite someone as owner or member; the engine e-mails the link (never returned) |
| `admin_invite` | `team admin-invite` | admin | write | Invite someone to any tenant (typically its first owner); returns `accept_url`, the link to send them |
| `get_my_plan` | `plans usage` | admin, tenant | read | A tenant's plan, limits and usage: questions this month (and when they reset), knowledge bases, documents, widget keys |
| `list_plans` | `plans list` | admin | read | Plans with their four limits and how many tenants use each |
| `set_tenant_plan` | `plans set` | admin | write | Move a tenant to another active plan |
| `get_settings` | `engine settings` | admin | read | Sign-up mode (open, approval, closed) and white-label branding, with who changed them last |
| `update_settings` | `engine update-settings` | admin | write | Change the sign-up mode and/or branding; null resets a field ("Powered by cob-rag-engine" is not a setting) |

Over MCP by default a corpus key gets 20 tools (22 with destructive tools allowed, 21 with an
upload directory on stdio), a tenant key 32 (37 with destructive tools) and the admin key 40 (48);
`--read-only` leaves only the read tools (15, 23 and 26). A key with `read` permission gets only
the read tools and a `write` key no destructive ones, whatever the flags (see
[Key permissions](#key-permissions)). A `corpus_id` that only filters a list
(`list_ingest_jobs`, `list_feedback`, `list_migrations`) is optional and never takes the
`COB_RAG_CORPUS_ID` default. Tool annotations are set to match: `readOnlyHint` on reads,
`destructiveHint` on destructive tools, `openWorldHint: false` everywhere (every call goes to your
own engine).

**Prompt:** `answer-with-citations` tells the agent to search first, answer only from the passages,
and cite each source.

Every request and response shape is typed from the engine's OpenAPI spec (`src/generated/`,
regenerated with `pnpm gen:api`), so the tools cannot drift from the API.

## Key permissions

A `tk_` or `ck_` key has a permission, set when it is created in the engine's dashboard (or API):

| Permission | What the key may do |
|---|---|
| `read` | Search, ask, list and get. The default for a key made by "Connect an agent". |
| `write` | Everything `read` does, plus add and change content and non-destructive settings. |
| `full` | Everything `write` does, plus delete, rotate and revoke keys. Keys made before permissions existed are `full`. |

The server asks the engine for the key's permission when it starts (`whoami` shows it) and offers
only the tools that permission allows, so a `read` agent sees `search`, `ask`, the list and get
tools and the `preview_delete_*` tools, and nothing that writes. If a call is refused anyway (for
example a `write` key calling a tool that manages keys), the tool says so plainly:

```
FORBIDDEN: This API key only has read permission; this action needs write. Use a key with more
permission: ...
```

**Deleting needs the item's name.** `delete_corpus`, `delete_document` and `delete_tenant` take a
required `confirm_name`: the exact name of what is being deleted (a knowledge base's name, a
document's file name or record id, a customer's name). Run the matching `preview_delete_*` tool
first: it changes nothing, lists what would be removed (documents, chunks, widget keys,
conversations...) and gives the name to confirm with. The engine refuses a delete with a key and
no or a wrong name (`confirmation_required`, `confirm_mismatch`) and deletes nothing.

## Security

- **Keys stay on your machine.** They go to your engine and nowhere else. The config file is
  owner-only; `config show`, `login` and every log line mask keys (`ck_****a1b2`).
- **The key decides the reach.** The engine enforces scope and the key's permission on every
  request; this package also hides the tools a key cannot use, so an agent is not tempted to try.
  Give each agent its own named key with the lowest permission it needs.
- **Destructive tools are off by default over MCP.** Deleting documents or corpora, revoking
  widget keys, rotating keys and suspending, declining or deleting tenants appear only with
  `COB_RAG_ALLOW_DESTRUCTIVE=true` or `--allow-destructive`. The CLI asks before each one, and
  refuses outright when it cannot ask (no terminal) unless you pass `--yes`.
- **Read-only mode** (`--read-only` / `COB_RAG_READ_ONLY=true`) hides every write tool from MCP
  clients and makes the CLI refuse every write.
- **Uploads over MCP are fenced.** `upload_file` exists over MCP only on stdio and only when
  `COB_RAG_UPLOAD_DIR` is set; paths are resolved (symlinks included) and anything outside that
  directory is refused, so a prompt-injected agent cannot ship your SSH keys into a knowledge base.
- **HTTP mode never lends a key.** Each request brings its own; see
  [n8n and HTTP](#n8n-remote-agents-and-anything-that-speaks-http).
- **Keys that are shown once** (`create_corpus`, `create_tenant`, `rotate_*`) come back in the tool
  result, because that is the only time the engine reveals them. Store them when you see them.
- **`rotate_my_tenant_key` cuts off the key in use.** Over MCP it appears only with destructive
  tools allowed, and the server's own key is dead the moment it succeeds; restart it with the new
  key. The CLI warns first and offers to save the new key.

Report vulnerabilities privately: see [SECURITY.md](./SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot reach cob-rag-engine at http://127.0.0.1:8000 (ECONNREFUSED)` | The engine is not running, or `COB_RAG_URL` is wrong. Check `curl http://127.0.0.1:8000/api/v1/health`. There is no hosted fallback. |
| `The engine ... rejected the API key` | Wrong or rotated key. `cob-rag-engine whoami --key ...` to test one. |
| `This workspace is not active (pending or suspended); ask the operator.` | The key is valid, but its tenant is a sign-up still waiting for approval, or suspended. The engine's operator activates or reactivates it. |
| `This workspace has used all the questions its plan allows this month; they reset at ...` | The tenant's plan caps answered questions per month (`ask`; `search` is never capped). Wait for the reset, or the operator moves the tenant to a larger plan (`set_tenant_plan`). Error code `LIMIT`. |
| `The tenant has reached its plan's knowledge-base / document / widget-key limit ...` | Creating one more would pass the plan's limit. Delete one, or the operator moves the tenant to a larger plan. Error code `LIMIT`. |
| `Only a workspace owner can do this ...` | The engine refused a dashboard member's action. Keys are never refused this way (a tenant key acts as an owner); use an owner's key or ask an owner. |
| `Not allowed with this key: ...` | The key kind cannot use that route (for example `corpora` needs a tenant or admin key, `tenants me` a tenant key), or a tenant key named another tenant's corpus. `cob-rag-engine tools` shows who can use what. |
| `corpus_id is required with a tenant key` (or `... with an admin or tenant API key`) | Documents, settings, search, ingest and widget keys act on one corpus: pass `--corpus-id` / `corpus_id`, or set `COB_RAG_CORPUS_ID`. |
| `ask` fails but `search` works | No model is configured for that corpus. Set one in the engine, per corpus (`corpora update --llm-config`), or per request with `COB_RAG_LLM_*`. |
| The MCP client shows the server as failed | Run `npx -y cob-rag-mcp start` in a terminal with the same environment: the reason is printed on stderr. |
| Windows: `npx` not found from Claude Desktop | Use `"command": "cmd", "args": ["/c", "npx", "-y", "cob-rag-mcp", "start"]`, or install globally and use `cob-rag-mcp`. |
| Windows: connection reset with `localhost` | Use `127.0.0.1`: `localhost` can resolve to IPv6 `::1`, which Docker Desktop may not forward. |
| A delete in a script does nothing | Destructive commands refuse without a terminal unless you pass `--yes`. |

## Development

```bash
git clone https://github.com/callobuzz/cob-rag-mcp.git
cd cob-rag-mcp
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# Live tests against your engine (they create and delete a throwaway corpus with an admin or tenant key)
COB_RAG_URL=http://127.0.0.1:8000 COB_RAG_API_KEY=... pnpm test:integration

# Regenerate API types after the engine's API changes
pnpm gen:api ../cob-rag-engine/docs/openapi.json
```

```
src/
├── core/        # engine client, config, tool definition, visibility, upload guard, formatting
├── tools/       # the 52 tools, one definition each (MCP tool + CLI command)
├── server/      # MCP server factory, stdio and streamable HTTP transports
├── cli/         # Commander program: tool commands, login, config, start
└── generated/   # engine-api.ts, from the engine's OpenAPI spec
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Changelog

[CHANGELOG.md](./CHANGELOG.md)

## License

[MIT](./LICENSE), like the client libraries of [cob-rag-engine](https://github.com/callobuzz/cob-rag-engine)
(the engine itself is AGPL-3.0). Built by [Call O Buzz Services](https://callobuzz.com).
