// The desktop package's local server. It serves the built app on 127.0.0.1 and relays a few HKO reads.
// It holds no keys and sends no transactions.
// Usage: node serve.mjs [--root PATH] [--port 17620] [--no-open] [--report FILE]

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { delimiter, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HKO_RELAY_PREFIX, relayHko } from "./hko-relay.mjs";

const APP_ID = "rain-or-shine-local";
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

// Use the same realpath call as the file checks. On Windows, short paths can differ between the two versions.
const root = await realpath(resolve(option("--root", resolve(here, "../www"))));
const basePort = Number(option("--port", "17620"));
const noOpen = args.includes("--no-open") || process.env.RAINPOOL_NO_BROWSER === "1";
if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65000) throw new Error("invalid local port");
if (!existsSync(resolve(root, "index.html"))) throw new Error(`no prebuilt index.html in ${root}`);

// The package's manifest.json tells a second launch whether this release is already running.
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // A development run has no manifest; the defaults below apply.
  }
}
const manifest = readJson(resolve(here, "../manifest.json"));
const config = readJson(resolve(root, "config.public.json"));
const releaseId = option("--release-id", manifest?.releaseId ?? "rain-or-shine-dev");

// Scripts and styles come only from this server. JSON-RPC goes only to the listed RPC origins.
// Public RPCs must use https. Plain http is allowed only for a test chain on this computer.
const rpcOrigins = (config?.rpcOrigins ?? []).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o));
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${rpcOrigins.join(" ")}`.trim(),
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// A local launch log for troubleshooting. It is never uploaded.
const REPORT = resolve(option("--report", resolve(dirname(root), "launch-report.log")));
const shortcutTarget = option("--shortcut", "");
const home = os.homedir();
const tidy = (p) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
function stamp() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19).replace("T", " ");
  return `${local} ${off >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
}
function report(event, fields) {
  const line = `[${stamp()}] ${event.padEnd(12)} ${Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(" ")}\n`;
  try {
    appendFileSync(REPORT, line);
  } catch (error) {
    console.log(`launch-report.log could not be written (${error?.code ?? error}). The app still works.`);
  }
}
/** Folders on PATH that already contain a Node executable (none expected on a member's clean machine). */
function nodeOnPath() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const hits = (process.env.PATH ?? "").split(delimiter).filter((d) => d && existsSync(join(d, exe)));
  return hits.length ? hits.map(tidy).join("; ") : "none";
}
let readyAt = 0;
let pageSeen = false;

const SHORTCUT_NAME = "Rain or Shine";
/** One desktop shortcut to the START file the member double-clicked; replaced when it points elsewhere. */
function placeShortcut(target) {
  const file = resolve(target);
  if (!existsSync(file)) return `skipped (no ${tidy(file)})`;
  if (process.platform === "win32") {
    const q = (v) => `'${v.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop'",
      `$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ${q(`${SHORTCUT_NAME}.lnk`)}`,
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
      `if ($s.TargetPath -eq ${q(file)}) { 'exists'; exit 0 }`,
      `$s.TargetPath = ${q(file)}; $s.WorkingDirectory = ${q(dirname(file))}; $s.Description = 'Rain or Shine'; $s.Save(); 'created'`,
    ].join("; ");
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    return run.status === 0 ? run.stdout.trim() : `failed (${(run.stderr || run.error?.message || "powershell").trim().split("\n")[0]})`;
  }
  const desktop = join(os.homedir(), "Desktop");
  if (!existsSync(desktop)) return "skipped (no Desktop folder)";
  const link = join(desktop, `${SHORTCUT_NAME}${process.platform === "darwin" ? ".command" : ""}`);
  try {
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === file) return "exists";
      if (!lstatSync(link).isSymbolicLink()) return "skipped (a file with that name already exists)";
      unlinkSync(link);
    }
    symlinkSync(file, link);
    return "created";
  } catch (error) {
    return `failed (${error?.code ?? error})`;
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8", head = false, live = false) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": live || type.startsWith("text/html") || status !== 200 ? "no-store" : "public, max-age=3600",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  res.end(head ? undefined : body);
}

async function respond(req, res, port) {
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) return send(res, 405, "GET/HEAD only");
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return send(res, 403, "invalid Host", undefined, head);
  if ((req.url ?? "").startsWith(`${HKO_RELAY_PREFIX}/`)) {
    const relayed = await relayHko(req.url);
    return send(res, relayed.status, relayed.body, relayed.type, head, true);
  }
  let path;
  try {
    path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    return send(res, 400, "invalid path encoding", undefined, head);
  }
  if (path === "/_health") return send(res, 200, JSON.stringify({ appId: APP_ID, releaseId }), MIME[".json"], head);
  if (!pageSeen && !head && (req.headers.accept ?? "").includes("text/html")) {
    pageSeen = true;
    report("page-loaded", { afterSeconds: readyAt ? ((Date.now() - readyAt) / 1000).toFixed(1) : "?", browser: req.headers["user-agent"] ?? "unknown" });
  }
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((s) => s.startsWith(".") || s === "node_modules")) {
    return send(res, 403, "path blocked", undefined, head);
  }
  const requested = resolve(root, `.${path}`);
  if (requested !== root && !requested.startsWith(root + sep)) return send(res, 403, "outside www", undefined, head);
  try {
    let file = requested;
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    const actual = await realpath(file);
    if (!actual.startsWith(root + sep)) return send(res, 403, "symlink outside www", undefined, head);
    // One handle for the check and the read, so the file cannot be swapped between them.
    const handle = await open(actual, "r");
    try {
      if (!(await handle.stat()).isFile()) return send(res, 404, "not a file", undefined, head);
      return send(res, 200, await handle.readFile(), MIME[extname(actual).toLowerCase()] ?? "application/octet-stream", head);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    if (missing && !extname(path) && (req.headers.accept ?? "").includes("text/html")) {
      return send(res, 200, await readFile(resolve(root, "index.html")), MIME[".html"], head); // A refreshed app route
    }
    return send(res, missing ? 404 : 500, missing ? "not found" : "file unavailable", undefined, head);
  }
}

/** True when this exact release already answers on `port` (a second double-click), so it is reused, not duplicated. */
function sameReleaseOn(port) {
  return new Promise((done) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/_health", timeout: 800, headers: { Host: `127.0.0.1:${port}` } }, (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
        if (text.length > 2048) request.destroy();
      });
      response.on("end", () => {
        try {
          const info = JSON.parse(text);
          done(info.appId === APP_ID && info.releaseId === releaseId);
        } catch {
          done(false); // Another program uses this port. Try the next one.
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => done(false));
  });
}

function openBrowser(url) {
  if (noOpen) return;
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const parameters = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, parameters, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => console.log(`Open in your browser / 请在浏览器打开: ${url}`));
  child.unref();
}

function banner(url) {
  console.log("");
  console.log(`Rain or Shine is running at ${url}`);
  console.log("Keep this window open. Close it to stop.");
  console.log("Use a browser with MetaMask to trade.");
  console.log("");
  console.log("Rain or Shine 已在本机运行。使用时请保持此窗口打开，关闭即停止。");
  console.log("交易需要装有 MetaMask 的浏览器。");
  console.log("");
}

let server = null;
for (let offset = 0; offset < 10 && !server; offset++) {
  const port = basePort + offset;
  const candidate = http.createServer((req, res) => respond(req, res, port).catch(() => send(res, 500, "local server error")));
  candidate.requestTimeout = 10_000;
  candidate.headersTimeout = 15_000;
  try {
    await new Promise((ok, fail) => {
      candidate.once("error", fail);
      candidate.listen(port, "127.0.0.1", ok);
    });
    server = candidate;
    const url = `http://127.0.0.1:${port}/`;
    banner(url);
    readyAt = Date.now();
    report("start", {
      release: releaseId,
      package: `${manifest?.os ?? "?"} ${manifest?.arch ?? "?"}`,
      os: `${os.type()} ${os.release()}${typeof os.version === "function" ? ` (${os.version()})` : ""}`,
      cpu: os.arch(),
      runtime: `${process.version} ${tidy(process.execPath)}`,
      nodeAlreadyOnPath: nodeOnPath(),
      folder: tidy(dirname(root)),
      folderHasNonAscii: /[^\x20-\x7e]/.test(dirname(root)) ? "yes" : "no",
      folderHasSpace: dirname(root).includes(" ") ? "yes" : "no",
      url,
      portsTriedBefore: offset,
      autoOpen: noOpen ? "off (--no-open)" : "requested",
    });
    openBrowser(url);
    if (shortcutTarget && process.env.RAINPOOL_NO_SHORTCUT !== "1") {
      const result = placeShortcut(shortcutTarget);
      report("shortcut", { name: SHORTCUT_NAME, result });
      if (result === "created") console.log(`A desktop shortcut "${SHORTCUT_NAME}" was added. 桌面已添加快捷方式。`);
    }
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    if (await sameReleaseOn(port)) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Rain or Shine is already running at ${url}`);
      report("reused", { release: releaseId, url, note: "second launch opened the page already being served" });
      openBrowser(url);
      process.exit(0);
    }
    console.log(`Port ${port} is in use. Trying ${port + 1}.`);
  }
}
if (!server) {
  console.log(`No free port from ${basePort} to ${basePort + 9}. Close other Rain or Shine windows and try again.`);
  throw new Error("no free local port");
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => server.close(() => process.exit(0)));
