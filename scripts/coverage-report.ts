import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const CONTRACTS = ["PredictionMarket", "UmaMetricOracleAdapter", "MetricRegistry", "ConditionLib", "MetricReadingLib"];
const failures: string[] = [];
const runStartedAt = Number(process.env.RAINPOOL_COVERAGE_STARTED_AT ?? 0);
function currentFile(file: string): boolean {
  if (!existsSync(file)) { failures.push(`${file} missing`); return false; }
  if (runStartedAt && statSync(file).mtimeMs < runStartedAt) {
    failures.push(`${file} was not generated during this coverage run`);
    return false;
  }
  return true;
}

const contractLines: Record<string, { hit: number; found: number; pct: number }> = {};
if (currentFile("coverage/lcov.info")) {
  for (const block of readFileSync("coverage/lcov.info", "utf8").split("end_of_record")) {
    const file = /SF:(.*)/.exec(block)?.[1]?.trim().replaceAll("\\", "/");
    const name = CONTRACTS.find((contract) => file?.endsWith(`contracts/${contract}.sol`));
    if (!name) continue;
    const found = Number(/^LF:(\d+)/m.exec(block)?.[1] ?? 0);
    const hit = Number(/^LH:(\d+)/m.exec(block)?.[1] ?? 0);
    const pct = found ? 100 * hit / found : 0;
    contractLines[name] = { hit, found, pct };
    if (!found) failures.push(`contract ${name} has no instrumented lines`);
    else if (pct < 90) failures.push(`contract ${name} line coverage ${pct.toFixed(2)}% < 90%`);
  }
}
for (const contract of CONTRACTS) if (!contractLines[contract]) failures.push(`no coverage data for ${contract}`);

interface CoverageTotals {
  lines: number;
  branches: number;
  statements: number;
  functions: number;
}
function vitestSummary(file: string): CoverageTotals | null {
  if (!currentFile(file)) return null;
  const total = (JSON.parse(readFileSync(file, "utf8")) as { total?: Record<string, { pct?: number }> }).total;
  const fields = ["lines", "branches", "statements", "functions"] as const;
  if (!total || fields.some((field) => typeof total[field]?.pct !== "number" || !Number.isFinite(total[field]!.pct))) {
    failures.push(`${file} has invalid coverage totals`);
    return null;
  }
  return Object.fromEntries(fields.map((field) => [field, total[field]!.pct])) as unknown as CoverageTotals;
}
const shared = vitestSummary("coverage/shared/coverage-summary.json");
const web = vitestSummary("coverage/web/coverage-summary.json");
if (shared && (shared.lines < 90 || shared.branches < 85)) {
  failures.push(`src/metric + src/weather coverage below target (lines 90, branches 85): ${JSON.stringify(shared)}`);
}
// Declaring or mentioning an error name is not proof of covering its runtime guard.
const declaredCustomErrors = CONTRACTS.flatMap((contract) => [...readFileSync(`contracts/${contract}.sol`, "utf8")
  .matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((match) => `${contract}.${match[1]}`));
const summary = {
  ranAt: new Date().toISOString(), product: "rainpool-numeric", environment: "LOCAL_MOCK",
  gates: { contractLines: 90, sharedLines: 90, sharedBranches: 85 },
  contracts: {
    lines: contractLines,
    branches: "NOT_MEASURED: Hardhat built-in coverage reports lines/statements, not complete branch coverage",
    declaredCustomErrors,
    customErrorBranchCoverage: "NOT_MEASURED: source-name matching is not an instrumentation measurement",
  },
  sharedNumericAndWeather: shared,
  web: { totals: web, scope: "Component/unit tests only; no real wallet browser E2E coverage is claimed" },
  scripts: "Not instrumented; script execution and architecture checks are reported separately",
  failures,
};
await mkdir("evidence/coverage", { recursive: true });
await writeFile("evidence/coverage/summary.json", JSON.stringify(summary, null, 2) + "\n");
for (const [contract, data] of Object.entries(contractLines)) console.log(`contract ${contract}: ${data.pct.toFixed(2)}% (${data.hit}/${data.found} lines)`);
console.log(`src/metric + src/weather: ${JSON.stringify(shared)}`);
console.log(`web components: ${JSON.stringify(web)}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exitCode = failures.length ? 1 : 0;
