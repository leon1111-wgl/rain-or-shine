import { expect } from "chai";
import { network } from "hardhat";
import { encodeBytes32String, toUtf8Bytes } from "ethers";
import {
  HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument,
  type CustomMetric, type CustomMetricInput,
} from "../../src/metric/custom-profile.js";
import { windowMarketTimes, hkDayMarketTimes, type MarketTimes } from "../../src/metric/market-times.js";
import { buildCustomNumericProposal, buildHkoFieldProposal, type NumericProposal } from "../../src/metric/numeric-proposals.js";
import type { NumericRulesChainExpectation } from "../../src/metric/numeric-rules.js";
import { dailyExtractMonthUrl } from "../../src/weather/profile.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;
const BOND = ethers.parseUnits("10", 6);
const MIN = ethers.parseEther("0.001");
const PLAN = { proposalWindow: 86_400, assertionLiveness: 120, refundBuffer: 3_600 };

async function fixture() {
  const [admin, proposer, alice, bob, settler, store] = await ethers.getSigners();
  if (!admin || !proposer || !alice || !bob || !settler || !store) throw new Error("This test requires six accounts");
  const token = await ethers.deployContract("TestBondToken", ["Custom bond", "tBOND", 6]);
  const oracle = await ethers.deployContract("MockOptimisticOracleV3", [store.address]);
  const market = await ethers.deployContract("PredictionMarket", [admin.address]);
  const adapter = await ethers.deployContract("UmaMetricOracleAdapter", [oracle, market, token, BOND]);
  await (await oracle.setCurrency(token, true, BOND)).wait();
  await (await market.setOracleAdapter(adapter)).wait();
  await (await token.mint(proposer, 10n * BOND)).wait();
  await (await token.connect(proposer).approve(adapter, 10n * BOND)).wait();
  return { admin, proposer, alice, bob, settler, token, oracle, market, adapter };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function register(f: Fixture, metric: CustomMetric): Promise<number> {
  const d = metric.definition;
  await (await f.market.registerMetric({
    code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), minValue: d.minValue, maxValue: d.maxValue,
    valueStep: d.valueStep, allowsTrace: d.allowsTrace, rulesHash: metric.rulesHash,
  })).wait();
  return Number(await f.market.metricCount());
}

async function createMarket(
  f: Fixture, metricId: number, condition: { comparison: number; lower: number; upper: number }, times: MarketTimes,
  ids: { sourceId: string; subjectId: string }, rules: (context: { config: object; metricId: number; metric: never }) => string,
) {
  const config = {
    proposer: f.proposer.address, sourceId: encodeBytes32String(ids.sourceId), subjectId: encodeBytes32String(ids.subjectId),
    condition: { metricId, ...condition }, times,
  };
  const document = rules({ config, metricId, metric: await f.market.getMetric(metricId) as never });
  await (await f.market.createMarket(config, toUtf8Bytes(document))).wait();
  return { id: Number(await f.market.marketCount()), document, times };
}

async function chainExpectation(f: Fixture, id: number): Promise<NumericRulesChainExpectation> {
  const config = await f.market.getMarketConfig(id);
  const metricId = config.condition.metricId;
  return { config, metricId, metric: await f.market.getMetric(metricId), marketRulesHash: await f.market.marketRulesHash(id) };
}

async function proposeAndSettle(f: Fixture, id: number, proposal: NumericProposal) {
  const [outcome] = [await f.market.checkProposal(id, f.proposer.address, proposal.reading, proposal.evidence.rawSha256)];
  await f.adapter.connect(f.proposer).previewClaim(id, proposal.reading, proposal.evidence);
  await f.adapter.connect(f.proposer).propose.staticCall(id, proposal.reading, proposal.evidence, BOND);
  await (await f.adapter.connect(f.proposer).propose(id, proposal.reading, proposal.evidence, BOND)).wait();
  const assertionId = await f.adapter.assertionOfMarket(id);
  await time.increaseTo((await f.oracle.getAssertion(assertionId)).expirationTime);
  await (await f.adapter.connect(f.settler).settle(assertionId)).wait();
  return outcome;
}

const custom = (input: CustomMetricInput) => customMetricRulesDocument(input);

describe("Custom markets on the contracts", function () {
  after(async function () { await connection.close(); });

  const matrix = [
    {
      name: "weekly rainfall total ≥ 20.0 mm", reading: "23.4", outcome: 1n,
      metric: custom({ code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999990, valueStep: 10, allowsTrace: true, interpretation: "Total rainfall at HKO headquarters over the observation window, the sum of the daily totals." }),
      condition: { comparison: 4, lower: 2000, upper: 0 }, days: [1, 8],
      source: { sourceName: "HKO Daily Extract, seven daily rows", sourceUrl: "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202611.xml", procedure: "Add column 8 (Total Rainfall (mm)) of the seven daily rows of the observation window." },
      document: "day,rainfall_mm\n1,0.0\n2,Trace\n3,12.1\n4,3.4\n5,0.0\n6,7.9\n7,0.0\n",
    },
    {
      name: "temperature band 25.0–28.0 °C, inclusive", reading: "28.0", outcome: 1n,
      metric: custom({ code: "AFTERNOON_TEMPERATURE", unit: "degC", minValue: -10000, maxValue: 10000, valueStep: 10, allowsTrace: false, interpretation: "Air temperature at HKO headquarters at the end of the observation window." }),
      condition: { comparison: 5, lower: 2500, upper: 2800 }, days: [1, 1.125],
      source: { sourceName: "HKO current weather report", sourceUrl: "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en", procedure: "Read the Hong Kong Observatory temperature from the report at the end of the window." },
      document: JSON.stringify({ temperature: { data: [{ place: "Hong Kong Observatory", value: 28, unit: "C" }] } }),
    },
    {
      name: "pressure change < −5 hPa", reading: "-3", outcome: 2n,
      metric: custom({ code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50000, maxValue: 50000, valueStep: 100, allowsTrace: false, interpretation: "Change in mean sea-level pressure at HKO headquarters over the window, in whole hPa." }),
      condition: { comparison: 1, lower: -500, upper: 0 }, days: [2, 2.125],
      source: { sourceName: "Pressure log", sourceUrl: "https://example.org/pressure-log", procedure: "Subtract the first hourly pressure in the window from the last one." },
      document: "<html><body><table id=log><tr><td>08:00</td><td>1012</td></tr><tr><td>11:00</td><td>1009</td></tr></table></body></html>",
    },
    {
      name: "peak gust ≤ 60.00 km/h", reading: "48.27", outcome: 1n,
      metric: custom({ code: "PEAK_GUST", unit: "kmh", minValue: 0, maxValue: 100000, valueStep: 1, allowsTrace: false, interpretation: "Highest gust at Waglan Island over the window, in km/h with two decimals." }),
      condition: { comparison: 2, lower: 6000, upper: 0 }, days: [3, 3.01],
      source: { sourceName: "Regional wind report", sourceUrl: "https://example.org/wind/waglan.txt", procedure: "Read the highest gust in the window from the report." },
      document: "Waglan Island\nPeak gust: 48.27 km/h\n",
    },
  ];

  for (const item of matrix) {
    it(`registers, trades, proposes from a document, settles and pays: ${item.name}`, async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const metricId = await register(f, item.metric);
      const now = await time.latest();
      const times = windowMarketTimes({
        openAt: now + 60, observationStart: now + Math.round(item.days[0]! * 86_400), observationEnd: now + Math.round(item.days[1]! * 86_400), plan: PLAN,
      });
      const created = await createMarket(f, metricId, item.condition, times, { sourceId: "CUSTOM_SOURCE", subjectId: item.metric.definition.code },
        (context) => buildCustomNumericRules({ title: item.name, ...item.source, metricRulesDocument: item.metric.rulesDocument }, context as never));
      await time.increaseTo(times.openAt);
      await (await f.market.connect(f.alice).bet(created.id, 1, { value: 3n * MIN })).wait();
      await (await f.market.connect(f.bob).bet(created.id, 2, { value: 2n * MIN })).wait();
      await expect(f.market.connect(f.proposer).bet(created.id, 1, { value: MIN })).to.be.revertedWithCustomError(f.market, "ProposerCannotBet");

      await time.increaseTo(times.observationEnd + 30);
      const capturedAt = await time.latest();
      await time.increase(5);
      const proposal = buildCustomNumericProposal({ rawBytes: toUtf8Bytes(item.document), reading: item.reading, capturedAt },
        { rulesDocument: created.document, expected: await chainExpectation(f, created.id), chainTimestamp: await time.latest() });
      expect(await proposeAndSettle(f, created.id, proposal)).to.equal(item.outcome);
      expect((await f.market.getMarketState(created.id)).terminal).to.equal(item.outcome);
      const [winner, loser] = item.outcome === 1n ? [f.alice, f.bob] : [f.bob, f.alice];
      expect(await f.market.claimable(created.id, loser)).to.equal(0n);
      await expect(f.market.connect(winner).claim(created.id)).to.changeEtherBalances(ethers, [f.market, winner], [-5n * MIN, 5n * MIN]);
    });
  }

  it("reads an HKO Daily Extract field automatically from the monthly file", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const field = HKO_DAILY_EXTRACT_FIELDS.find((entry) => entry.key === "mean-humidity")!;
    const metricId = await register(f, field.metric);
    const now = await time.latest();
    const day = new Date((now + 8 * 3_600 + 3 * 86_400) * 1000);
    const date = day.toISOString().slice(0, 10).replaceAll("-", "");
    const times = hkDayMarketTimes({ openAt: now + 60, targetDate: date, plan: { ...PLAN, proposalWindow: 7 * 86_400 } });
    const created = await createMarket(f, metricId, { comparison: 5, lower: 7000, upper: 8500 }, times, { sourceId: "HKO_DAILY_EXTRACT", subjectId: "HKO" },
      (context) => buildHkoFieldNumericRules({ title: `Mean humidity 70-85 % on ${date}`, targetDate: date }, context as never));
    await time.increaseTo(times.openAt);
    await (await f.market.connect(f.alice).bet(created.id, 1, { value: MIN })).wait();
    await (await f.market.connect(f.bob).bet(created.id, 2, { value: MIN })).wait();
    await time.increaseTo(times.observationEnd + 3_600);
    const dd = date.slice(6, 8);
    const monthly = JSON.stringify({ stn: { data: [{ month: Number(date.slice(4, 6)), dayData: [[dd, "1016.0", "24.1", "21.9", "20.3", "15.2", "78", "40", "  0.0"]] }] } });
    const fetchedAt = new Date((await time.latest()) * 1000).toISOString();
    await time.increase(5);
    const proposal = buildHkoFieldProposal(
      { bytes: toUtf8Bytes(monthly), sourceURL: dailyExtractMonthUrl(date), fetchedAt, httpStatus: 200, contentType: "text/xml; charset=utf-8", lastModified: null },
      { rulesDocument: created.document, expected: await chainExpectation(f, created.id), chainTimestamp: await time.latest() },
    );
    expect(proposal.reading).to.deep.equal({ kind: 1, value: 7800 });
    expect(await proposeAndSettle(f, created.id, proposal)).to.equal(1n);
    await expect(f.market.connect(f.alice).claim(created.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-2n * MIN, 2n * MIN]);
  });
});
