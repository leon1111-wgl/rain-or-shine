// The rules of the Sepolia markets #1-#4, as their MarketCreated logs hold them (fixtures/sepolia/market-rules.json,
// captured read-only by scripts/capture-sepolia-market-rules.ts). Custom markets must not change how they validate:
// they still bind to their chain state, match the official HKO profile, and rebuild byte for byte from the presets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toUtf8Bytes } from "ethers";
import { assertCustomNumericProfile, isCustomNumericRules } from "../../src/metric/custom-profile.js";
import { NUMERIC_METRIC_PRESETS, assertHkoNumericProfile, buildHkoNumericRules, isOfficialMetric } from "../../src/metric/numeric-profiles.js";
import { assertNumericMarketRulesMatchChain, type NumericRulesChainExpectation } from "../../src/metric/numeric-rules.js";

interface FixtureMarket extends Omit<NumericRulesChainExpectation, "marketRulesHash"> {
  marketId: number;
  transactionHash: string;
  blockNumber: number;
  rulesHash: string;
  rulesDocument: string;
}
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/sepolia/market-rules.json", import.meta.url), "utf8")) as {
  predictionMarket: string; readAtBlock: number; markets: FixtureMarket[];
};

describe("Sepolia markets #1-#4", () => {
  it("are the four markets of the hardened deployment", () => {
    expect(fixture.predictionMarket).toBe("0x668643AF961C4032909C1c15A741b6d2d6216e92");
    expect(fixture.markets.map((market) => market.marketId)).toEqual([1, 2, 3, 4]);
  });

  for (const market of fixture.markets) {
    it(`#${market.marketId} still validates and rebuilds byte for byte`, () => {
      expect(keccak256(toUtf8Bytes(market.rulesDocument))).toBe(market.rulesHash);
      const expected: NumericRulesChainExpectation = { config: market.config, metricId: market.metricId, metric: market.metric, marketRulesHash: market.rulesHash };
      const rules = assertNumericMarketRulesMatchChain(market.rulesDocument, expected);
      const profile = assertHkoNumericProfile(rules);
      expect(isCustomNumericRules(rules)).toBe(false);
      expect(() => assertCustomNumericProfile(rules)).toThrow();
      expect(isOfficialMetric({ code: rules.metric.code, rulesHash: rules.metric.rulesHash })).toBe(true);
      const preset = NUMERIC_METRIC_PRESETS.find((entry) => entry.code === rules.metric.code)!;
      expect(rules.metric.rulesDocument).toBe(preset.rulesDocument);
      const rebuilt = buildHkoNumericRules({ title: rules.title, targetDate: profile.targetDate }, { config: market.config, metricId: market.metricId, metric: market.metric });
      expect(rebuilt).toBe(market.rulesDocument);
    });
  }
});
