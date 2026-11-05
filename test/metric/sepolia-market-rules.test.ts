import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeBytes32String, keccak256, toUtf8Bytes } from "ethers";
import { assertCustomNumericProfile, isCustomNumericRules } from "../../src/metric/custom-profile.js";
import { NUMERIC_METRIC_PRESETS, assertHkoNumericProfile, buildHkoNumericRules, isOfficialMetric } from "../../src/metric/numeric-profiles.js";
import { assertNumericMarketRulesMatchChain, type NumericRulesContext } from "../../src/metric/numeric-rules.js";

interface FixtureMarket {
  marketId: number;
  title: string;
  targetDate: string;
  rulesHashStart: string;
  proposer: string;
  source: string;
  subject: string;
  condition: NumericRulesContext["config"]["condition"];
  times: NumericRulesContext["config"]["times"];
  metricId: number;
  metric: Omit<NumericRulesContext["metric"], "rulesHash">;
}
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/sepolia/market-rules.json", import.meta.url), "utf8")) as {
  predictionMarket: string; markets: FixtureMarket[];
};

function contextOf(market: FixtureMarket): NumericRulesContext {
  const preset = NUMERIC_METRIC_PRESETS.find((entry) => entry.code === market.metric.code);
  if (!preset) throw new Error(`No preset for ${market.metric.code}`);
  return {
    config: {
      proposer: market.proposer, sourceId: encodeBytes32String(market.source), subjectId: encodeBytes32String(market.subject),
      condition: market.condition, times: market.times,
    },
    metricId: market.metricId,
    metric: { ...market.metric, code: encodeBytes32String(market.metric.code), unit: encodeBytes32String(market.metric.unit), rulesHash: preset.rulesHash },
  };
}

describe("Sepolia markets #1-#4", () => {
  it("are the four markets of the deployment", () => {
    expect(fixture.predictionMarket).toBe("0x668643AF961C4032909C1c15A741b6d2d6216e92");
    expect(fixture.markets.map((market) => market.marketId)).toEqual([1, 2, 3, 4]);
  });

  for (const market of fixture.markets) {
    it(`#${market.marketId} rebuilds the rules on chain and still validates`, () => {
      const context = contextOf(market);
      const document = buildHkoNumericRules({ title: market.title, targetDate: market.targetDate }, context);
      const marketRulesHash = keccak256(toUtf8Bytes(document));
      expect(marketRulesHash.slice(0, 10)).toBe(market.rulesHashStart);
      const rules = assertNumericMarketRulesMatchChain(document, { ...context, marketRulesHash });
      expect(assertHkoNumericProfile(rules).targetDate).toBe(market.targetDate);
      expect(isCustomNumericRules(rules)).toBe(false);
      expect(() => assertCustomNumericProfile(rules)).toThrow();
      expect(isOfficialMetric({ code: rules.metric.code, rulesHash: rules.metric.rulesHash })).toBe(true);
      expect(rules.metric.rulesDocument).toBe(NUMERIC_METRIC_PRESETS.find((entry) => entry.code === rules.metric.code)!.rulesDocument);
    });
  }
});
