# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please use [GitHub Private Vulnerability Reporting](https://github.com/callobuzz/cob-rag-mcp/security/advisories/new),
or email callobuzz@gmail.com.

You should receive an initial response within 48 hours. We will work with you to understand the
issue and coordinate a fix before any public disclosure.

Vulnerabilities in the engine itself belong to
[cob-rag-engine](https://github.com/callobuzz/cob-rag-engine/security).

## Scope

- The `cob-rag-mcp` npm package: the MCP server (stdio and HTTP) and the `cob-rag-engine` CLI
- Key handling: the config file, masking, forwarding in HTTP mode
- Tool visibility and gating: key-kind filtering, destructive and read-only modes
- The upload directory guard
- Dependency vulnerabilities

## Best Practices for Users

- Give an agent the **narrowest key** that does the job: a corpus key (`ck_`) for one knowledge
  base, a tenant key only when it must manage corpora, the admin key almost never.
- Keep destructive tools off (the default) unless a person reviews each call.
- Use `--read-only` for agents that should only look things up.
- Set `COB_RAG_UPLOAD_DIR` to a dedicated folder, never your home directory.
- In HTTP mode, keep the default `127.0.0.1` bind, or put TLS and a firewall in front of it. Leave
  `COB_RAG_HTTP_USE_SERVER_KEY` off unless every client that can reach the port should act with
  that key.
- Never commit keys. Prefer `cob-rag-engine login` (prompts without echo) or your MCP client's
  secret inputs over pasting keys into files.
