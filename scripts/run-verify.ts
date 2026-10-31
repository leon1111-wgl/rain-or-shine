import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CORE = ["lint", "typecheck", "test:contracts", "test:shared", "test:web", "check:architecture", "build"];
const ALLOWED = new Set([...CORE, "compile", "test:weather", "test:metric:data", "test:launcher", "test:coverage", "test:fork"]);
const args = process.argv.slice(2);
const only: string[] = [];
let coverage = false;
let fork = false;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--coverage") coverage = true;
  else if (argument === "--fork") fork = true;
  else if (argument === "--only") {
    const step = args[++index];
    if (!step || !ALLOWED.has(step)) throw new Error("--only requires a supported verification script");
    only.push(step);
  } else throw new Error(`unsupported option ${argument}; use --coverage, --fork or --only <verification script>`);
}
if (only.length && (coverage || fork)) throw new Error("Use --coverage/--fork for the full run, or --only <script>");
const steps = [...new Set(only.length ? only : [...CORE, ...(coverage ? ["test:coverage"] : []), ...(fork ? ["test:fork"] : [])])];
const known = Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts);
for (const step of steps) if (!known.includes(step)) throw new Error(`missing npm script ${step}`);

// Running npm's JS CLI avoids Windows .cmd shell quoting and spawn EINVAL.
// npm run verify supplies this path without relying on PATH or a shell.
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error("Run this verifier via npm run verify or npm run verify:full");
const git = (...arguments_: string[]) => execFileSync("git", arguments_, {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
}).trimEnd();
let inGit = false;
try { inGit = path.resolve(git("rev-parse", "--show-toplevel")) === process.cwd(); }
catch { /* Isolated validation copies may not have their own Git checkout. */ }
const commit = inGit ? git("rev-parse", "HEAD") : "none (not a git checkout root)";
const changed = inGit
  ? git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)
    .map((line) => line.slice(3)).filter((file) => !file.startsWith("evidence/"))
  : [];
const environment = {
  commit,
  tree: !inGit ? "unknown (isolated copy)" : changed.length ? `dirty (${changed.length} files outside evidence/)` : "clean",
  changedFiles: changed,
  node: process.version,
  os: `${process.platform} ${process.arch} (${os.type()} ${os.release()})`,
};
interface StepResult {
  step: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  durationMs: number;
  log: string;
}
function run(step: string): Promise<StepResult> {
  const log = `evidence/verify/${step.replaceAll(":", "-")}.log`;
  const output = createWriteStream(log);
  const startedAt = new Date();
  output.write([
    `# step: ${step}`, `# command: npm run ${step}`, `# commit: ${environment.commit}`,
    `# tree: ${environment.tree}`, `# node: ${environment.node}  os: ${environment.os}`,
    `# startedAt: ${startedAt.toISOString()}`, "",
  ].join("\n"));
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CI: "1" };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [npmCli!, "run", step], { env, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt.getTime();
      output.end(`\n# exit: ${exitCode}  durationMs: ${durationMs}\n`, () => {
        resolve({ step, status: exitCode === 0 ? "PASS" : "FAIL", exitCode, durationMs, log });
      });
    };
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
      output.write(chunk);
      process.stdout.write(chunk);
    });
    child.on("error", (error) => { output.write(String(error) + "\n"); finish(1); });
    child.on("close", (code) => finish(code ?? 1));
  });
}

await mkdir("evidence/verify", { recursive: true });
const results: StepResult[] = [];
for (const step of steps) {
  console.log(`\nRunning ${step}`);
  const result = await run(step);
  results.push(result);
  console.log(`${result.status}: ${step} (exit ${result.exitCode}) -> ${result.log}`);
}
// Never merge historical passing steps into a new partial run.
await writeFile("evidence/verify/summary.json", JSON.stringify({
  kind: "VERIFY_RUN", product: "rainpool-numeric", environment: steps.includes("test:fork") ? "LOCAL_MOCK_AND_SEPOLIA_FORK" : "LOCAL_MOCK",
  updatedAt: new Date().toISOString(), checkout: environment,
  scope: only.length ? "selected checks only" : coverage ? "core checks plus coverage gates" : "core checks; coverage gates not run",
  oracleScope: steps.includes("test:fork")
    ? "Local Mock plus canonical UMA bytecode on a local Sepolia fork. No public transactions, DVM voting or browser wallet E2E."
    : "Local Mock optimistic oracle only. No Sepolia fork, public transactions, DVM voting or browser wallet E2E.",
  results,
}, null, 2) + "\n");
process.exitCode = results.every((result) => result.status === "PASS") ? 0 : 1;
