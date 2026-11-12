import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["**/*.integration.test.ts", "node_modules", "dist"],
		// No test may read the developer's real config file or environment.
		setupFiles: ["./src/test/setup.ts"],
	},
});
