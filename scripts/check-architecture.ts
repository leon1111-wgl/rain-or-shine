import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const PROD_DIRS = ["src", "scripts", "web/src", "launcher"];
const GENERATED_DIRS = new Set([
  "generated", "node_modules", ".git", "artifacts", "cache", "types",
  "coverage", "dist", "release", "evidence", "test-results", "playwright-report",
]);
const failures: string[] = [];
const review: string[] = [];

function walk(dir: string, filter: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return GENERATED_DIRS.has(name) ? [] : walk(full, filter);
    return filter(full) ? [full] : [];
  });
}

const tsFiles = PROD_DIRS.flatMap((d) => walk(d, (f) => /\.(ts|tsx|mjs)$/.test(f)));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const solFiles = walk("contracts", (f) => f.endsWith(".sol"));

const importRe = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const graph = new Map<string, string[]>();
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@shared/")) base = path.join(ROOT, "src", spec.slice("@shared/".length));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  base = base.replace(/\.(js|ts|tsx|mjs|mts)$/, "");
  for (const ext of [".ts", ".tsx", ".mjs", ".mts", "/index.ts"]) if (existsSync(base + ext)) return rel(base + ext);
  return null;
}
for (const file of tsFiles) {
  const text = readFileSync(file, "utf8");
  const deps: string[] = [];
  for (const m of text.matchAll(importRe)) {
    const spec = m[1] ?? m[2]!;
    const target = resolveImport(file, spec);
    if (target) deps.push(target);
    const f = rel(file);
    if (f.startsWith("src/") && (spec.includes("/web/") || spec.includes("/scripts/") || spec.startsWith("react"))) {
      failures.push(`layer: shared core ${f} imports ${spec}`);
    }
    if (f.startsWith("web/src/") && (spec.startsWith("node:") || spec.includes("/scripts/") || spec.includes("/test/"))) {
      failures.push(`layer: web code ${f} imports ${spec}`);
    }
    if (spec.includes("referenceModel") && !f.startsWith("test/")) failures.push(`layer: ${f} imports the test-only reference model`);
  }
  graph.set(rel(file), deps);
}
const state = new Map<string, "visiting" | "done">();
function visit(node: string, stack: string[]): void {
  if (state.get(node) === "done") return;
  if (state.get(node) === "visiting") {
    failures.push(`cycle: ${[...stack.slice(stack.indexOf(node)), node].join(" -> ")}`);
    return;
  }
  state.set(node, "visiting");
  for (const dep of graph.get(node) ?? []) visit(dep, [...stack, node]);
  state.set(node, "done");
}
for (const node of graph.keys()) visit(node, []);

const RPC_BOUNDARIES = new Set(["web/src/metric/client.ts", "web/src/hooks/useWallet.tsx"]);
for (const file of tsFiles.filter((f) => rel(f).startsWith("web/src/") && !RPC_BOUNDARIES.has(rel(f)))) {
  const text = readFileSync(file, "utf8");
  if (/new\s+(Contract|JsonRpcProvider|BrowserProvider)\s*\(/.test(text)) failures.push(`layer: ${rel(file)} constructs a Contract/provider outside the numeric client or wallet boundary`);
}
for (const file of solFiles.filter((f) => !rel(f).startsWith("contracts/test/") && !rel(f).startsWith("contracts/interfaces/"))) {
  const text = readFileSync(file, "utf8");
  if (text.includes("IOptimisticOracleV3") && rel(file) !== "contracts/UmaMetricOracleAdapter.sol") {
    failures.push(`layer: ${rel(file)} references OOV3; only UmaMetricOracleAdapter may integrate it`);
  }
  if (/\b(delegatecall|selfdestruct)\b/.test(text.replace(/\/\/.*$/gm, ""))) failures.push(`safety: ${rel(file)} uses delegatecall/selfdestruct in production code`);
}
for (const file of tsFiles.filter((f) => rel(f).startsWith("web/src/"))) {
  const text = readFileSync(file, "utf8");
  if (/@shared\/pool\/payout|src\/pool\/payout/.test(text)) failures.push(`layer: ${rel(file)} imports the payout mirror; the UI must read amounts from the contract`);
  if (/handoff\/|RainFixtures|示例甲|示例乙/.test(text)) failures.push(`layer: ${rel(file)} references retired design fixtures`);
}

const BUILD_OUTPUT = /^(node_modules|web\/node_modules|artifacts|cache|types|coverage|test-results|playwright-report|web\/dist|release)\//;
function projectFiles(): string[] {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.resolve(top) !== ROOT) throw new Error("isolated copy is not a checkout root");
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return walk(".", () => true)
      .map(rel)
      .filter((f) => !BUILD_OUTPUT.test(f));
  }
}
const trackedFiles = projectFiles();
for (const file of [...tsFiles, ...solFiles]) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/eslint-disable/.test(line) && !/--\s*\S/.test(line)) failures.push(`hygiene: ${rel(file)}:${i + 1} eslint-disable without a reason`);
    if (/@ts-(ignore|nocheck|expect-error)/.test(line)) failures.push(`hygiene: ${rel(file)}:${i + 1} TypeScript suppression`);
    const isThisChecker = rel(file) === "scripts/check-architecture.ts";
    if (!isThisChecker && /\b(TODO|FIXME|XXX)\b/.test(line)) failures.push(`hygiene: ${rel(file)}:${i + 1} unresolved marker`);
  });
}
for (const file of trackedFiles) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) failures.push(`secrets: ${file} must not be committed`);
}
const KEY_ASSIGNMENT = /(PRIVATE_KEY|MNEMONIC|SECRET|DEPLOYER_KEY|EXECUTOR_KEY)\s*[:=]\s*["']?(0x)?[0-9a-fA-F]{64}/;
for (const file of trackedFiles.filter((f) => /(\.(ts|tsx|js|json|md|ya?ml|txt)|env\.example)$/.test(f) && existsSync(f))) {
  if (KEY_ASSIGNMENT.test(readFileSync(file, "utf8"))) failures.push(`secrets: ${file} assigns what looks like a private key`);
}
for (const file of tsFiles.filter((f) => rel(f).startsWith("web/src/"))) {
  if (/import\.meta\.env\.VITE_[A-Z_]*(KEY|SECRET|MNEMONIC|PRIVATE)/.test(readFileSync(file, "utf8"))) failures.push(`secrets: ${rel(file)} reads a secret-like VITE_ variable`);
}

const FORBIDDEN = ["web3", "wagmi", "viem", "@rainbow-me/rainbowkit", "redux", "@reduxjs/toolkit", "zustand", "mobx", "recoil", "jotai", "axios", "express", "redis", "mongoose", "pg"];
const manifests = { root: JSON.parse(readFileSync("package.json", "utf8")), web: JSON.parse(readFileSync("web/package.json", "utf8")) } as Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
const allSources = [...tsFiles, ...walk("test", (f) => /\.(ts|tsx)$/.test(f)), "hardhat.config.ts", "web/vite.config.ts", "eslint.config.js", "vitest.config.ts"]
  .filter((f) => existsSync(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
for (const [name, pkg] of Object.entries(manifests)) {
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (FORBIDDEN.includes(dep)) failures.push(`deps: ${name} depends on forbidden ${dep}`);
    if (!allSources.includes(`"${dep}`) && !allSources.includes(`'${dep}`)) review.push(`deps: ${name} production dependency ${dep} is never imported`);
  }
  for (const dep of Object.keys(pkg.devDependencies ?? {})) if (FORBIDDEN.includes(dep)) failures.push(`deps: ${name} devDepends on forbidden ${dep}`);
}

for (const file of tsFiles) {
  const text = readFileSync(file, "utf8");
  const lineCount = text.split("\n").length;
  if (lineCount > 300 && !rel(file).startsWith("web/src/i18n/")) review.push(`size: ${rel(file)} has ${lineCount} lines (review threshold 300)`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const check = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.body.getStart()).line;
      const end = source.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      const name = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name ? node.name.getText(source) : "(anonymous)";
      if (end - start > 60 && name !== "(anonymous)") review.push(`size: ${rel(file)} function ${name} spans ${end - start} lines (review threshold 60)`);
    }
    ts.forEachChild(node, check);
  };
  check(source);
}
for (const file of solFiles.filter((f) => !rel(f).startsWith("contracts/test/"))) {
  const lineCount = readFileSync(file, "utf8").split("\n").length;
  if (lineCount > 450) review.push(`size: ${rel(file)} has ${lineCount} lines (review threshold 450)`);
}

const sizes: Record<string, { runtime: number; initcode: number }> = {};
for (const name of ["PredictionMarket", "UmaMetricOracleAdapter"]) {
  const artifactPath = `artifacts/contracts/${name}.sol/${name}.json`;
  if (!existsSync(artifactPath)) {
    failures.push(`size: ${artifactPath} missing (run npm run compile)`);
    continue;
  }
  const a = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: string; deployedBytecode: string };
  const runtime = (a.deployedBytecode.length - 2) / 2;
  const initcode = (a.bytecode.length - 2) / 2;
  sizes[name] = { runtime, initcode };
  if (runtime > 24_576) failures.push(`size: ${name} runtime ${runtime} B exceeds EIP-170 (24,576 B)`);
  if (initcode > 49_152) failures.push(`size: ${name} initcode ${initcode} B exceeds EIP-3860 (49,152 B)`);
}

const report = {
  ranAt: new Date().toISOString(), product: "rainpool-numeric", environment: "LOCAL_MOCK",
  filesChecked: tsFiles.length + solFiles.length,
  importEdges: [...graph.values()].reduce((count, dependencies) => count + dependencies.length, 0),
  failures, review, contractSizes: sizes,
};
await mkdir("evidence/architecture", { recursive: true });
await writeFile("evidence/architecture/report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`checked ${report.filesChecked} files, ${report.importEdges} import edges`);
for (const [name, s] of Object.entries(sizes)) console.log(`  ${name}: runtime ${s.runtime} B, initcode ${s.initcode} B`);
for (const r of review) console.log(`REVIEW  ${r}`);
for (const f of failures) console.log(`FAIL    ${f}`);
console.log(failures.length === 0 ? "architecture check passed" : `${failures.length} failure(s)`);
process.exitCode = failures.length === 0 ? 0 : 1;
