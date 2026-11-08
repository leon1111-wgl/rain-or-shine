import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZeroAddress, ZeroHash, encodeBytes32String, keccak256, toUtf8Bytes, type ContractTransactionResponse, type JsonRpcSigner } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules, buildSportsNumericRules } from "../../src/metric/numeric-profiles";
import { payoutIfWins } from "../../src/metric/payout";
import { setActiveLocale } from "../../web/src/i18n";
import { HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument, identifierFromText } from "../../src/metric/custom-profile";
import { hkDayMarketTimes, windowMarketTimes } from "../../src/metric/market-times";
import { hkDayWindow } from "../../src/weather/profile";
import type { Dashboard, MarketView } from "../../web/src/metric/client";
import type { useMetricApp } from "../../web/src/metric/context";

type MetricApi = ReturnType<typeof useMetricApp>;
const mocks = vi.hoisted(() => ({
  useMetricApp: vi.fn(),
  marketOf: vi.fn(),
  assertOracleSubmissionSupported: vi.fn(),
  run: vi.fn(),
  now: 0n,
  evidence: null as null | { txHash: string; bond: bigint; proposer: string; sourceUrl: string; rawSha256: string; capturedAt: bigint; excerpt: string },
  trades: [] as Array<{ transactionHash: string; logIndex: number; account: string; side: 1 | 2; amount: bigint; timestamp: number }>,
}));
vi.mock("../../web/src/metric/context", () => ({ useMetricApp: mocks.useMetricApp, downloadText: vi.fn() }));
vi.mock("../../web/src/hooks/useApp", () => ({ useApp: () => ({ ...mocks.useMetricApp(), now: mocks.now }), useNow: () => mocks.now }));
vi.mock("../../web/src/hooks/useWallet", () => ({
  useWallet: () => ({ status: "connected", account: ACCOUNT, chainId: 31337, targetChainId: 31337, isCorrectChain: true, epoch: 1, error: null, connect: vi.fn(), switchChain: vi.fn(), getSigner: async () => signer }),
}));
vi.mock("../../web/src/metric/client", async (original) => ({ ...(await original<typeof import("../../web/src/metric/client")>()), marketOf: mocks.marketOf, assertOracleSubmissionSupported: mocks.assertOracleSubmissionSupported }));
vi.mock("../../web/src/metric/activity", () => ({ readMarketActivity: async () => ({ blockNumber: 1, blockHash: "0x1", holders: [], trades: mocks.trades }) }));
vi.mock("../../web/src/lib/records", () => ({ loadClaims: async () => new Map(), loadEvidence: async () => mocks.evidence }));
vi.mock("../../web/src/lib/hko", () => ({ hkoLangOf: () => "en", loadHkoLive: () => new Promise(() => undefined) }));

import { BetPanel } from "../../web/src/components/BetPanel";
import { formatEth } from "../../web/src/lib/amount";
import { toMarketData } from "../../web/src/lib/markets";
import { LandingPage } from "../../web/src/pages/Landing";
import { MarketDetailPage } from "../../web/src/pages/MarketDetail";
import { MarketsPage } from "../../web/src/pages/Markets";
import { SettlementPage } from "../../web/src/pages/Settlement";
import { WaitingPage } from "../../web/src/pages/Waiting";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const PROPOSER = "0x00000000000000000000000000000000000000b2";
const signer = { getAddress: async () => ACCOUNT } as JsonRpcSigner;
const tx = { hash: `0x${"12".repeat(32)}` } as ContractTransactionResponse;
const local = { environment: "LOCAL_MOCK", chainId: 31337, contracts: { PredictionMarket: { address: `0x${"11".repeat(20)}` }, UmaMetricOracleAdapter: { address: `0x${"22".repeat(20)}` } }, oracle: { bondDecimals: 6, bondSymbol: "tBOND", policyBond: "10000000" } };
const toBig = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));

function view(id: number, code: string, opts: { date?: string; yes?: bigint; no?: bigint; side?: bigint; stake?: bigint; effective?: bigint; reason?: bigint; claimable?: bigint; proposer?: string; asserted?: boolean; rejected?: boolean } = {}): MarketView {
  const preset = NUMERIC_METRIC_PRESETS.find((p) => p.code === code)!;
  const date = opts.date ?? "20261103";
  const window = hkDayWindow(date);
  const end = Number(window.end);
  const times = { openAt: Number(window.start) - 86_400, closeAt: Number(window.start) - 60, observationStart: Number(window.start), observationEnd: end, earliestAssertionAt: end, proposalCutoff: end + 3_600, refundAt: end + 3_600 + 120 + 3_600, assertionLiveness: 120 };
  const config = { proposer: opts.proposer ?? PROPOSER, sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"), subjectId: encodeBytes32String("HKO"), condition: { metricId: id, comparison: 4, lower: 100, upper: 0 }, times };
  const metric = { code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit), minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash };
  const rules = buildHkoNumericRules({ title: "t", targetDate: date }, { config, metricId: id, metric });
  const yes = opts.yes ?? 0n;
  const no = opts.no ?? 0n;
  return {
    id, config: { ...config, condition: toBig(config.condition), times: toBig(times) },
    state: { yesTotal: yes, noTotal: no, paidOut: 0n, yesAccounts: yes ? 1n : 0n, noAccounts: no ? 1n : 0n, terminal: 0n, refundReason: 0n },
    metric: { ...preset, id }, rulesDocument: rules, rulesHash: keccak256(toUtf8Bytes(rules)), title: "t",
    position: { side: opts.side ?? 0n, stake: opts.stake ?? 0n, claimed: false }, claimable: opts.claimable ?? 0n,
    assertion: opts.asserted || opts.rejected
      ? { assertionId: `0x${"ab".repeat(32)}`, reading: { kind: 1n, value: 120n }, rawSha256: ZeroHash, proposedAt: BigInt(end + 60), disputed: false, returned: opts.rejected ?? false, rejected: opts.rejected ?? false }
      : { assertionId: ZeroHash, reading: { kind: 0n, value: 0n }, rawSha256: ZeroHash, proposedAt: 0n, disputed: false, returned: false, rejected: false },
    oracleAssertion: opts.asserted ? { expirationTime: BigInt(end + 180), settled: false, disputer: ZeroAddress, bond: 10_000_000n, asserter: PROPOSER } : undefined,
    effectiveTerminal: opts.effective ?? 0n, effectiveRefundReason: opts.reason ?? 0n, mockResolutionReady: false,
  } as unknown as MarketView;
}

function sportsView(id: number, yes: bigint, no: bigint): MarketView {
  const preset = NUMERIC_METRIC_PRESETS.find((p) => p.code === "SCORE_MARGIN")!;
  const start = Number(hkDayWindow("20261104").start) + 19.5 * 3_600;
  const times = windowMarketTimes({ openAt: start - 3 * 86_400, observationStart: start, observationEnd: start + 9_000, plan: { proposalWindow: 3_600, assertionLiveness: 120, refundBuffer: 3_600 } });
  const config = { proposer: PROPOSER, sourceId: encodeBytes32String("DEMO_BASKETBALL"), subjectId: encodeBytes32String("LAL_BOS_DEMO01"), condition: { metricId: id, comparison: 3, lower: 0, upper: 0 }, times };
  const metric = { code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit), minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash };
  const rules = buildSportsNumericRules({ title: "t", sport: "BASKETBALL", matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" }, { config, metricId: id, metric });
  const base = view(id, "TOTAL_RAINFALL", { yes, no });
  return { ...base, config: { ...config, condition: toBig(config.condition), times: toBig({ ...times }) }, metric: { ...preset, id }, rulesDocument: rules, rulesHash: keccak256(toUtf8Bytes(rules)) } as unknown as MarketView;
}

function customSourceView(id: number, sourceUrl: string): MarketView {
  const metric = customMetricRulesDocument({
    code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50_000, maxValue: 50_000, valueStep: 100, allowsTrace: false,
    interpretation: "Change in mean sea-level pressure at HKO headquarters over the observation window, in hPa.",
  });
  const source = { sourceName: "Hourly pressure log", sourceUrl, procedure: "Subtract the first hourly pressure in the window from the last one." };
  const day = hkDayWindow("20261103");
  const times = windowMarketTimes({ openAt: Number(day.start) - 86_400, observationStart: Number(day.start), observationEnd: Number(day.end), plan: { proposalWindow: 3_600, assertionLiveness: 120, refundBuffer: 3_600 } });
  const config = { proposer: PROPOSER, sourceId: encodeBytes32String(identifierFromText(source.sourceName, "CUSTOM_SOURCE")), subjectId: encodeBytes32String(metric.definition.code), condition: { metricId: id, comparison: 4, lower: 100, upper: 0 }, times };
  const chainMetric = { ...metric.definition, code: encodeBytes32String(metric.definition.code), unit: encodeBytes32String(metric.definition.unit), rulesHash: metric.rulesHash };
  const rulesDocument = buildCustomNumericRules({ title: "t", ...source, metricRulesDocument: metric.rulesDocument }, { config, metricId: id, metric: chainMetric });
  const base = view(id, "TOTAL_RAINFALL", { yes: 10n ** 15n, no: 10n ** 15n });
  return {
    ...base, rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)),
    config: { ...config, condition: toBig(config.condition), times: toBig({ ...times }) },
    metric: { id, ...metric.definition, rulesHash: metric.rulesHash },
  } as unknown as MarketView;
}

let app: MetricApi;
function useApp(markets: MarketView[], dep: object = local) {
  const data = { now: Number(mocks.now), blockNumber: 1, metrics: [], markets, bondBalance: 0n, bondAmount: 0n } as unknown as Dashboard;
  app = {
    dep, data, fault: "", busy: false, ready: true, canWrite: true, isAdmin: false, message: "", txHash: "",
    wallet: { account: ACCOUNT, chainId: 31337, epoch: 1 },
    reader: { getBalance: async () => 10n ** 20n, getFeeData: async () => ({ maxFeePerGas: 1n, gasPrice: 1n }) },
    run: mocks.run, refresh: vi.fn(), action: vi.fn(),
  } as unknown as MetricApi;
  mocks.useMetricApp.mockImplementation(() => app);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trades = [];
  mocks.evidence = null;
  mocks.now = BigInt(Number(hkDayWindow("20261103").start) - 3_600);
  mocks.run.mockImplementation(async (_label: string, send: (s: JsonRpcSigner) => Promise<unknown>) => {
    await send(signer);
    return true;
  });
});

describe("bet ticket", () => {
  it("sends the selected No side with the exact amount through the client's runner", async () => {
    const bet = Object.assign(vi.fn(async () => tx), { estimateGas: vi.fn(async () => 100_000n) });
    mocks.marketOf.mockReturnValue({ bet });
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103" });
    useApp([v]);
    render(<BetPanel market={toMarketData(local as never, v)} />);
    await userEvent.click(screen.getByTestId("side-NO"));
    const input = screen.getByTestId("amount");
    await userEvent.clear(input);
    await userEvent.type(input, "0.0123");
    await userEvent.click(screen.getByTestId("bet-submit"));
    await userEvent.click(await screen.findByTestId("bet-confirm"));
    await waitFor(() => expect(bet).toHaveBeenCalledWith(1, 2, { value: 12_300_000_000_000_000n }));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("keeps an existing No position locked and blocks invalid or below-minimum amounts", async () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", no: 10n ** 15n, side: 2n, stake: 10n ** 15n });
    useApp([v]);
    render(<BetPanel market={toMarketData(local as never, v)} />);
    expect(screen.getByTestId("side-YES")).toBeDisabled();
    expect(screen.getByTestId("side-NO")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("side-lock")).toHaveTextContent("NO");
    const input = screen.getByTestId("amount");
    for (const value of ["invalid", "-1", "0.0001"]) {
      await userEvent.clear(input);
      await userEvent.type(input, value);
      expect(screen.getByTestId("bet-submit")).toBeDisabled();
    }
    await userEvent.clear(input);
    await userEvent.type(input, "0.001");
    expect(screen.getByTestId("bet-submit")).toBeEnabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("estimates what the picked side pays from the current totals plus this bet, with the contract's formula", async () => {
    const bet = Object.assign(vi.fn(async () => tx), { estimateGas: vi.fn(async () => 100_000n) });
    mocks.marketOf.mockReturnValue({ bet });
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 3n * 10n ** 15n, no: 10n ** 15n });
    useApp([v]);
    render(<BetPanel market={toMarketData(local as never, v)} />);
    await userEvent.click(screen.getByTestId("side-YES"));
    const expected = `${formatEth(payoutIfWins({ yesTotal: 3n * 10n ** 15n, noTotal: 10n ** 15n, side: "YES", stake: 0n, add: 10n ** 16n }))} ETH`;
    expect(expected).toBe("0.010769 ETH");
    expect(screen.getByTestId("payout-estimate")).toHaveTextContent(expected);
    expect(screen.getByText(/If Yes wins, about/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("bet-submit"));
    expect(await screen.findByTestId("review-payout")).toHaveTextContent(expected);
    expect(screen.getByTestId("review-fee")).toHaveTextContent("None. Gas is separate.");
    expect(screen.getByTestId("bet-review")).toHaveTextContent("The estimate moves as other people bet.");
  });

  it("says the market refunds while nobody is on the other side, instead of an estimate", async () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 2n * 10n ** 15n });
    useApp([v]);
    render(<BetPanel market={toMarketData(local as never, v)} />);
    await userEvent.click(screen.getByTestId("side-YES"));
    expect(screen.getByTestId("payout-estimate")).toHaveTextContent("No one has taken No yet. If that holds at the close, the market refunds every stake.");
  });

  it("tells the market's proposer it cannot bet, before any wallet prompt", async () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", proposer: ACCOUNT });
    useApp([v]);
    render(<BetPanel market={toMarketData(local as never, v)} />);
    await userEvent.click(screen.getByTestId("side-YES"));
    expect(screen.getByTestId("bet-submit")).toBeDisabled();
    expect(screen.getByTestId("bet-submit")).toHaveTextContent("The proposer cannot bet");
    expect(screen.getByTestId("bet-proposer")).toHaveTextContent("designated proposer");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("rules fingerprint", () => {
  it("names the rules hash for what it proves, shortens it and keeps the whole value for copying", async () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 4n * 10n ** 15n, no: 10n ** 15n });
    useApp([v]);
    render(<MarketDetailPage id={1} />);
    await userEvent.click(await screen.findByTestId("detail-tab-doc"));
    const print = screen.getByTestId("rules-fingerprint");
    expect(print).toHaveTextContent(`${v.rulesHash.slice(0, 6)}…${v.rulesHash.slice(-4)}`);
    expect(print.querySelector("[title]")).toHaveAttribute("title", v.rulesHash);
    expect(screen.queryByText(v.rulesHash)).toBeNull();
    expect(screen.getByText("Rules fingerprint")).toBeInTheDocument();
  });
});

describe("rules", () => {
  it("lists the spec first: question, source, condition, close, day, results, deadline and what happens otherwise", async () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 4n * 10n ** 15n, no: 10n ** 15n });
    useApp([v]);
    render(<MarketDetailPage id={1} />);
    await userEvent.click(await screen.findByTestId("detail-tab-rules"));
    const labels = [...document.querySelectorAll(".rules-grid .rule > span")].map((label) => label.textContent);
    expect(labels.slice(0, 8)).toEqual([
      "Question", "Weather source", "Yes when", "Betting closes", "Observation day", "Results accepted", "Refund deadline", "Otherwise",
    ]);
    expect(screen.getByText("HKO publishes a day's data on the next working day, around 10:30. A dispute goes to UMA.")).toBeInTheDocument();
    expect(screen.getByText("Everyone is refunded")).toBeInTheDocument();
  });

  it("links a custom market's source only when it is a web address, and shows any other address as text", async () => {
    for (const [url, link] of [["https://example.org/pressure.csv", true], ["javascript:alert(document.domain)", false], ["data:text/html,<b>x</b>", false]] as const) {
      useApp([customSourceView(5, url)]);
      const { unmount } = render(<MarketDetailPage id={5} />);
      await userEvent.click(await screen.findByTestId("detail-tab-rules"));
      const source = screen.getByTestId("custom-source-url");
      expect(source).toHaveTextContent(url);
      if (link) expect(source).toHaveAttribute("href", url);
      else expect(source).not.toHaveAttribute("href");
      expect(document.querySelector('a[href^="javascript:" i], a[href^="data:" i]')).toBeNull();
      unmount();
    }
  });

  it("names a sports demo's synthetic source, match, scope and window, with a demo note", async () => {
    useApp([sportsView(4, 2n * 10n ** 15n, 10n ** 15n)]);
    render(<MarketDetailPage id={4} />);
    expect(document.querySelector(".market-list .list-name strong")).toHaveTextContent("4 Nov 19:30–22:00");
    await userEvent.click(await screen.findByTestId("detail-tab-rules"));
    const labels = [...document.querySelectorAll(".rules-grid .rule > span")].map((label) => label.textContent);
    expect(labels.slice(0, 5)).toEqual(["Question", "Data source", "Yes when", "Betting closes", "Observation window"]);
    expect(screen.getAllByText("LAL vs BOS: will the margin (LAL − BOS) be > 0 points?").length).toBeGreaterThan(0);
    expect(screen.getByText("LAL vs BOS, match LAL_BOS_DEMO01")).toBeInTheDocument();
    expect(screen.getByText("Overtime counts.")).toBeInTheDocument();
    expect(screen.getByTestId("demo-note")).toHaveTextContent("This is a demo market.");
    expect(screen.getAllByTestId("market-tag").map((tag) => tag.getAttribute("data-tag"))).toContain("demo");
  });

  it("reads the Yes share as the crowd's chance of Yes in one tip", async () => {
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 4n * 10n ** 15n, no: 10n ** 15n })]);
    render(<MarketDetailPage id={1} />);
    expect(await screen.findByRole("note", { name: /the crowd's chance of Yes/ })).toBeInTheDocument();
  });
});

describe("waiting", () => {
  it("says when HKO publishes, how long the proposer has, and that no result means a full refund", () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n, no: 10n ** 15n });
    mocks.now = v.config.times.observationEnd + 60n;
    useApp([v]);
    render(<WaitingPage id={1} />);
    expect(screen.getByTestId("late-data")).toHaveTextContent(/HKO publishes a day's data on the next working day, around 10:30\. The proposer can submit it until .+\. A dispute goes to UMA\. At .+, a market with no proposal, or a disputed one, refunds every stake\./);
  });

  it("after the refund deadline asks anyone to settle an undisputed result instead of offering a refund", () => {
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n, no: 10n ** 15n, asserted: true });
    mocks.now = v.config.times.refundAt + 60n;
    useApp([v]);
    render(<WaitingPage id={1} />);
    expect(screen.getByTestId("phase-explain")).toHaveTextContent("it must be settled first, and anyone can settle it");
    expect(screen.queryByTestId("claim")).toBeNull();
  });

  it("names the evidence hash a data fingerprint, shortened, with the whole value kept for copying", async () => {
    const rawSha256 = `0x${"5e".repeat(32)}`;
    mocks.evidence = { txHash: `0x${"77".repeat(32)}`, bond: 1_000_000n, proposer: PROPOSER, sourceUrl: "https://data.weather.gov.hk/", rawSha256, capturedAt: 1_800_000_000n, excerpt: "{}" };
    const v = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n + 3n, no: 10n ** 15n, asserted: true });
    mocks.now = v.config.times.refundAt - 60n;
    useApp([v]);
    render(<WaitingPage id={1} />);
    const print = await screen.findByTestId("data-fingerprint");
    expect(print).toHaveTextContent("0x5e5e…5e5e");
    expect(print.querySelector("[title]")).toHaveAttribute("title", rawSha256);
    expect(screen.getByText("Data fingerprint")).toBeInTheDocument();
    expect(screen.queryByText(rawSha256)).toBeNull();
    expect(screen.getByRole("note", { name: /the same HKO file/ })).toBeInTheDocument();
  });

  it("points a custom market's data fingerprint at the source document its rules name", async () => {
    mocks.evidence = { txHash: `0x${"78".repeat(32)}`, bond: 1_000_000n, proposer: PROPOSER, sourceUrl: "https://data.weather.gov.hk/", rawSha256: `0x${"6f".repeat(32)}`, capturedAt: 1_800_000_000n, excerpt: "{}" };
    const custom = humidityBand();
    mocks.now = custom.config.times.earliestAssertionAt + 60n;
    useApp([custom]);
    render(<WaitingPage id={1} />);
    expect(await screen.findByTestId("data-fingerprint")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: /the same source document/ })).toBeInTheDocument();
  });

  it("says an HKO field market's source and procedure in the reader's language and keeps the rules text one click away", async () => {
    const custom = humidityBand();
    useApp([custom]);
    setActiveLocale("zh-CN");
    try {
      render(<MarketDetailPage id={1} />);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("11月3日 日平均相对湿度介于 70% 与 85% 之间（含两端）？");
      await userEvent.click(await screen.findByTestId("detail-tab-rules"));
      expect(screen.getAllByText("香港天文台每日摘要").length).toBeGreaterThan(0);
      expect(screen.getByText("取天文台每日摘要 11 月文件中 3 日那一行的第 6 列（日平均相对湿度，整数百分比）")).toBeInTheDocument();
      const original = screen.getByTestId("custom-procedure");
      expect(original.tagName).toBe("DETAILS");
      expect(original).not.toHaveAttribute("open");
      expect(original).toHaveTextContent("规则原文");
    } finally {
      setActiveLocale("en");
    }
  });
});

function humidityBand(): MarketView {
  const field = HKO_DAILY_EXTRACT_FIELDS.find((f) => f.key === "mean-humidity")!;
  const base = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n + 5n, no: 10n ** 15n, asserted: true });
  const times = hkDayMarketTimes({ openAt: Number(base.config.times.openAt), targetDate: "20261103", plan: { proposalWindow: 3_600, assertionLiveness: 120, refundBuffer: 3_600 } });
  const config = { ...base.config, condition: { metricId: 1, comparison: 5, lower: 7_000, upper: 8_500 }, times };
  const metric = { ...field.metric.definition, code: encodeBytes32String(field.metric.definition.code), unit: encodeBytes32String(field.metric.definition.unit), rulesHash: field.metric.rulesHash };
  const rulesDocument = buildHkoFieldNumericRules({ title: "t", targetDate: "20261103" }, { config: { ...config, condition: { ...config.condition }, times: { ...times } }, metricId: 1, metric });
  const custom = {
    ...base, rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)),
    config: { ...config, condition: toBig(config.condition), times: toBig({ ...times }) },
    metric: { id: 1, ...field.metric.definition, rulesHash: field.metric.rulesHash },
  } as unknown as MarketView;
  return custom;
}

describe("settlement", () => {
  it("claims a single-sided refund without asking UMA whether new assertions are admitted", async () => {
    const claim = vi.fn(async () => tx);
    mocks.marketOf.mockReturnValue({ claim });
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n, side: 1n, stake: 10n ** 15n, effective: 3n, reason: 2n, claimable: 10n ** 15n })]);
    render(<SettlementPage id={1} />);
    expect(screen.getByTestId("result-title")).toHaveTextContent(/only one side was staked/);
    await userEvent.click(screen.getByTestId("claim"));
    await waitFor(() => expect(claim).toHaveBeenCalledWith(1));
    expect(mocks.assertOracleSubmissionSupported).not.toHaveBeenCalled();
  });

  it("refunds at once after the oracle rejects the proposed result, and says so", () => {
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n, no: 10n ** 15n, side: 1n, stake: 10n ** 15n, effective: 3n, reason: 3n, claimable: 10n ** 15n, rejected: true })]);
    render(<SettlementPage id={1} />);
    expect(screen.getByTestId("result-title")).toHaveTextContent("the oracle rejected the proposed result");
    expect(screen.getByTestId("claim")).toBeEnabled();
  });
});

describe("markets page", () => {
  const markets = [view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 3n * 10n ** 15n, no: 10n ** 15n }), view(2, "DAILY_MAX_TEMPERATURE", { date: "20261105" }), view(3, "DAILY_MAX_TEMPERATURE", { date: "20261104" })];

  it("lists the weather markets with their questions, newest first, and filters them by type", async () => {
    useApp(markets);
    render(<MarketsPage tab="markets" />);
    const rows = await screen.findAllByTestId("pool-card");
    expect(rows.map((r) => r.getAttribute("data-market"))).toEqual(["3", "2", "1"]);
    expect(within(rows[2]!).getByText("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?")).toBeInTheDocument();
    expect(within(screen.getByTestId("metric-filter")).getAllByRole("button").map((b) => b.textContent)).toEqual(["All3", "Rain1", "Temperature2"]);
    await userEvent.click(screen.getByTestId("kind-filter-rain"));
    expect(screen.getAllByTestId("pool-card").map((r) => r.getAttribute("data-market"))).toEqual(["1"]);
  });

  it("shows the same official markets on Sepolia", async () => {
    useApp(markets, { ...local, environment: "SEPOLIA_UMA", chainId: 11155111 });
    render(<MarketsPage tab="markets" />);
    const rows = await screen.findAllByTestId("pool-card");
    expect(rows.map((r) => r.getAttribute("data-market"))).toEqual(["3", "2", "1"]);
  });

  it("lists a sports demo after the weather markets, with a Sports chip and a Demo tag, and keeps the focus on weather", async () => {
    const busy = 9n * 10n ** 15n;
    useApp([...markets, sportsView(4, busy, busy)]);
    render(<MarketsPage tab="markets" />);
    const rows = await screen.findAllByTestId("pool-card");
    expect(rows.map((r) => r.getAttribute("data-market"))).toEqual(["3", "2", "1", "4"]);
    expect(within(rows[3]!).getByTestId("market-tag")).toHaveTextContent("Demo");
    expect(within(screen.getByTestId("metric-filter")).getAllByRole("button").map((b) => b.textContent)).toEqual(["All4", "Rain1", "Temperature2", "Sports1"]);
    expect(within(screen.getByTestId("focus")).getByRole("heading", { level: 2 })).toHaveTextContent("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?");
    await userEvent.click(screen.getByTestId("kind-filter-sport"));
    expect(screen.getAllByTestId("pool-card").map((r) => r.getAttribute("data-market"))).toEqual(["4"]);
  });

  it("tags a market that ended in a refund as refunded, in both languages", async () => {
    const base = view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 2n * 10n ** 15n, no: 3n * 10n ** 15n, effective: 3n, reason: 3n });
    useApp([{ ...base, state: { ...base.state, terminal: 3n, refundReason: 3n } } as MarketView]);
    const { unmount } = render(<MarketsPage tab="markets" />);
    const [row] = await screen.findAllByTestId("pool-card");
    expect(row).toHaveAttribute("data-phase", "REFUND");
    expect(within(row!).getByTestId("phase-badge")).toHaveTextContent(/^Refunded/);
    unmount();
    setActiveLocale("zh-CN");
    try {
      render(<MarketsPage tab="markets" />);
      expect(within((await screen.findAllByTestId("pool-card"))[0]!).getByTestId("phase-badge")).toHaveTextContent(/^已退款/);
    } finally {
      setActiveLocale("en");
    }
  });

  it("never shows a sports demo on Sepolia", async () => {
    useApp([...markets, sportsView(4, 10n ** 15n, 10n ** 15n)], { ...local, environment: "SEPOLIA_UMA", chainId: 11155111 });
    render(<MarketsPage tab="markets" />);
    const rows = await screen.findAllByTestId("pool-card");
    expect(rows.map((r) => r.getAttribute("data-market"))).toEqual(["3", "2", "1"]);
    expect(screen.queryByTestId("kind-filter-sport")).toBeNull();
  });
});

describe("intro", () => {
  it("draws the featured market's Yes share after each bet once there are two bets, with both stakes under it", async () => {
    const [yes, no] = [3n * 10n ** 15n + 1n, 2n * 10n ** 15n];
    mocks.trades = [
      { transactionHash: "0x02", logIndex: 0, account: "0x00000000000000000000000000000000000000c2", side: 2, amount: no, timestamp: 2 },
      { transactionHash: "0x01", logIndex: 0, account: "0x00000000000000000000000000000000000000c1", side: 1, amount: yes, timestamp: 1 },
    ];
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes, no })]);
    render(<LandingPage />);
    expect(await screen.findByTestId("live-steps")).toBeInTheDocument();
    expect(screen.getByTestId("live-split")).toHaveTextContent("Yes 0.003 ETH");
    expect(screen.getByTestId("live-split")).toHaveTextContent("No 0.002 ETH");
  });

  it("features a weather market even when a sports demo has more stakes", () => {
    const busy = 9n * 10n ** 15n;
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 10n ** 15n + 3n, no: 10n ** 15n }), sportsView(4, busy, busy)]);
    render(<LandingPage />);
    expect(within(screen.getByTestId("live-card")).getByText("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?")).toBeInTheDocument();
  });

  it("says plainly that one bet makes no line yet, and draws none", async () => {
    const yes = 7n * 10n ** 15n + 1n;
    mocks.trades = [{ transactionHash: "0x03", logIndex: 0, account: "0x00000000000000000000000000000000000000c1", side: 1, amount: yes, timestamp: 1 }];
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes })]);
    render(<LandingPage />);
    expect(await screen.findByText("One bet so far. The line starts with the second.")).toBeInTheDocument();
    expect(screen.queryByTestId("live-steps")).toBeNull();
  });

  it("shows the busiest open market, the real figures, the true fee table and the contract's answers to the four questions", async () => {
    useApp([view(1, "TOTAL_RAINFALL", { date: "20261103", yes: 3n * 10n ** 15n, no: 10n ** 15n }), view(2, "DAILY_MAX_TEMPERATURE", { date: "20261104", yes: 10n ** 15n })]);
    render(<LandingPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Rain or shine,settled on chain");
    expect(screen.getByTestId("enter-markets")).toHaveAttribute("href", "#/markets");
    expect(within(screen.getByTestId("live-card")).getByText("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("landing-figures")).toHaveTextContent("0.005 ETH"));
    const fees = screen.getByTestId("intro-fees");
    expect(fees).toHaveTextContent("Platform fee0");
    expect(fees).toHaveTextContent("Minimum bet0.001 ETH");
    expect(fees).toHaveTextContent("10.0 tBOND, returned when undisputed");
    const faq = screen.getByTestId("intro-faq");
    expect(within(faq).getAllByRole("group")).toHaveLength(7);
    expect(faq).toHaveTextContent("Yes, but only on the side of its first bet");
    expect(faq).toHaveTextContent("the contract rejects a bet on the other side");
    expect(faq).toHaveTextContent("The contract has no withdrawal");
    expect(faq).toHaveTextContent("Every stake is refunded");
    expect(screen.getByTestId("kind-rain")).toHaveTextContent("1 (1 open)");
    expect(screen.getByTestId("skip-intro")).not.toBeChecked();
  });
});
