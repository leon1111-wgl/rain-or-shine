import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const startedAt = Date.now();
const env: NodeJS.ProcessEnv = {
  ...process.env, NO_COLOR: "1", CI: "1", RAINPOOL_COVERAGE_STARTED_AT: String(startedAt),
};
delete env.FORCE_COLOR;
const root = process.cwd();
const checks: Array<{ name: string; arguments: string[] }> = [
  { name: "contracts", arguments: ["node_modules/hardhat/dist/src/cli.js", "test", "mocha", "--coverage"] },
  { name: "shared", arguments: ["node_modules/vitest/vitest.mjs", "run", "--root", root, "--config", path.join(root, "vitest.config.ts"), "--configLoader", "runner", "--coverage"] },
  { name: "web", arguments: ["node_modules/vitest/vitest.mjs", "run", "--root", root, "--config", path.join(root, "web/vite.config.ts"), "--configLoader", "runner", "--coverage"] },
  { name: "report", arguments: ["node_modules/tsx/dist/cli.mjs", "scripts/coverage-report.ts"] },
  // Coverage writes instrumented artifacts. Restore the production profile even
  // when a threshold fails, so later ABI/size checks inspect deployable bytecode.
  { name: "restore-production-artifacts", arguments: ["node_modules/hardhat/dist/src/cli.js", "build", "--build-profile", "production"] },
];
const results = [];
for (const check of checks) {
  console.log(`\nCoverage: ${check.name}`);
  const result = spawnSync(process.execPath, [path.resolve(check.arguments[0]!), ...check.arguments.slice(1)], {
    cwd: root, env, stdio: "inherit",
  });
  const exitCode = result.status ?? 1;
  if (result.error) console.error(result.error.message);
  results.push({ name: check.name, exitCode, signal: result.signal });
  // Run the remaining suites and report even if a gate/test fails. The final
  // exit stays nonzero. A fresh-file check rejects stale reports from old runs.
}
await mkdir("evidence/coverage", { recursive: true });
await writeFile("evidence/coverage/execution.json", JSON.stringify({
  startedAt: new Date(startedAt).toISOString(), product: "rainpool-numeric", environment: "LOCAL_MOCK", results,
}, null, 2) + "\n");
process.exitCode = results.every((result) => result.exitCode === 0) ? 0 : 1;
