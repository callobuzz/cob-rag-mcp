import { defineConfig } from "vitest/config";

// Live tests against a running cob-rag-engine. They skip themselves unless
// COB_RAG_URL and COB_RAG_API_KEY are set (an admin or tenant key: they create and delete a
// throwaway corpus).
export default defineConfig({
	test: {
		include: ["src/**/*.integration.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
