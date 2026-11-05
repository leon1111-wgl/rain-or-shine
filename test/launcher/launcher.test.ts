import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const launcher = fileURLToPath(new URL("../../launcher/serve.mjs", import.meta.url));
let folder: string;
let port: number;
let child: ChildProcess;
const releaseId = "launcher-test-" + process.pid;
function start() {
  return spawn(process.execPath, [launcher, "--root", join(folder, "www"), "--port", String(port), "--no-open", "--release-id", releaseId, "--report", join(folder, "launch.log")], {
    env: { ...process.env, RAIN_OR_SHINE_NO_BROWSER: "1", RAIN_OR_SHINE_NO_SHORTCUT: "1" }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function ready(process: ChildProcess) {
  return new Promise<string>((ok, fail) => {
    let output = "";
    const timer = setTimeout(() => { process.kill(); fail(new Error("Launcher timeout: " + output)); }, 10000);
    const accept = (bytes: Buffer) => {
      output += bytes.toString();
      if (/running at http:/.test(output)) { clearTimeout(timer); ok(output); }
    };
    process.stdout?.on("data", accept);
    process.stderr?.on("data", accept);
    process.once("error", error => { clearTimeout(timer); fail(error); });
    process.once("exit", code => { clearTimeout(timer); if (!/running at http:/.test(output)) fail(new Error(`Launcher exited ${code}: ${output}`)); });
  });
}
async function request(path: string, method = "GET", host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { Host: host, Accept: "text/html" } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.once("end", () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.once("error", fail);
    req.end();
  });
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "rain-or-shine-launcher-中文 "));
  await mkdir(join(folder, "www/assets"), { recursive: true });
  await writeFile(join(folder, "www/index.html"), "<!doctype html><title>launcher-release-test</title>");
  await writeFile(join(folder, "www/assets/app.js"), "console.log('launcher-assets');");
  await writeFile(join(folder, "www/config.public.json"), JSON.stringify({ rpcOrigins: ["https://ethereum-sepolia-rpc.publicnode.com"] }));
  await writeFile(join(folder, "outside-private.txt"), "must not be served");
  await symlink(join(folder, "outside-private.txt"), join(folder, "www/assets/linked.txt"));
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  port = address.port;
  await new Promise<void>((ok, fail) => probe.close(error => error ? fail(error) : ok()));
  child = start();
  await ready(child);
}, 15000);
afterAll(async () => {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  if (folder) {
    const target = resolve(folder);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith("rain-or-shine-launcher-")) throw new Error("Refusing unexpected cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

describe("desktop launcher", () => {
  it("serves the compiled entry and assets with the release RPC permitted by CSP", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("launcher-release-test");
    expect(page.headers["content-security-policy"]).toContain("connect-src 'self' https://ethereum-sepolia-rpc.publicnode.com");
    expect((await request("/assets/app.js")).body).toContain("launcher-assets");
    expect((await request("/assets/app.js", "HEAD")).body).toBe("");
  });
  it("does not serve private paths or escape the public www directory", async () => {
    expect((await request("/%2e%2e/outside-private.txt")).status).toBe(403);
    expect((await request("/.env")).status).toBe(403);
    expect((await request("/node_modules/ethers/package.json")).status).toBe(403);
    expect((await request("/app/runtime/node.exe")).status).toBe(404);
    const linked = await request("/assets/linked.txt");
    expect([linked.status, linked.body]).toEqual([403, "symlink outside www"]);
  });
  it("rejects writes, untrusted Host headers and non-allowlisted HKO reads", async () => {
    expect((await request("/", "POST")).status).toBe(405);
    expect((await request("/", "GET", "untrusted.example")).status).toBe(403);
    expect((await request("/hko-open-data/private")).status).toBe(404);
  });
  it("returns package identity and supports a refreshed frontend route", async () => {
    const health = await request("/_health");
    expect(JSON.parse(health.body)).toEqual({ appId: "rain-or-shine-local", releaseId });
    expect((await request("/markets/1")).body).toContain("launcher-release-test");
  });
  it("reuses a second launch of the same release", async () => {
    const second = start();
    const exited = once(second, "exit");
    const output = await ready(second);
    expect(output).toContain("is already running at http:");
    expect((await exited)[0]).toBe(0);
    expect((await request("/")).status).toBe(200);
  });
});
