// Builds the Sepolia desktop packages: macOS for Apple silicon and Intel, and Windows x64.
// Each zip holds the built app, a small local server and an official Node runtime.
//   npm run package:desktop

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SEPOLIA_FALLBACK_RPC } from "../web/src/metric/rpc-reader.js";
import { readMetricManifest } from "./lib/metric-deployment.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run package:desktop");
const NODE_VERSION = "v24.21.0";
const python = process.env.PACKAGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const archiveHelper = resolve(root, "scripts/lib/package-archive.py");
const runtimeCache = resolve(root, "cache/portable-node", NODE_VERSION);

type Target = { os: "macOS" | "Windows"; arch: "arm64" | "x64"; archive: string; prefix: string };
const TARGETS: Target[] = [
  { os: "macOS", arch: "arm64", archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, prefix: `node-${NODE_VERSION}-darwin-arm64` },
  { os: "macOS", arch: "x64", archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`, prefix: `node-${NODE_VERSION}-darwin-x64` },
  { os: "Windows", arch: "x64", archive: `node-${NODE_VERSION}-win-x64.zip`, prefix: `node-${NODE_VERSION}-win-x64` },
];

const dep = await readMetricManifest("sepolia");
const rpcOrigins = [dep.publicRpcUrl, SEPOLIA_FALLBACK_RPC].map((url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Package RPCs must be public HTTPS endpoints without credentials, query or fragment: " + url);
  }
  return parsed.origin;
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const slash = (file: string) => file.split(sep).join("/");

async function run(command: string, args: string[], env = process.env) {
  await new Promise<void>((ok, fail) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} exited with ${code}`))));
  });
}
async function regular(file: string) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Expected a regular file: " + file);
}
async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not packaged: " + file);
    if (entry.isDirectory()) found.push(...(await files(file)));
    else if (entry.isFile()) found.push(file);
    else throw new Error("Unsupported package entry: " + file);
  }
  return found.sort();
}
async function download(name: string, maximum: number) {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: ${response.status} ${url}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("Runtime download exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

await mkdir(runtimeCache, { recursive: true });
const sums = (await download("SHASUMS256.txt", 100_000)).toString("utf8");
const runtimes = new Map<Target, { directory: string; archiveSha256: string; sourceURL: string }>();
for (const target of TARGETS) {
  const checksum = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === target.archive)?.[0];
  if (!checksum || !/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Official runtime checksum missing: " + target.archive);
  const archive = resolve(runtimeCache, target.archive);
  if (existsSync(archive)) await regular(archive);
  const data = existsSync(archive) ? await readFile(archive) : await download(target.archive, 150_000_000);
  if (sha256(data) !== checksum) throw new Error("Official runtime checksum mismatch: " + target.archive);
  if (!existsSync(archive)) await writeFile(archive, data, { flag: "wx" });
  const directory = resolve(runtimeCache, `${target.os}-${target.arch}`);
  if (target.os === "macOS") await run(python, [archiveHelper, "runtime", archive, target.prefix, directory, target.arch]);
  else await run(python, [archiveHelper, "runtime-windows", archive, target.prefix, directory]);
  runtimes.set(target, { directory, archiveSha256: checksum, sourceURL: `https://nodejs.org/dist/${NODE_VERSION}/${target.archive}` });
  console.log(`Verified Node ${NODE_VERSION} for ${target.os} ${target.arch}`);
}

await run(process.execPath, [npmCli, "run", "build:metric:sepolia"], { ...process.env, EXPORT_NETWORKS: "sepolia" });
await run(process.execPath, [npmCli, "run", "build:weather:portable"]);
const exported = JSON.parse(await readFile(resolve(root, "web/src/generated/metric-deployments.json"), "utf8")) as { deployments: Record<string, unknown> };
if (Object.keys(exported.deployments).join(",") !== "11155111") throw new Error("The package must contain only the Sepolia deployment");

// Source maps and region comments name the bundled third-party code.
const dist = resolve(root, "web/dist");
const weatherTools = resolve(root, "cache/portable-weather");
const bundled = new Set<string>();
const packageOf = (path: string) => /node_modules\/((?:(?:@[^/]+\/)?[^/]+\/node_modules\/)*(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
for (const file of (await files(dist)).filter((name) => name.endsWith(".js.map"))) {
  for (const source of (JSON.parse(await readFile(file, "utf8")) as { sources: string[] }).sources) {
    const name = packageOf(source);
    if (name) bundled.add(name);
  }
}
for (const file of await files(weatherTools)) {
  for (const match of (await readFile(file, "utf8")).matchAll(/^\/\/#region (.+)$/gm)) {
    const name = packageOf(match[1]!);
    if (name) bundled.add(name);
  }
}
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; license?: string }> };
const notices: string[] = ["Third-party software in the Rain or Shine desktop package", ""];
const nameOf = (path: string) => path.split("/node_modules/").at(-1)!;
for (const path of [...bundled].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
  const entry = lock.packages[`node_modules/${path}`];
  if (!entry?.version) throw new Error("Bundled package missing from package-lock.json: " + path);
  const folder = resolve(root, "node_modules", path);
  const licenseFile = (await readdir(folder)).find((file) => /^licen[cs]e(\.md|\.txt)?$/i.test(file));
  if (!licenseFile) throw new Error("No license file for bundled package " + path);
  notices.push(`==== ${nameOf(path)}@${entry.version} (${entry.license ?? "see text"}) ====`, (await readFile(resolve(folder, licenseFile), "utf8")).trim(), "");
}
notices.push("The Node.js runtime license is in app/runtime/LICENSE.", "");
const thirdParty = notices.join("\n");

const builtAt = new Date().toISOString();
const stamp = builtAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const releaseId = "rain-or-shine-sepolia-" + stamp;
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
const output = resolve(root, "release", "desktop-" + stamp);
await mkdir(output, { recursive: true });
const template = await readFile(resolve(root, "launcher/templates/READ_FIRST.html"), "utf8");
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const results: { zip: string; sha256: string; files: number }[] = [];

for (const target of TARGETS) {
  const runtime = runtimes.get(target)!;
  const mac = target.os === "macOS";
  const name = `Rain-or-Shine-${target.os}-${target.arch}`;
  const packageRoot = resolve(output, name);
  await mkdir(packageRoot);
  const place = (destination: string) => {
    const file = resolve(packageRoot, destination);
    if (!file.startsWith(packageRoot + sep)) throw new Error("Invalid package destination");
    return file;
  };
  const copy = async (source: string, destination: string) => {
    await regular(source);
    await mkdir(dirname(place(destination)), { recursive: true });
    await copyFile(source, place(destination));
  };
  const write = async (destination: string, text: string) => {
    await mkdir(dirname(place(destination)), { recursive: true });
    await writeFile(place(destination), text);
  };

  for (const file of await files(dist)) {
    const path = slash(relative(dist, file));
    if (path.endsWith(".map")) continue;
    if (![".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf"].includes(extname(path))) {
      throw new Error("Unexpected build output: " + path);
    }
    if (extname(path) === ".js" || extname(path) === ".css") {
      const text = (await readFile(file, "utf8")).replace(/^\/\/# sourceMappingURL=.*$/gm, "").replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, "");
      await write("app/www/" + path, text);
    } else await copy(file, "app/www/" + path);
  }
  if (!existsSync(place("app/www/index.html"))) throw new Error("Built index.html missing");
  await write("app/www/config.public.json", JSON.stringify({
    chainId: dep.chainId, network: dep.network, rpcOrigins, admin: dep.admin,
    contracts: Object.fromEntries(Object.entries(dep.contracts).map(([contract, entry]) => [contract, entry.address])),
  }, null, 2) + "\n");
  await copy(resolve(root, "launcher/serve.mjs"), "app/launcher/serve.mjs");
  await copy(resolve(root, "launcher/hko-relay.mjs"), "app/launcher/hko-relay.mjs");
  for (const file of await files(weatherTools)) {
    if (![".js", ".mjs"].includes(extname(file))) throw new Error("Unexpected weather tool output: " + file);
    await copy(file, "app/tools/" + slash(relative(weatherTools, file)));
  }
  await write("app/licenses/THIRD_PARTY_LICENSES.txt", thirdParty);
  await copy(resolve(root, "deployments/metric.sepolia.json"), "app/deployment.sepolia.json");
  await copy(resolve(runtime.directory, "LICENSE"), "app/runtime/LICENSE");
  if (mac) {
    await copy(resolve(root, "launcher/mac-common.sh"), "app/launcher/mac-common.sh");
    await copy(resolve(runtime.directory, "node"), "app/runtime/node");
    await write("app/runtime/architecture", target.arch + "\n");
    await copy(resolve(root, "launcher/templates/START-MAC.command"), "START-MAC.command");
    await copy(resolve(root, "launcher/templates/GET-WEATHER.command"), "GET-WEATHER.command");
  } else {
    await copy(resolve(runtime.directory, "node.exe"), "app/runtime/node.exe");
    await copy(resolve(root, "launcher/templates/START-WINDOWS.cmd"), "START-WINDOWS.cmd");
    await copy(resolve(root, "launcher/templates/GET-WEATHER.cmd"), "GET-WEATHER.cmd");
  }
  const tokens: Record<string, string> = {
    SYSTEM: mac ? `macOS 13.5+ (${target.arch === "arm64" ? "Apple silicon" : "Intel"})` : "Windows 10/11 (x64)",
    START: mac ? "START-MAC.command" : "START-WINDOWS.cmd",
    WEATHER: mac ? "GET-WEATHER.command" : "GET-WEATHER.cmd",
    RELEASE: releaseId, ADMIN: dep.admin, MARKET: dep.contracts.PredictionMarket.address,
    ADAPTER: dep.contracts.UmaMetricOracleAdapter.address, BOND: dep.oracle.bondCurrency,
  };
  const page = template
    .replace(/<!--@@(MAC|WINDOWS)-->([\s\S]*?)<!--@@END-->/g, (_match: string, os: string, body: string) => ((os === "MAC") === mac ? body : ""))
    .replace(/@@([A-Z]+)@@/g, (_match: string, key: string) => {
      const value = tokens[key];
      if (!value) throw new Error("Unknown READ_FIRST token: " + key);
      return escape(value);
    });
  await write("READ_FIRST.html", page);

  const inventory = await Promise.all((await files(packageRoot)).map(async (file) => {
    const bytes = await readFile(file);
    return { path: slash(relative(packageRoot, file)), bytes: bytes.length, sha256: sha256(bytes) };
  }));
  const executable = resolve(runtime.directory, mac ? "node" : "node.exe");
  await write("app/manifest.json", JSON.stringify({
    schema: 1, product: "rain-or-shine", releaseId, builtAt, commit: dirty ? commit + " (with uncommitted changes)" : commit,
    os: target.os, arch: target.arch, minimumOS: mac ? "13.5" : "Windows 10",
    network: {
      name: dep.network, chainId: dep.chainId, admin: dep.admin, rpcOrigins,
      market: dep.contracts.PredictionMarket.address, adapter: dep.contracts.UmaMetricOracleAdapter.address,
    },
    runtime: { nodeVersion: NODE_VERSION, sourceURL: runtime.sourceURL, archiveSha256: runtime.archiveSha256, sha256: sha256(await readFile(executable)) },
    files: inventory,
  }, null, 2) + "\n");
  const zip = resolve(output, name + ".zip");
  if (existsSync(zip)) throw new Error("Refusing to replace an existing zip");
  await run(python, [archiveHelper, "zip", packageRoot, zip]);
  const checksum = sha256(await readFile(zip));
  await writeFile(zip + ".sha256", `${checksum}  ${name}.zip\n`);
  results.push({ zip, sha256: checksum, files: inventory.length + 1 });
}
console.log(JSON.stringify({ releaseId, commit, dirty, output, packages: results }, null, 2));
