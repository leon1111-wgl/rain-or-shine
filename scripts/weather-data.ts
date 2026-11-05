import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { sha256 } from "ethers";
import { fetchRaw } from "../src/weather/fetch.js";
import { DAILY_METRICS, fetchDailyObservations } from "../src/weather/observation-fetch.js";
import { assertObservationBundle, buildObservationBundle, checkObservationBundle } from "../src/weather/observation-evidence.js";
import { demoObservationText, parseDailyExtractObservation, parseDemoObservation, type WeatherMetric, type WeatherObservation } from "../src/weather/observations.js";
import type { RawEvidence } from "../src/weather/parse.js";
import { dailyExtractMonthUrl, dailyExtractYearUrl, toCompactDate } from "../src/weather/profile.js";
import { parseJsonStrict, WeatherDataError } from "../src/weather/strict.js";
import { fetchTropicalCycloneWarning, parseTropicalCycloneWarning } from "../src/weather/warnings.js";

const HELP = `weather:data <command>
  fetch   --date YYYYMMDD [--metric rainfall|max-temperature] [--out FILE]
          Fetch one monthly snapshot; default: both daily observations.
  capture --date YYYYMMDD [--metric rainfall|max-temperature] [--dir DIR]
          Archive exact raw bytes and SHA-256 metadata; default DIR: evidence/weather-data/captures.
  parse   --raw FILE --meta FILE --date YYYYMMDD [--metric rainfall|max-temperature]
          Parse a checked archive (also accepts the original project's capture metadata).
  bundle  --date YYYYMMDD --metric rainfall|max-temperature --out FILE
          [--raw FILE --meta FILE | --fixture FILE]
          Build WEATHER evidence v3. LIVE monthly snapshots feed the numeric HKO proposal converter.
  verify  --bundle FILE [--metric rainfall|max-temperature] [--refetch]
          Re-hash and re-parse every observation field; optionally compare a fresh official reading.
  demo    --date YYYYMMDD --metric rainfall|max-temperature --value TEXT --out FILE
          Make an explicitly synthetic fixture; use bundle --fixture to package it. Negative values: --value=-2.5.
  check   --date YYYYMMDD [--metric rainfall|max-temperature] [--out FILE]
          Compare monthly and yearly official values. Missing yearly data = INCOMPLETE, never a pass.
  warnings [--lang en|sc|tc] [--out FILE] [--dir DIR | --raw FILE --meta FILE]
          Current tropical cyclone warning snapshot only; cannot establish historical/monthly absence.
Use --out to save JSON; parent directories are created. The numeric UI accepts LIVE HKO bundles.
Weather demo fixtures are parser test tools. They are not market results.
Exit codes: 0 success/agreement, 1 usage, 2 data unavailable/incomplete, 3 invalid/mismatched data.
`;

type Options = Record<string, string | undefined>;
const required = (o: Options, key: string): string => {
  const value = o[key];
  if (!value) throw new Error("missing --" + key);
  return value;
};
const metricOf = (text: string): WeatherMetric => {
  if (text === "rainfall" || text === "TOTAL_RAINFALL_MM") return "TOTAL_RAINFALL_MM";
  if (text === "max-temperature" || text === "DAILY_MAX_TEMPERATURE_C") return "DAILY_MAX_TEMPERATURE_C";
  throw new Error("unsupported --metric " + text + "; use rainfall or max-temperature");
};
const metricsOf = (o: Options): readonly WeatherMetric[] => o.metric ? [metricOf(o.metric)] : DAILY_METRICS;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

async function save(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, content);
}

async function output(value: unknown, out?: string): Promise<void> {
  const text = json(value);
  if (out) await save(out, text);
  process.stdout.write(text);
}

async function archived(o: Options): Promise<RawEvidence | undefined> {
  if (!o.raw && !o.meta) return undefined;
  if (!o.raw || !o.meta) throw new Error("--raw and --meta must be provided together");
  const meta = parseJsonStrict(await readFile(o.meta, "utf8")) as Record<string, unknown>;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new WeatherDataError("DATA_INVALID", "capture metadata must be an object");
  const bytes = new Uint8Array(await readFile(o.raw));
  if (meta.byteLength !== bytes.length || (meta.sha256 !== undefined && sha256(bytes) !== meta.sha256)) {
    throw new WeatherDataError("EVIDENCE_MISMATCH", "raw archive hash/length differs from capture metadata");
  }
  const sourceURL = meta.requestUrl;
  if (typeof sourceURL !== "string" || typeof meta.fetchedAt !== "string" ||
      !(meta.contentType === null || typeof meta.contentType === "string") ||
      !(meta.lastModified === null || meta.lastModified === undefined || typeof meta.lastModified === "string") ||
      !(meta.httpStatus === null || (typeof meta.httpStatus === "number" && Number.isInteger(meta.httpStatus)))) {
    throw new WeatherDataError("DATA_INVALID", "invalid capture metadata fields");
  }
  return { bytes, sourceURL, fetchedAt: meta.fetchedAt, contentType: meta.contentType,
    httpStatus: meta.httpStatus, lastModified: meta.lastModified ?? null };
}

async function capture(raw: RawEvidence, dir: string, label: string): Promise<{ raw: string; meta: string }> {
  const stamp = (raw.fetchedAt ?? new Date().toISOString()).replaceAll(/[^0-9TZ]/g, "");
  const base = label + "_" + stamp;
  const rawFile = path.join(dir, base + ".raw");
  const metaFile = path.join(dir, base + ".meta.json");
  await save(rawFile, raw.bytes);
  await save(metaFile, json({
    captureTool: "scripts/weather-data.ts", captureVersion: 1,
    requestUrl: raw.sourceURL, fetchedAt: raw.fetchedAt, httpStatus: raw.httpStatus,
    contentType: raw.contentType, lastModified: raw.lastModified,
    byteLength: raw.bytes.length, sha256: sha256(raw.bytes), rawFile: path.basename(rawFile),
  }));
  return { raw: rawFile, meta: metaFile };
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  const { values } = parseArgs({ args, strict: true, options: {
    date: { type: "string" }, metric: { type: "string" }, raw: { type: "string" },
    meta: { type: "string" }, out: { type: "string" }, dir: { type: "string" },
    bundle: { type: "string" }, fixture: { type: "string" }, value: { type: "string" },
    lang: { type: "string" }, refetch: { type: "boolean", default: false },
  } });
  const o = values as Options & { refetch?: boolean };
  if (command === "fetch" || command === "capture" || command === "parse") {
    const date = toCompactDate(required(o, "date"));
    const stored = await archived(o);
    if (command === "parse" && !stored) throw new Error("parse requires --raw and --meta");
    if (command !== "parse" && stored) throw new Error("use parse to read an archive");
    const result = stored
      ? { raw: stored, observations: metricsOf(o).map((m) => parseDailyExtractObservation(stored, date, m)) }
      : await fetchDailyObservations(date, metricsOf(o));
    const files = command === "capture" ? await capture(result.raw, o.dir ?? "evidence/weather-data/captures", "dailyExtract_" + date.slice(0, 6)) : undefined;
    await output({ observations: result.observations, ...(files ? { capture: files } : {}) }, o.out);
    return 0;
  }
  if (command === "demo") {
    const text = demoObservationText(required(o, "date"), metricOf(required(o, "metric")), required(o, "value"));
    const out = required(o, "out");
    await save(out, text);
    await output({ wrote: out, synthetic: true, sha256: sha256(new TextEncoder().encode(text)) });
    return 0;
  }
  if (command === "bundle") {
    const date = toCompactDate(required(o, "date"));
    const metric = metricOf(required(o, "metric"));
    const out = required(o, "out");
    if (o.fixture && (o.raw || o.meta)) throw new Error("--fixture and --raw/--meta are mutually exclusive");
    const raw: RawEvidence = o.fixture ? {
      bytes: new Uint8Array(await readFile(o.fixture)), sourceURL: "fixture:" + path.basename(o.fixture),
      fetchedAt: new Date().toISOString(), contentType: "application/json", httpStatus: null, lastModified: null,
    } : await archived(o) ?? await fetchRaw(dailyExtractMonthUrl(date));
    const observation = o.fixture ? parseDemoObservation(raw, date, metric) : parseDailyExtractObservation(raw, date, metric);
    const bundle = buildObservationBundle(raw, observation);
    assertObservationBundle(bundle);
    await output(bundle, out);
    return 0;
  }
  if (command === "verify") {
    const value: unknown = parseJsonStrict(await readFile(required(o, "bundle"), "utf8"));
    const checks = checkObservationBundle(value);
    if (!checks.every((c) => c.ok)) { await output({ checks }, o.out); return 3; }
    const bundle = assertObservationBundle(value);
    if (o.metric) checks.push({ name: "requestedMetric", ok: bundle.observation.metric === metricOf(o.metric), detail: "expected " + metricOf(o.metric) });
    if (o.refetch) {
      if (bundle.observation.mode !== "LIVE_HKO") throw new Error("--refetch requires a LIVE_HKO bundle");
      const { observations: [fresh] } = await fetchDailyObservations(bundle.observation.targetDate, [bundle.observation.metric]);
      if (!fresh) throw new Error("missing refreshed observation");
      checks.push({ name: "freshObservation", ok: fresh.kind === bundle.observation.kind && fresh.value === bundle.observation.value,
        detail: "fresh value " + fresh.valueText + " " + fresh.unit + "; raw SHA-256 " + fresh.rawSha256 });
    }
    await output({ checks }, o.out);
    return checks.every((c) => c.ok) ? 0 : 3;
  }
  if (command === "check") {
    const date = toCompactDate(required(o, "date"));
    const metrics = metricsOf(o);
    const monthly = await fetchDailyObservations(date, metrics);
    let yearly: WeatherObservation[];
    try {
      const raw = await fetchRaw(dailyExtractYearUrl(Number(date.slice(0, 4))));
      yearly = metrics.map((m) => parseDailyExtractObservation(raw, date, m));
    } catch (err) {
      if (!(err instanceof WeatherDataError) || err.code !== "DATA_UNAVAILABLE") throw err;
      await output({ status: "INCOMPLETE", monthly: monthly.observations, yearlyError: err.message }, o.out);
      return 2;
    }
    const comparisons = monthly.observations.map((m, i) => ({
      metric: m.metric, monthly: m.valueText, yearly: yearly[i]?.valueText,
      agree: m.kind === yearly[i]?.kind && m.value === yearly[i]?.value,
    }));
    const agree = comparisons.every((c) => c.agree);
    await output({ status: agree ? "AGREEMENT" : "DISAGREEMENT", comparisons,
      monthly: monthly.observations, yearly }, o.out);
    return agree ? 0 : 3;
  }
  if (command === "warnings") {
    const lang = o.lang ?? "en";
    if (lang !== "en" && lang !== "sc" && lang !== "tc") throw new Error("--lang must be en, sc or tc");
    const stored = await archived(o);
    const result = stored ? { raw: stored, snapshot: parseTropicalCycloneWarning(stored) } : await fetchTropicalCycloneWarning(lang);
    const files = o.dir ? await capture(result.raw, o.dir, "warnsum_" + lang) : undefined;
    await output({ snapshot: result.snapshot, ...(files ? { capture: files } : {}) }, o.out);
    return 0;
  }
  throw new Error("unknown command " + command + "\n" + HELP);
}

main().then((code) => { process.exitCode = code; }, (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof WeatherDataError ? (err.code === "DATA_UNAVAILABLE" ? 2 : 3) : 1;
});
