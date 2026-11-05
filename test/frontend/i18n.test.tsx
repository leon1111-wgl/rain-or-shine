import { describe, expect, it } from "vitest";
import { CATALOGS, DEFAULT_LOCALE, LOCALES, readStoredLocale, setActiveLocale, t, tSegments } from "../../web/src/i18n";
import { zhCN } from "../../web/src/i18n/zh-CN";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translation catalogs", () => {
  it("defaults to Simplified Chinese and offers English", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(readStoredLocale()).toBe("zh-CN");
    expect(LOCALES.map((l) => l.code)).toEqual(["zh-CN", "en"]);
  });

  for (const { code } of LOCALES) {
    it(`${code} defines every key, never empty, with the reference placeholders`, () => {
      const catalog = CATALOGS[code];
      for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
        expect(catalog[key], key).toBeTruthy();
        expect(placeholders(catalog[key]), key).toEqual(placeholders(zhCN[key]));
      }
    });
  }

  it("never uses AMM, share-trading or mUSDC vocabulary in the user interface", () => {
    for (const { code } of LOCALES) {
      const text = Object.values(CATALOGS[code]).join("\n");
      expect(text, code).not.toMatch(/mUSDC|\bAMM\b|liquidity provider|份额交易所|买入份额|卖出份额|\bLP\b/);
    }
  });

  it("fills placeholders in the active language", () => {
    setActiveLocale("zh-CN");
    expect(t("q.rain", { date: "11月3日", cond: "≥ 1.0 毫米" })).toBe("11月3日 天文台总部降雨量 ≥ 1.0 毫米？");
    setActiveLocale("en");
    expect(t("q.rain", { date: "3 Nov", cond: "≥ 1.0 mm" })).toBe("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?");
  });

  it("joins no meta strings with a middle dot and appends no arrows", () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const [key, text] of Object.entries(catalog)) {
        expect(text, `${code} ${key}`).not.toMatch(/·|→/);
      }
    }
  });

  it("segments give exactly the text of t() and mark each filled value, so it can be kept on one line", () => {
    const params = { from: "2026-10-05 00:00", to: "2026-10-06 00:00 HKT" };
    const segments = tSegments("rule.dateWindow", params);
    expect(segments.map((s) => s.text).join("")).toBe(t("rule.dateWindow", params));
    expect(segments.filter((s) => s.param).map((s) => [s.param, s.text])).toEqual([["from", params.from], ["to", params.to]]);
    expect(tSegments("table.accounts", {}).map((s) => s.text).join("")).toBe(t("table.accounts"));
  });
});
