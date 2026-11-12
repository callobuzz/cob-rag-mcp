// No unit test may read the developer's real settings: clear every COB_RAG_* variable and point
// the config file somewhere that does not exist.

import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
	if (key.startsWith("COB_RAG_")) delete process.env[key];
}
process.env.COB_RAG_CONFIG = join(tmpdir(), "cob-rag-mcp-tests-nonexistent", "config.json");
