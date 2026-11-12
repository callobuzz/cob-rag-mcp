# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/callobuzz/cob-rag-mcp](https://github.com/callobuzz/cob-rag-mcp).

## Setup

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Node 22+ and pnpm 10. `pnpm lint:fix` applies Biome's formatting and import order.

## Ground rules

- **The engine's OpenAPI spec is the source of truth.** Never add a route or field that is not in
  it. When the engine's API changes, run `pnpm gen:api <path or URL to openapi.json>`, commit the
  regenerated `src/generated/engine-api.ts`, and let the typecheck show what to update.
- **One definition per tool.** A tool lives in `src/tools/` as a single `defineTool(...)`; the MCP
  server and the CLI both come from it. Set `kinds` (which key kinds may use it) and `access`
  (`read`, `write` or `destructive`) carefully: they decide what clients see and what asks first.
- **Every tool has a unit test** in `src/tools/tools.test.ts` checking the method, path, query and
  body it sends, against the fake engine in `src/test/fake-engine.ts`.
- **Keys never reach output or logs unmasked.**
- Live tests (`pnpm test:integration`) need your own engine: `COB_RAG_URL` and an admin or tenant
  `COB_RAG_API_KEY`. They create and delete a throwaway corpus.

## Commits and pull requests

Small, focused commits with plain messages saying what changed and why. Add a line to
`CHANGELOG.md` under `[Unreleased]` for anything a user would notice.

By contributing you agree your work is licensed under the MIT licence, the licence of this project.
