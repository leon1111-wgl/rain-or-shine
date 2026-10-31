// @vitest-environment node
// Pure interface helpers: strict ETH input and fixed-decimal figures, routes, Hong Kong time, market figures from
// the bet history, filter counts, date search and starred events.
import { describe, expect, it } from "vitest";
import { setActiveLocale, t } from "../../web/src/i18n";
import type { ActivityItem } from "../../web/src/lib/activity";
import { MIN_BET_WEI, formatEth, formatEthFixed, formatEthSigned, parseBetAmount, parseEthInput, stakeShare } from "../../web/src/lib/amount";
import { heroMarket, introFigures, kindSummary } from "../../web/src/lib/landing";
import { dailyVolume, flashTone, marketStats, marketTotals, matchesDate, positionsOf, viewCounts } from "../../web/src/lib/market";
import type { MarketData } from "../../web/src/lib/markets";
import { href, parseRoute } from "../../web/src/lib/routes";
import { isStarred, readStars, starKey, toggleStar, writeStars } from "../../web/src/lib/stars";
import { countdownTone, formatDuration, formatHktMinute, formatHktMinuteBare } from "../../web/src/lib/time";
import { localizeChainMessage } from "../../web/src/lib/chainErrors";

describe("ETH amounts", () => {
  it("parses strict decimal strings to exact wei", () => {
    expect(parseEthInput("0.010")).toEqual({ ok: true, value: 10n ** 16n });
    expect(parseEthInput(" 1 ")).toEqual({ ok: true, value: 10n ** 18n });
    expect(parseEthInput("0.000000000000000001")).toEqual({ ok: true, value: 1n });
  });

  it("rejects exponents, signs, NaN, empty, separators and more than 18 decimals", () => {
    for (const bad of ["1e-3", "1E3", "-0.01", "+1", "NaN", "Infinity", "", "  ", ".5", "5.", "0x10", "1,5", "01.0", "1.0000000000000000001"]) {
      expect(parseEthInput(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("requires at least 0.001 ETH for a bet, as the contract does", () => {
    expect(parseBetAmount("0.0009").ok).toBe(false);
    expect(parseBetAmount("0.001")).toEqual({ ok: true, value: MIN_BET_WEI });
  });

  it("formats wei without floating point, with exactly three decimals in columns", () => {
    expect([formatEth(10n ** 16n), formatEth(25n * 10n ** 15n), formatEth(1n, 18, 3), formatEthSigned(2n * 10n ** 16n), formatEthSigned(-(2n * 10n ** 16n))]).toEqual(["0.010", "0.025", "0.000000000000000001", "+0.020", "−0.020"]);
    expect([formatEthFixed(0n), formatEthFixed(10n ** 18n), formatEthFixed(123_456_789n * 10n ** 9n), formatEthFixed(15n * 10n ** 14n)]).toEqual(["0.000", "1.000", "0.123", "0.001"]);
    expect([stakeShare(1n, 4n), stakeShare(0n, 0n)]).toEqual([25, 50]);
  });
});

describe("routes and time", () => {
  it("parses the landing page, the five views, the market views and the operations page", () => {
    expect(parseRoute("")).toEqual({ page: "landing" });
    expect(parseRoute("#/markets")).toEqual({ page: "list", tab: "markets" });
    expect(parseRoute("#/markets/ranks")).toEqual({ page: "list", tab: "ranks" });
    expect(parseRoute("#/markets/data")).toEqual({ page: "list", tab: "data" });
    expect(href.tab("data")).toBe("#/markets/data");
    expect(parseRoute("#/mine")).toEqual({ page: "mine" });
    expect(parseRoute("#/market/12")).toEqual({ page: "market", id: 12, view: "detail" });
    expect(parseRoute("#/market/12/waiting")).toEqual({ page: "market", id: 12, view: "waiting" });
    expect(parseRoute("#/market/12/settlement")).toEqual({ page: "market", id: 12, view: "settlement" });
    expect(parseRoute("#/waiting")).toEqual({ page: "pick", view: "waiting" });
    expect(parseRoute("#/ops/3")).toEqual({ page: "ops", id: 3 });
    for (const bad of ["#/market/0", "#/market/-1", "#/market/1x", "#/market/0x12"]) expect(parseRoute(bad).page, bad).toBe("not-found");
    expect(href.market(7, "settlement")).toBe("#/market/7/settlement");
  });

  it("shows Hong Kong time independent of the host timezone", () => {
    expect(formatHktMinute(1_791_216_000n)).toBe("2026-10-06 00:00 HKT");
    expect(formatHktMinuteBare(1_791_216_000n)).toBe("2026-10-06 00:00");
  });

  it("never shows a trailing zero unit (2 小时, not 2 小时 0 分)", () => {
    setActiveLocale("zh-CN");
    expect([7_200n, 7_260n, 604_800n, 612_000n, 120n, 125n, 59n].map(formatDuration)).toEqual(["2 小时", "2 小时 1 分", "7 天", "7 天 2 小时", "2 分钟", "2 分 5 秒", "59 秒"]);
    setActiveLocale("en");
  });
});

describe("market figures", () => {
  const E = (milli: number) => BigInt(milli) * 10n ** 15n;
  const now = 1_800_000_000;
  const bet = (account: string, side: "YES" | "NO", milli: number, stake: number, yes: number, no: number, at: number): ActivityItem => ({
    market: 1, kind: stake === milli ? "BET" : "TOP_UP", account, side, amount: E(milli), stake: E(stake), yesTotal: E(yes), noTotal: E(no), logIndex: 0, txHash: `0x${at}`, timestamp: at,
  });
  const items = [
    bet("0xa", "YES", 10, 10, 10, 0, now - 30 * 3_600),
    bet("0xb", "NO", 30, 30, 10, 30, now - 25 * 3_600),
    bet("0xa", "YES", 20, 30, 30, 30, now - 2 * 3_600),
    bet("0xc", "NO", 20, 20, 30, 50, now - 3_600),
  ];
  const market = { id: 1, yesTotal: E(30), noTotal: E(50), total: E(80), paidOut: 0n, yesAccounts: 1, noAccounts: 2 } as unknown as MarketData;

  it("Yes share now, its change against 24 h ago, 24 h volume and the trend come from the bets", () => {
    const s = marketStats(market, items, now);
    expect(s.share).toBe(37.5);
    expect(s.change).toBe(12.5); // 25 % after the bet 25 h ago -> 37.5 % now
    expect([s.volume, s.trades]).toEqual([E(40), 2]);
    expect(s.spark).toEqual([100, 25, 50, 37.5]);
    expect(marketStats({ ...market, yesTotal: 0n, noTotal: 0n, total: 0n }, [], now)).toMatchObject({ share: null, change: null, volume: 0n });
    // Younger than a day: the change runs from the share after its first bet (100 % Yes) to the 37.5 % now.
    const young = items.slice(2).map((b, i) => (i === 0 ? { ...b, kind: "BET" as const, yesTotal: E(20), noTotal: 0n } : b));
    expect(marketStats(market, young, now).change).toBe(-62.5);
  });

  it("positions are each account's last cumulative stake per side, largest first", () => {
    const { yes, no } = positionsOf(items);
    expect(yes.map((p) => [p.account, p.stake])).toEqual([["0xa", E(30)]]);
    expect(no.map((p) => [p.account, p.stake])).toEqual([["0xb", E(30)], ["0xc", E(20)]]);
  });

  it("groups by Hong Kong day, keeps empty days and counts each address once", () => {
    const days = dailyVolume(items, 3, now);
    expect(days.map((d) => d.day)).toEqual(["2027-01-13", "2027-01-14", "2027-01-15"]);
    expect(days.map((d) => [d.yes, d.no, d.trades, d.accounts])).toEqual([[0n, 0n, 0, 0], [E(10), E(30), 2, 2], [E(20), E(20), 2, 2]]);
    expect(marketTotals([market], items, now)).toEqual({ volume: E(40), trades: 2, staked: E(80), paid: 0n, accounts: 3 });
  });
});

describe("filter counts, date search and starred events", () => {
  const market = (targetDate: string, openAt: bigint, closeAt: bigint) =>
    ({ targetDate, times: { openAt, closeAt, observationStart: closeAt, observationEnd: closeAt + 86_400n, earliestAssertionAt: closeAt + 86_400n, proposalCutoff: closeAt + 2n * 86_400n, refundAt: closeAt + 4n * 86_400n, assertionLiveness: 7_200n }, terminal: "UNRESOLVED", effective: "UNRESOLVED", refundReason: "NONE", assertion: null, uma: null, total: 0n, yesTotal: 0n, noTotal: 0n }) as unknown as MarketData;

  it("counts every market once per chip from its phase at `now`", () => {
    const now = 1_000_000n;
    const markets = [market("20261103", now - 10n, now + 10n), market("20261104", now + 100n, now + 200n), market("20261105", now - 300n, now - 200n)];
    expect(viewCounts(markets, now)).toEqual({ all: 3, detail: 2, waiting: 1, settlement: 0 });
  });

  it("matches dates by their digits in any common spelling, and everything when blank", () => {
    const m = market("20261103", 0n, 1n);
    expect(["", "  ", "11-03", "2026-11-03", "1103", "11/03", "03"].map((q) => matchesDate(m, q))).toEqual([true, true, true, true, true, true, true]);
    expect(["11-04", "2025", "abc"].map((q) => matchesDate(m, q))).toEqual([false, false, false]);
  });

  it("keeps stars per contract and market, tolerates blocked or malformed storage, and never throws", () => {
    const contract = `0x${"aB".repeat(20)}`;
    const a = starKey(contract, 1);
    const b = starKey(contract, 2);
    expect(a).toBe(`0x${"ab".repeat(20)}#1`);
    expect(toggleStar([], a)).toEqual([a]);
    expect(toggleStar(toggleStar([], a), a)).toEqual([]);
    expect(isStarred(toggleStar([], a), a.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isStarred(toggleStar([], a), starKey(`0x${"cd".repeat(20)}`, 1))).toBe(false);
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_k: string, v: string) => void (stored = v) };
    writeStars(toggleStar([], b), storage);
    expect(readStars(storage)).toEqual([b]);
    stored = '{"not": "a list"}';
    expect(readStars(storage)).toEqual([]);
    stored = '["0xnot-a-key", 5, "0x' + "ab".repeat(20) + '"]';
    expect(readStars(storage)).toEqual([]);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readStars(blocked)).toEqual([]);
    expect(() => writeStars([a], blocked)).not.toThrow();
    expect(readStars(undefined)).toEqual([]);
  });
});

describe("live feel", () => {
  it("colours a countdown amber under one hour and red under ten minutes, exactly at the boundaries", () => {
    expect([7_200n, 3_600n, 3_599n, 600n, 599n, 0n, -5n].map(countdownTone)).toEqual(["", "", "soon", "soon", "urgent", "urgent", "urgent"]);
  });

  it("flashes a row green when Yes grew more than No, red otherwise, and not at all when nothing changed", () => {
    const at = (yes: number, no: number) => ({ yes: BigInt(yes), no: BigInt(no) });
    expect(flashTone(at(1, 1), at(1, 1))).toBeNull();
    expect(flashTone(at(1, 1), at(3, 1))).toBe("up");
    expect(flashTone(at(1, 1), at(1, 3))).toBe("down");
    expect(flashTone(at(1, 1), at(2, 2))).toBe("down");
    expect(flashTone(at(5, 5), at(5, 4))).toBe("up");
  });
});

describe("intro figures", () => {
  const E = (milli: number) => BigInt(milli) * 10n ** 15n;
  const now = 1_000_000n;
  const m = (id: number, code: string, openAt: bigint, closeAt: bigint, total: number) =>
    ({ id, metric: { code }, official: code === "TOTAL_RAINFALL" || code === "DAILY_MAX_TEMPERATURE", subject: code === "DAILY_MEAN_HUMIDITY" ? { kind: "CUSTOM", targetDate: "20261105" } : { kind: "HKO", targetDate: "20261105" }, total: E(total), yesTotal: 0n, noTotal: E(total), times: { openAt, closeAt, observationStart: closeAt, observationEnd: closeAt + 86_400n, earliestAssertionAt: closeAt + 86_400n, proposalCutoff: closeAt + 2n * 86_400n, refundAt: closeAt + 3n * 86_400n, assertionLiveness: 7_200n }, terminal: "UNRESOLVED", effective: "UNRESOLVED", assertion: null, uma: null }) as unknown as MarketData;
  const markets = [m(1, "TOTAL_RAINFALL", now - 10n, now + 500n, 5), m(2, "TOTAL_RAINFALL", now - 10n, now + 100n, 9), m(3, "DAILY_MAX_TEMPERATURE", now + 50n, now + 900n, 0)];
  const bet = (market: number, account: string) => ({ market, account, amount: E(1) }) as unknown as ActivityItem;

  it("counts open markets, all stakes, bets and distinct addresses", () => {
    expect(introFigures(markets, [bet(1, "0xA"), bet(2, "0xa"), bet(2, "0xB")], now)).toEqual({ open: 2, staked: E(14), bets: 3, accounts: 2 });
  });

  it("puts the busiest open market in the hero, else the next to open, else none", () => {
    expect(heroMarket(markets, now)?.id).toBe(2);
    expect(heroMarket([markets[2]!], now)?.id).toBe(3);
    expect(heroMarket([], now)).toBeUndefined();
  });

  it("breaks a tie in stakes by the number of accounts, then by the sooner close", () => {
    const tie = (id: number, accounts: number, closeAt: bigint) => ({ ...m(id, "TOTAL_RAINFALL", now - 10n, closeAt, 2), yesAccounts: accounts, noAccounts: 0 }) as MarketData;
    expect(heroMarket([tie(1, 1, now + 100n), tie(2, 2, now + 500n)], now)?.id).toBe(2);
    expect(heroMarket([tie(1, 1, now + 500n), tie(2, 1, now + 100n)], now)?.id).toBe(2);
  });

  it("summarises each kind with its soonest close among open markets", () => {
    expect(kindSummary(markets, "rain", now)).toEqual({ markets: 2, open: 2, staked: E(14), nextClose: now + 100n });
    expect(kindSummary(markets, "heat", now)).toEqual({ markets: 1, open: 0, staked: 0n, nextClose: null });
    // Custom markets have their own card, whatever weather type their metric has.
    const humidity = m(4, "DAILY_MEAN_HUMIDITY", now - 10n, now + 300n, 2);
    expect(kindSummary([...markets, humidity], "custom", now)).toEqual({ markets: 1, open: 1, staked: E(2), nextClose: now + 300n });
    expect(kindSummary([...markets, humidity], "rain", now).markets).toBe(2);
  });
});

describe("chain error hints", () => {
  it("names the hardened contract's refusals in the interface language and keeps other details", () => {
    expect(localizeChainMessage("ProposerCannotBet")).toBe(t("chainError.proposerCannotBet"));
    expect(localizeChainMessage("ThresholdStepMismatch")).toBe(t("chainError.thresholdStep"));
    expect(localizeChainMessage("Invalid market configuration (settlement buffer)")).toBe(t("chainError.settleBuffer"));
    expect(localizeChainMessage("Invalid market configuration (assertion liveness)")).toBe(t("chainError.livenessTooShort"));
    expect(localizeChainMessage("Invalid market configuration (time order)")).toBe(`${t("chainError.invalidMarket")} (time order)`);
  });
});
