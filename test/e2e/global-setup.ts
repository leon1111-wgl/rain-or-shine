// Starts a fresh Hardhat node, deploys with scripts/deploy-metric-local.ts (which also exports the ABIs and the
// manifest), then starts Vite against the local chain.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NODE = process.execPath;
export const PID_FILE = path.join(ROOT, "test-results", "e2e-pids.json");
const RPC = "http://127.0.0.1:8545";
const PORT = 5182;

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return res.ok;
  } catch {
    return false; // nothing listening yet
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 300_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function run(args: string[], label: string): void {
  const result = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
}

export default async function globalSetup(): Promise<void> {
  if (await rpcUp()) throw new Error("Port 8545 is busy. Stop `npm run node:local` first: E2E needs a fresh chain it owns.");
  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  const hardhatCli = path.join(ROOT, "node_modules/hardhat/dist/src/cli.js");
  const nodeLog = openSync(path.join(ROOT, "test-results", "e2e-hardhat-node.log"), "w");
  const hardhat = spawn(NODE, [hardhatCli, "node"], { cwd: ROOT, stdio: ["ignore", nodeLog, nodeLog], detached: true });
  await waitFor(rpcUp, "the Hardhat node");
  run([hardhatCli, "run", "--network", "localhost", "scripts/deploy-metric-local.ts"], "deploy");
  run([path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "scripts/export-metric-deployment.ts"], "export");
  const viteLog = openSync(path.join(ROOT, "test-results", "e2e-vite.log"), "w");
  const vite = spawn(NODE, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "web", "--mode", "local-chain", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", viteLog, viteLog],
    detached: true,
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
    } catch {
      return false; // Vite still starting
    }
  }, "the Vite dev server");
  writeFileSync(PID_FILE, JSON.stringify({ hardhat: hardhat.pid, vite: vite.pid }));
}
