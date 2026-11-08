import { hexlify, sha256, toUtf8Bytes, ZeroHash } from "ethers";
import { assertObservationBundle } from "../weather/observation-evidence.js";
import {
  assertNumericMarketRulesMatchChain,
  type NumericMarketRules, type NumericRulesChainExpectation,
} from "./numeric-rules.js";
import { assertHkoNumericProfile, assertSportsNumericProfile } from "./numeric-profiles.js";
import { normalizeSportsDemo } from "./sports-demo.js";
import { assertCustomNumericProfile, type HkoDailyExtractField } from "./custom-profile.js";
import { parseFixed100 } from "./fixed100.js";
import { readDailyExtractDay, type RawEvidence } from "../weather/parse.js";
import { decodeUtf8, parseJsonStrict, parseOneDecimalToken, parseWholePercentToken } from "../weather/strict.js";

/** Oracle input carries observations. The market evaluates YES/NO onchain. */
export interface NumericProposal {
  reading: { kind: 1 | 2; value: number };
  evidence: { sourceUrl: string; rawSha256: string; capturedAt: number; excerpt: string };
}

export interface NumericProposalContext {
  rulesDocument: string;
  expected: NumericRulesChainExpectation;
  chainTimestamp: number;
}

export const MAX_EXCERPT_BYTES = 2048;
const MAX_SOURCE_URL_BYTES = 256;
export const MAX_SOURCE_DOCUMENT_BYTES = 5_000_000;
const SPORTS_FIELDS = [
  "schema", "synthetic", "matchId", "teamA", "teamB",
  "status", "scoreA", "scoreB", "sport", "scoreScope",
] as const;

function fail(message: string): never {
  throw new Error(`numeric proposal: ${message}`);
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} must be positive safe integer Unix seconds`);
  }
  return value;
}

function prepare(context: NumericProposalContext): NumericMarketRules {
  const rules = assertNumericMarketRulesMatchChain(context.rulesDocument, context.expected);
  const now = timestamp(context.chainTimestamp, "chainTimestamp");
  const t = rules.config.times;
  if (now < t.earliestAssertionAt || now >= t.proposalCutoff) fail("proposal window is not open");
  return rules;
}

function validateReading(reading: NumericProposal["reading"], rules: NumericMarketRules): void {
  const metric = rules.metric;
  if (reading.kind === 1) {
    if (!Number.isSafeInteger(reading.value)
      || reading.value < metric.minValue || reading.value > metric.maxValue) {
      fail("reading is outside the registered metric range");
    }
    if (reading.value % metric.valueStep !== 0) fail("reading does not match the registered metric step");
    return;
  }
  if (reading.kind !== 2 || !metric.allowsTrace || reading.value !== 0
    || metric.unit !== "mm" || metric.minValue > 0 || metric.maxValue < 5) {
    fail("TRACE is not supported by this metric");
  }
  // Zero is only TRACE's placeholder. The rules check rejects conditions that TRACE cannot decide.
  // createMarket rejects them too.
}

function proposal(
  rules: NumericMarketRules,
  context: NumericProposalContext,
  reading: NumericProposal["reading"],
  rawSha256: string,
  capturedAt: number,
  sourceUrl: string,
  excerpt: Uint8Array,
): NumericProposal {
  validateReading(reading, rules);
  timestamp(capturedAt, "capturedAt");
  if (capturedAt < rules.config.times.observationEnd || capturedAt > context.chainTimestamp) {
    fail("capture must be after the observation window and no later than the chain timestamp");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawSha256) || rawSha256.toLowerCase() === ZeroHash) {
    fail("rawSha256 must be a nonzero bytes32 hash");
  }
  const sourceBytes = toUtf8Bytes(sourceUrl).length;
  if (sourceBytes === 0 || sourceBytes > MAX_SOURCE_URL_BYTES) fail("source URL exceeds the contract byte limit");
  if (excerpt.length === 0 || excerpt.length > MAX_EXCERPT_BYTES) fail("excerpt exceeds the contract byte limit");
  return {
    reading,
    evidence: { sourceUrl, rawSha256, capturedAt, excerpt: hexlify(excerpt) },
  };
}

export function buildHkoNumericProposal(
  bundle: unknown, context: NumericProposalContext,
): NumericProposal {
  const rules = prepare(context);
  const profile = assertHkoNumericProfile(rules);
  const verified = assertObservationBundle(bundle, {
    mode: "LIVE_HKO",
    sourceId: rules.config.sourceId,
    stationId: rules.config.subjectId,
    targetDate: profile.targetDate,
    metric: profile.weatherMetric,
    unit: rules.metric.unit as "mm" | "degC",
    scale: 100,
    windowStart: String(rules.config.times.observationStart),
    windowEnd: String(rules.config.times.observationEnd),
  });
  const observation = verified.observation;
  const capturedAt = Math.floor(Date.parse(observation.fetchedAt!) / 1000);
  const reading: NumericProposal["reading"] = observation.kind === "TRACE"
    ? { kind: 2, value: 0 }
    : { kind: 1, value: observation.value! };
  return proposal(
    rules, context, reading, observation.rawSha256, capturedAt,
    observation.sourceURL, toUtf8Bytes(observation.excerpt),
  );
}

export function buildSportsNumericProposal(
  rawBytes: Uint8Array, capturedAt: number, context: NumericProposalContext,
): NumericProposal {
  const rules = prepare(context);
  const profile = assertSportsNumericProfile(rules);
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length === 0 || rawBytes.length > MAX_EXCERPT_BYTES) {
    fail("sports result must contain 1..2048 original bytes");
  }
  // Parse the text without the BOM. Keep the original bytes for the hash and the evidence.
  const input = parseJsonStrict(decodeUtf8(rawBytes));
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("sports result must be an object");
  const data = input as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!(SPORTS_FIELDS as readonly string[]).includes(key)) fail(`unexpected sports result field: ${key}`);
  }
  for (const key of SPORTS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) fail(`missing sports result field: ${key}`);
  }
  const result = normalizeSportsDemo(data);
  if (data.sport !== profile.sport || result.scoreScope !== profile.scoreScope
    || result.subjectId !== profile.matchId || result.teamA !== profile.teamA || result.teamB !== profile.teamB) {
    fail("sports result does not match the committed match, ordered teams or scoring scope");
  }
  if (result.sourceId !== rules.config.sourceId || result.metricCode !== rules.metric.code || result.unit !== rules.metric.unit) {
    fail("sports result does not match the registered source, metric or unit");
  }
  const reading: NumericProposal["reading"] = { kind: 1, value: Number(result.valueText) * 100 };
  return proposal(
    rules, context, reading, sha256(rawBytes), capturedAt, rules.source.uri, rawBytes,
  );
}

/** A custom market's evidence: the exact imported bytes, the proposer's reading and an excerpt. */
export interface CustomProposalInput {
  rawBytes: Uint8Array;
  reading: string;
  /** The download time in Unix seconds. It lies between the observation's end and the chain time. */
  capturedAt: number;
  /** The part with the reading, copied exactly. A document up to 2048 bytes is copied whole. */
  excerpt?: Uint8Array;
}

function containsBytes(whole: Uint8Array, part: Uint8Array): boolean {
  outer: for (let start = 0; start + part.length <= whole.length; start++) {
    for (let i = 0; i < part.length; i++) if (whole[start + i] !== part[i]) continue outer;
    return true;
  }
  return false;
}

/** Hashes the imported bytes and adds the proposer's reading. The oracle judges the reading. */
export function buildCustomNumericProposal(input: CustomProposalInput, context: NumericProposalContext): NumericProposal {
  const rules = prepare(context);
  const profile = assertCustomNumericProfile(rules);
  if (profile.hko) fail("this market reads an HKO Daily Extract field; import the monthly file to read it automatically");
  const raw = input.rawBytes;
  if (!(raw instanceof Uint8Array) || raw.length === 0 || raw.length > MAX_SOURCE_DOCUMENT_BYTES) {
    fail(`the source document must contain 1..${MAX_SOURCE_DOCUMENT_BYTES} bytes`);
  }
  let excerpt = input.excerpt;
  if (excerpt === undefined || excerpt.length === 0) {
    if (raw.length > MAX_EXCERPT_BYTES) fail(`the document is larger than ${MAX_EXCERPT_BYTES} bytes; copy the part that shows the reading as the excerpt`);
    excerpt = raw;
  }
  if (excerpt.length > MAX_EXCERPT_BYTES) fail(`the excerpt must contain at most ${MAX_EXCERPT_BYTES} bytes`);
  if (!containsBytes(raw, excerpt)) fail("the excerpt must be copied exactly from the source document");
  const text = input.reading.trim();
  let reading: NumericProposal["reading"];
  if (/^trace$/i.test(text)) reading = { kind: 2, value: 0 };
  else {
    try {
      reading = { kind: 1, value: parseFixed100(text) };
    } catch {
      return fail("enter the reading as a number with at most two decimals");
    }
  }
  return proposal(rules, context, reading, sha256(raw), input.capturedAt, profile.sourceUrl, excerpt);
}

export function readHkoField(row: string[], field: HkoDailyExtractField): number {
  const token = row[field.column];
  if (field.format === "percent") return parseWholePercentToken(token, field.header).percent100;
  const { minValue, maxValue } = field.metric.definition;
  return parseOneDecimalToken(token, field.header, minValue, maxValue).value100;
}

export function buildHkoFieldProposal(raw: RawEvidence, context: NumericProposalContext): NumericProposal {
  const rules = prepare(context);
  const profile = assertCustomNumericProfile(rules);
  if (!profile.hko) fail("this market does not read an HKO Daily Extract field");
  if (raw.sourceURL !== profile.sourceUrl) fail("the file is not the committed monthly Daily Extract");
  if (!raw.fetchedAt) fail("the snapshot needs its acquisition time");
  const { row } = readDailyExtractDay(raw, profile.hko.targetDate);
  const capturedAt = Math.floor(Date.parse(raw.fetchedAt) / 1000);
  return proposal(
    rules, context, { kind: 1, value: readHkoField(row, profile.hko.field) }, sha256(raw.bytes), capturedAt,
    raw.sourceURL, toUtf8Bytes(JSON.stringify(row)),
  );
}
