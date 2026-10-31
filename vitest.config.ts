import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "cache/vitest",
  test: {
    include: ["test/metric/**/*.test.ts", "test/weather/**/*.test.ts", "test/launcher/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/weather/**/*.ts", "src/metric/**/*.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage/shared",
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
