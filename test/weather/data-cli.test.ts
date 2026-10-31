import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// These tests start real processes (tsx, a local server). On a loaded machine one can take well over the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

const temp = mkdtempSync(path.join(os.tmpdir(), "rainpool-weather-cli-"));
afterAll(() => {
  const resolved = path.resolve(temp);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("rainpool-weather-cli-")) {
    throw new Error("refusing to remove a path outside the test temp directory");
  }
  rmSync(resolved, { recursive: true, force: true });
});
const run = (...args: string[]) => spawnSync(process.execPath,
  ["--import", "tsx", "scripts/weather-data.ts", ...args], { encoding: "utf8", timeout: 20_000 });
const dir = "fixtures/official/hko-daily-extract";
const meta = readdirSync(dir).find((f) => f.startsWith("dailyExtract_202609_") && f.endsWith(".meta.json"))!;
const raw = path.join(dir, meta.replace(".meta.json", ".raw"));
const metaFile = path.join(dir, meta);

describe("weather:data CLI (offline integration)", () => {
  it("parses both observations from an original checked archive", () => {
    const result = run("parse", "--raw", raw, "--meta", metaFile, "--date", "20260914");
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { observations: { value: number; metric: string }[] };
    expect(parsed.observations.map((o) => o.value)).toEqual([3790, 2870]);
  });
  it("builds temperature evidence, verifies it, and rejects the wrong expected metric", () => {
    const out = path.join(temp, "nested", "temperature.json");
    const built = run("bundle", "--raw", raw, "--meta", metaFile, "--date", "20260914",
      "--metric", "max-temperature", "--out", out);
    expect(built.status, built.stderr).toBe(0);
    const verified = run("verify", "--bundle", out, "--metric", "max-temperature");
    expect(verified.status, verified.stderr).toBe(0);
    expect(run("verify", "--bundle", out, "--metric", "rainfall").status).toBe(3);
    const tampered = JSON.parse(readFileSync(out, "utf8"));
    tampered.observation.unit = "mm";
    writeFileSync(out, JSON.stringify(tampered));
    expect(run("verify", "--bundle", out).status).toBe(3);
  });
  it("round trips an explicitly synthetic negative temperature fixture", () => {
    const fixture = path.join(temp, "fixture.json");
    const bundle = path.join(temp, "demo-bundle.json");
    const demo = run("demo", "--date", "20261020", "--metric", "max-temperature", "--value=-2.5", "--out", fixture);
    expect(demo.status, demo.stderr).toBe(0);
    const built = run("bundle", "--date", "20261020", "--metric", "max-temperature", "--fixture", fixture, "--out", bundle);
    expect(built.status, built.stderr).toBe(0);
    const parsed = JSON.parse(readFileSync(bundle, "utf8"));
    expect(parsed.observation).toMatchObject({ mode: "DEMO_FIXTURE", value: -250 });
    expect(run("verify", "--bundle", bundle).status).toBe(0);
  });
  it("reports unavailable dates distinctly and does not ignore half an archive pair", () => {
    const missing = run("parse", "--raw", raw, "--meta", metaFile, "--date", "20260931");
    expect(missing.status).not.toBe(0);
    expect(run("parse", "--raw", raw, "--date", "20260914").status).toBe(1);
    expect(run("parse", "--raw", raw, "--meta", metaFile, "--date", "20260914", "--metric", "humidity").status).toBe(1);
  });
});
