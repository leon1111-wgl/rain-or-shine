// Local markets and trading, on chain 31337 only. It creates official rainfall and maximum-temperature markets for
// the coming Hong Kong days and four custom weather markets. The node's test accounts bet over two days of chain time,
// so every view has history. Two short custom markets read the HKO 15:00 temperature from a report the proposer
// pastes. The first is proposed and settled through the local Mock oracle. The second stays in its challenge period.
// The seed writes that report itself. It is local test data, not an observation. Two sports demos follow the weather
// markets. Their results are the synthetic files in fixtures/demo/sports. The basketball demo is settled. The
// football demo stays open. Each account keeps one side per market, as the contract requires.
// Usage: npm run node:local, npm run deploy:metric:local, then npm run seed:metric:local

import { readFileSync } from "node:fs";
import { encodeBytes32String, getAddress, keccak256, parseEther, toUtf8Bytes } from "ethers";
import hre from "hardhat";
import {
  HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument, identifierFromText,
  type CustomMetric,
} from "../src/metric/custom-profile.js";
import { hkDayMarketTimes, windowMarketTimes, type MarketTimes } from "../src/metric/market-times.js";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules, buildSportsNumericRules } from "../src/metric/numeric-profiles.js";
import { parseFixed100 } from "../src/metric/fixed100.js";
import {
  buildCustomNumericProposal, buildSportsNumericProposal, type NumericProposal, type NumericProposalContext,
} from "../src/metric/numeric-proposals.js";
import { hkDayWindow } from "../src/weather/profile.js";
import { readMetricManifest } from "./lib/metric-deployment.js";

const connection = await hre.network.create();
const { ethers } = connection;
if (connection.networkName !== "localhost" || Number((await ethers.provider.getNetwork()).chainId) !== 31337) {
  throw new Error("Use: hardhat run --network localhost scripts/seed-metric-local.ts");
}
const manifest = await readMetricManifest("localhost");
const [admin, signer1, ...members] = await ethers.getSigners();
if (!admin || !signer1 || members.length < 10) throw new Error("expected the local node's 20 accounts");
const proposer = signer1;
if (getAddress(await admin.getAddress()) !== getAddress(manifest.admin)) throw new Error("the first local account is not the manifest's administrator");
const market = await ethers.getContractAt("PredictionMarket", manifest.contracts.PredictionMarket.address, admin);
const adapter = await ethers.getContractAt("UmaMetricOracleAdapter", manifest.contracts.UmaMetricOracleAdapter.address, proposer);
const bondToken = await ethers.getContractAt("TestBondToken", manifest.oracle.bondCurrency, proposer);

const HOUR = 3_600;
const LIVENESS = 120;
const STAKES = ["0.001", "0.002", "0.002", "0.003", "0.005", "0.005", "0.008", "0.01", "0.015", "0.02", "0.03", "0.05"];
const random = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(list: readonly T[]) => list[random(list.length)]!;
const chainNow = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
const hkDate = (unix: number, days: number) => new Date((unix + 8 * HOUR + days * 86_400) * 1000).toISOString().slice(0, 10).replaceAll("-", "");

/** A metric's id, registering a preset (by code) or a custom metric (with its rules document's hash) when it is new. */
async function metricId(code: string, custom?: CustomMetric): Promise<number> {
  const count = Number(await market.metricCount());
  for (let id = 1; id <= count; id++) {
    const m = await market.getMetric(id);
    if (m.code === encodeBytes32String(code)) return id;
  }
  const preset = NUMERIC_METRIC_PRESETS.find((p) => p.code === code);
  const definition = custom?.definition ?? preset;
  const rulesHash = custom?.rulesHash ?? preset?.rulesHash;
  if (!definition || !rulesHash) throw new Error(`no definition for metric ${code}`);
  await (await market.registerMetric({
    code: encodeBytes32String(definition.code), unit: encodeBytes32String(definition.unit), minValue: definition.minValue, maxValue: definition.maxValue,
    valueStep: definition.valueStep, allowsTrace: definition.allowsTrace, rulesHash,
  })).wait();
  return Number(await market.metricCount());
}

interface Seeded {
  id: number;
  openAt: number;
  closeAt: number;
  /** Chance that a new account takes Yes. */
  yesBias: number;
  sides: Map<string, 1 | 2>;
}

async function create(config: Parameters<typeof market.createMarket>[0], rules: string, yesBias: number): Promise<Seeded> {
  await (await market.createMarket(config, toUtf8Bytes(rules))).wait();
  const id = Number(await market.marketCount());
  const t = (await market.getMarketConfig(id)).times;
  console.log(`market ${id} open ${new Date(Number(t.openAt) * 1000).toISOString()} close ${new Date(Number(t.closeAt) * 1000).toISOString()}`);
  return { id, openAt: Number(t.openAt), closeAt: Number(t.closeAt), yesBias, sides: new Map() };
}

async function hkoMarket(code: "TOTAL_RAINFALL" | "DAILY_MAX_TEMPERATURE", date: string, comparison: number, threshold: string, yesBias: number): Promise<Seeded> {
  const id = await metricId(code);
  const window = hkDayWindow(date);
  const openAt = (await chainNow()) + 60;
  const observationEnd = Number(window.end);
  const proposalCutoff = observationEnd + 7 * 86_400;
  const config = {
    proposer: await proposer.getAddress(),
    sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"),
    subjectId: encodeBytes32String("HKO"),
    condition: { metricId: id, comparison, lower: parseFixed100(threshold), upper: 0 },
    times: {
      openAt, closeAt: Number(window.start) - 60, observationStart: Number(window.start), observationEnd,
      earliestAssertionAt: observationEnd, proposalCutoff, refundAt: proposalCutoff + LIVENESS + HOUR, assertionLiveness: LIVENESS,
    },
  };
  const rules = buildHkoNumericRules({ title: `${date} ${code}`, targetDate: date }, { config, metricId: id, metric: await market.getMetric(id) });
  return create(config, rules, yesBias);
}

/** A custom metric whose reading the proposer takes from an imported document. */
const AFTERNOON_TEMPERATURE = customMetricRulesDocument({
  code: "HKO_3PM_TEMPERATURE", unit: "degC", minValue: -10_000, maxValue: 10_000, valueStep: 100, allowsTrace: false,
  interpretation: "Air temperature at the Hong Kong Observatory station at 15:00 HKT on the observation day, in whole degrees Celsius, as the HKO Current Weather Report gives it. NUMERIC is that value multiplied by 100.",
});
const CURRENT_WEATHER = {
  sourceName: "HKO Current Weather Report",
  sourceUrl: "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en",
  procedure: "Use the first report whose updateTime is at or after the end of the observation window (15:00 HKT). In temperature.data, read the value whose place is \"Hong Kong Observatory\" (whole degrees, unit C) and multiply it by 100. If that report or value is missing, do not propose.",
};
const PLAN = { proposalWindow: 7 * 86_400, assertionLiveness: LIVENESS, refundBuffer: HOUR };

/** A custom market: the creator's source and procedure, or an HKO Daily Extract field for one Hong Kong day. */
async function customMarket(
  metric: CustomMetric, condition: { comparison: number; lower: string; upper: string }, timesFrom: (openAt: number) => MarketTimes,
  source: typeof CURRENT_WEATHER | { targetDate: string }, title: string, yesBias: number,
): Promise<Seeded> {
  const id = await metricId(metric.definition.code, metric);
  const times = timesFrom((await chainNow()) + 60);
  const field = "targetDate" in source;
  const config = {
    proposer: await proposer.getAddress(),
    sourceId: encodeBytes32String(field ? "HKO_DAILY_EXTRACT" : identifierFromText(source.sourceName, "CUSTOM_SOURCE")),
    subjectId: encodeBytes32String(field ? "HKO" : metric.definition.code),
    condition: { metricId: id, comparison: condition.comparison, lower: parseFixed100(condition.lower), upper: parseFixed100(condition.upper) },
    times,
  };
  const context = { config, metricId: id, metric: await market.getMetric(id) };
  const rules = field
    ? buildHkoFieldNumericRules({ title, targetDate: source.targetDate }, context)
    : buildCustomNumericRules({ title, ...source, metricRulesDocument: metric.rulesDocument }, context);
  return create(config, rules, yesBias);
}

/** A short custom market on the 15:00 temperature: betting for `bettingSeconds`, then a one-hour observation. */
async function quickMarket(bettingSeconds: number): Promise<Seeded> {
  return customMarket(AFTERNOON_TEMPERATURE, { comparison: 4, lower: "26", upper: "0" },
    (openAt) => windowMarketTimes({ openAt, observationStart: openAt + Math.round(bettingSeconds), observationEnd: openAt + Math.round(bettingSeconds) + HOUR, plan: { ...PLAN, proposalWindow: HOUR } }),
    CURRENT_WEATHER, "HKO temperature at least 26 degC at the end of the window", 0.5);
}

const MATCHES = {
  BASKETBALL: { code: "SCORE_MARGIN", matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS", file: "basketball-lal-bos.json" },
  FOOTBALL: { code: "GOAL_MARGIN", matchId: "ARS_CHE_DEMO01", teamA: "ARS", teamB: "CHE", file: "football-ars-che.json" },
} as const;

/** A sports demo: betting for `bettingSeconds`, then the match window. Yes if team A wins. */
async function sportsDemo(sport: keyof typeof MATCHES, bettingSeconds: number, matchSeconds: number, yesBias: number): Promise<Seeded> {
  const match = MATCHES[sport];
  const id = await metricId(match.code);
  const openAt = (await chainNow()) + 60;
  const observationStart = openAt + Math.round(bettingSeconds);
  const config = {
    proposer: await proposer.getAddress(),
    sourceId: encodeBytes32String(`DEMO_${sport}`),
    subjectId: encodeBytes32String(match.matchId),
    condition: { metricId: id, comparison: 3, lower: 0, upper: 0 },
    times: windowMarketTimes({ openAt, observationStart, observationEnd: observationStart + matchSeconds, plan: { ...PLAN, proposalWindow: HOUR } }),
  };
  const rules = buildSportsNumericRules({ title: `DEMO ${match.matchId} ${match.teamA} vs ${match.teamB}`, sport, matchId: match.matchId, teamA: match.teamA, teamB: match.teamB },
    { config, metricId: id, metric: await market.getMetric(id) });
  return create(config, rules, yesBias);
}

/** Unix seconds at a Hong Kong day (YYYYMMDD) and hour. */
const hktAt = (date: string, hour: number) => Number(hkDayWindow(date).start) + hour * HOUR;

/** One bet by a random member on a random open market. A member keeps the side of its first bet there. */
async function trade(markets: Seeded[], at: number): Promise<boolean> {
  const open = markets.filter((m) => m.openAt <= at && at < m.closeAt - 60);
  if (open.length === 0) return false;
  const m = pick(open);
  const member = pick(members);
  const who = await member.getAddress();
  const side = m.sides.get(who) ?? (Math.random() < m.yesBias ? 1 : 2);
  m.sides.set(who, side);
  await (await market.connect(member).bet(m.id, side, { value: parseEther(pick(STAKES)) })).wait();
  return true;
}

/** One Yes and one No bet when a short market opens, so it is never one-sided at its close: a one-sided market only refunds
 * and takes no result. The proposer is never among the bettors (the contract refuses it). */
async function bothSides(m: Seeded): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [m.openAt]);
  for (const [member, side] of [[members[0]!, 1], [members[1]!, 2]] as const) {
    m.sides.set(await member.getAddress(), side);
    await (await market.connect(member).bet(m.id, side, { value: parseEther("0.002") })).wait();
  }
}

/** Proposes the evidence `build` makes from the market's checked rules, with the adapter's bond. Returns the assertion id. */
async function propose(id: number, build: (context: NumericProposalContext) => NumericProposal): Promise<string> {
  const config = await market.getMarketConfig(id);
  if ((await chainNow()) < Number(config.times.earliestAssertionAt) + 5) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(config.times.earliestAssertionAt) + 5]);
    await ethers.provider.send("evm_mine", []);
  }
  const metric = await market.getMetric(config.condition.metricId);
  const rulesHash = await market.marketRulesHash(id);
  const created = (await market.queryFilter(market.filters.MarketCreated(id))).at(-1)!;
  const rulesDocument = new TextDecoder().decode(ethers.getBytes(created.args.rulesDocument));
  if (keccak256(created.args.rulesDocument) !== rulesHash) throw new Error("rules document does not match the market");
  const now = await chainNow();
  const payload = build({ rulesDocument, expected: { config, metricId: config.condition.metricId, metric, marketRulesHash: rulesHash }, chainTimestamp: now });
  const bond = await adapter.bondAmount();
  await (await bondToken.mint(await proposer.getAddress(), bond)).wait();
  await (await bondToken.approve(await adapter.getAddress(), bond)).wait();
  await (await adapter.propose(id, payload.reading, payload.evidence, bond)).wait();
  return (await market.getAssertion(id)).assertionId;
}

/** A seeded report as a short market's result. */
function proposeReading(id: number, celsius: number): Promise<string> {
  const report = toUtf8Bytes(`Local seed report (test data, not an observation). Hong Kong Observatory temperature: ${celsius} C.`);
  return propose(id, (context) => buildCustomNumericProposal({ rawBytes: report, reading: String(celsius), capturedAt: context.chainTimestamp }, context));
}

/** A sports demo's synthetic result file as its result. */
function proposeMatch(id: number, sport: keyof typeof MATCHES): Promise<string> {
  const file = new Uint8Array(readFileSync(new URL(`../fixtures/demo/sports/${MATCHES[sport].file}`, import.meta.url)));
  return propose(id, (context) => buildSportsNumericProposal(file, context.chainTimestamp, context));
}

const start = await chainNow();
const day3 = hkDate(start, 3);
const day4 = hkDate(start, 4);
const markets = [
  await hkoMarket("TOTAL_RAINFALL", day3, 4, "1.0", 0.42),
  await hkoMarket("DAILY_MAX_TEMPERATURE", day3, 4, "27.0", 0.6),
  await hkoMarket("TOTAL_RAINFALL", day4, 4, "1.0", 0.35),
  await hkoMarket("DAILY_MAX_TEMPERATURE", day4, 4, "27.0", 0.5),
];
markets.push(
  await customMarket(AFTERNOON_TEMPERATURE, { comparison: 5, lower: "24", upper: "27" },
    (openAt) => windowMarketTimes({ openAt, observationStart: hktAt(day3, 14), observationEnd: hktAt(day3, 15), plan: PLAN }),
    CURRENT_WEATHER, `HKO 15:00 temperature between 24 and 27 degC inclusive, ${day3}`, 0.5),
  await customMarket(HKO_DAILY_EXTRACT_FIELDS.find((field) => field.key === "mean-humidity")!.metric, { comparison: 5, lower: "70", upper: "85" },
    (openAt) => hkDayMarketTimes({ openAt, targetDate: day4, plan: PLAN }),
    { targetDate: day4 }, `HKO mean relative humidity between 70 and 85 % inclusive, ${day4}`, 0.55),
);
const first = await quickMarket(20 * HOUR);
markets.push(first);
await bothSides(first);
const basketball = await sportsDemo("BASKETBALL", 30 * HOUR, 2.5 * HOUR, 0.55);
markets.push(basketball);
await bothSides(basketball);
const football = await sportsDemo("FOOTBALL", 60 * HOUR, 2 * HOUR, 0.45);
markets.push(football);
await bothSides(football);
// Backlog: one bet every 15 to 75 minutes of chain time for about two days. The first short market closes after 20 h.
// It is proposed and settled after its hour of observation. A second short market then opens. The backlog stops when
// its observation ends, so its result goes in within the proposal window and stays in its challenge period. The
// basketball demo is proposed and settled after its match. The football demo is still open at the end.
let trades = 0;
let late: Seeded | undefined;
let matchSettled = false;
const endAt = () => (late ? late.closeAt + HOUR : start + 48 * HOUR);
for (let at = Math.max(...markets.map((m) => m.openAt)); at < endAt(); ) {
  at = Math.min(at + 15 * 60 + random(60 * 60), endAt());
  if (!matchSettled && at > basketball.closeAt + 2.5 * HOUR + 120) {
    const id = await proposeMatch(basketball.id, "BASKETBALL");
    await ethers.provider.send("evm_setNextBlockTimestamp", [(await chainNow()) + LIVENESS + 5]);
    await (await adapter.settle(id)).wait();
    matchSettled = true;
    at = await chainNow();
    continue;
  }
  if (!late && at > first.closeAt + HOUR + 120) {
    const id = await proposeReading(first.id, 27);
    await ethers.provider.send("evm_setNextBlockTimestamp", [(await chainNow()) + LIVENESS + 5]);
    await (await adapter.settle(id)).wait();
    late = await quickMarket(start + 46.5 * HOUR - (await chainNow()) - 60);
    await bothSides(late);
    markets.push(late);
    at = await chainNow();
    continue;
  }
  await ethers.provider.send("evm_setNextBlockTimestamp", [at]);
  if (await trade(markets, at)) trades++;
  else await ethers.provider.send("evm_mine", []);
}
if (late) await proposeReading(late.id, 25);
console.log(`${trades} bets over ${Math.round(((await chainNow()) - start) / HOUR)} h of local chain time`);
