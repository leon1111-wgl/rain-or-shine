// The new-market flow: metric cards, a sensible default condition, the day or a window, a live preview, and one
// button that registers a missing metric first. Every rule shows its problem next to its own field.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decodeBytes32String, encodeBytes32String, keccak256, toUtf8String, ZeroHash, type ContractTransactionResponse, type JsonRpcSigner,
} from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HKO_DAILY_EXTRACT_FIELDS, assertCustomNumericProfile, customMetricRulesDocument, type CustomMetric } from "../../src/metric/custom-profile";
import { hkDayMarketTimes, windowMarketTimes } from "../../src/metric/market-times";
import { NUMERIC_METRIC_PRESETS, assertSportsNumericProfile } from "../../src/metric/numeric-profiles";
import { parseNumericMarketRules, type NumericChainMarketConfig } from "../../src/metric/numeric-rules";
import { dailyExtractMonthUrl } from "../../src/weather/profile";
import type { MarketData } from "../../web/src/lib/markets";
import type { MetricView } from "../../web/src/metric/client";
import type { useMetricApp } from "../../web/src/metric/context";
import { metricDocKey } from "../../web/src/metric/form-parts";
import { NewMarket } from "../../web/src/metric/new-market";
import { defaultCondition, nextOpenDay, templateOf } from "../../web/src/metric/new-market-model";

type MetricApi = ReturnType<typeof useMetricApp>;
type Definition = { code: string; unit: string; minValue: bigint; maxValue: bigint; valueStep: bigint; allowsTrace: boolean; rulesHash: string };
const mocks = vi.hoisted(() => ({
  useMetricApp: vi.fn<() => MetricApi>(),
  run: vi.fn<MetricApi["run"]>(),
  marketOf: vi.fn(),
  createMarket: vi.fn<(config: NumericChainMarketConfig, rules: Uint8Array) => Promise<ContractTransactionResponse>>(),
  registerMetric: vi.fn<(definition: Definition) => Promise<ContractTransactionResponse>>(),
  getMetric: vi.fn(),
  metricIdByCode: vi.fn(),
  marketCount: vi.fn(),
  marketRulesHash: vi.fn(),
  getBlock: vi.fn<() => Promise<{ timestamp: number; number: number }>>(),
  send: vi.fn<(method: string, params: unknown[]) => Promise<unknown>>(),
  downloadText: vi.fn(),
}));
vi.mock("../../web/src/metric/context", () => ({ useMetricApp: mocks.useMetricApp, downloadText: mocks.downloadText }));
vi.mock("../../web/src/metric/client", () => ({ marketOf: mocks.marketOf }));

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const MARKET = "0x0000000000000000000000000000000000000011";
/** 2027-01-15 16:00 Hong Kong time. */
const NOW = 1_800_000_000;
const TOMORROW = "2027-01-16";
const hkt = (iso: string) => Math.floor(Date.parse(`${iso}+08:00`) / 1_000);
const fromPreset = (code: string, id: number): MetricView => ({ ...NUMERIC_METRIC_PRESETS.find((item) => item.code === code)!, id });
const fromCustom = (metric: CustomMetric, id: number): MetricView => ({ id, ...metric.definition, rulesHash: metric.rulesHash });
const field = (key: string) => HKO_DAILY_EXTRACT_FIELDS.find((item) => item.key === key)!;
const gust = customMetricRulesDocument({
  code: "PEAK_GUST", unit: "kmh", minValue: 0, maxValue: 30_000, valueStep: 10, allowsTrace: false,
  interpretation: "Highest gust at Waglan Island over the observation window, in km/h.",
});
const SOURCE = { name: "Regional wind report", url: "https://example.org/wind/waglan.csv", procedure: "Read the highest gust in the window from the report." };
const signer = { getAddress: async () => ACCOUNT } as JsonRpcSigner;
let app: MetricApi;
let chainMetrics: MetricView[];
let failures: string[];
let labels: string[];
let createdHash: string;
let marketCount: bigint;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function chainMetric(metric: MetricView) {
  return {
    code: encodeBytes32String(metric.code), unit: encodeBytes32String(metric.unit), minValue: BigInt(metric.minValue), maxValue: BigInt(metric.maxValue),
    valueStep: BigInt(metric.valueStep), allowsTrace: metric.allowsTrace, rulesHash: metric.rulesHash,
  };
}
function textFile(text: string, name: string): File {
  const bytes = new TextEncoder().encode(text);
  const file = new File([bytes], name, { type: "application/json" });
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(bytes.slice().buffer) });
  return file;
}
const set = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const createButton = () => screen.getByTestId("custom-create");
const choose = (key: string) => userEvent.click(screen.getByTestId(`choice-${key}`));
const openAdvanced = () => userEvent.click(screen.getByText("Advanced timing"));
function created() {
  const call = mocks.createMarket.mock.calls[0];
  expect(call).toBeDefined();
  const [config, encodedRules] = call!;
  return { config, rules: parseNumericMarketRules(toUtf8String(encodedRules)) };
}
function fillSource() {
  set(screen.getByTestId("custom-source-name"), SOURCE.name);
  set(screen.getByTestId("custom-source-url-input"), SOURCE.url);
  set(screen.getByTestId("custom-procedure-input"), SOURCE.procedure);
}
const local = { proposalWindow: 24 * 3_600, assertionLiveness: 120, refundBuffer: 3_600 };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  failures = [];
  labels = [];
  createdHash = "";
  marketCount = 6n;
  chainMetrics = [fromPreset("DAILY_MAX_TEMPERATURE", 1), fromCustom(field("mean-humidity").metric, 3), fromPreset("TOTAL_RAINFALL", 4), fromCustom(gust, 6)];
  mocks.getBlock.mockResolvedValue({ timestamp: NOW, number: 123 });
  mocks.send.mockResolvedValue({ number: null, timestamp: "0x" + NOW.toString(16) });
  mocks.getMetric.mockImplementation(async (id: number) => chainMetric(chainMetrics.find((item) => item.id === id)!));
  mocks.metricIdByCode.mockImplementation(async (code: string) => BigInt(chainMetrics.find((item) => encodeBytes32String(item.code) === code)?.id ?? 0));
  mocks.marketCount.mockImplementation(async () => marketCount);
  mocks.marketRulesHash.mockImplementation(async (id: number) => (id === 7 ? createdHash : ZeroHash));
  mocks.createMarket.mockImplementation(async (_config, rules) => {
    createdHash = keccak256(rules);
    marketCount += 1n;
    return { hash: `0x${"12".repeat(32)}` } as ContractTransactionResponse;
  });
  mocks.registerMetric.mockImplementation(async (definition) => {
    chainMetrics.push({
      id: 9, code: decodeBytes32String(definition.code), unit: decodeBytes32String(definition.unit), minValue: Number(definition.minValue),
      maxValue: Number(definition.maxValue), valueStep: Number(definition.valueStep), allowsTrace: definition.allowsTrace, rulesHash: definition.rulesHash,
    });
    return { hash: `0x${"34".repeat(32)}` } as ContractTransactionResponse;
  });
  mocks.marketOf.mockReturnValue({
    createMarket: mocks.createMarket, registerMetric: mocks.registerMetric, getMetric: mocks.getMetric,
    metricIdByCode: mocks.metricIdByCode, marketCount: mocks.marketCount, marketRulesHash: mocks.marketRulesHash,
  });
  mocks.run.mockImplementation(async (label, send) => {
    labels.push(label);
    try { await send(signer); return true; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return false; }
  });
  app = {
    dep: { chainId: 31337, environment: "LOCAL_MOCK", bindingTransactionHash: "binding-1", contracts: { PredictionMarket: { address: MARKET } } },
    wallet: { account: ACCOUNT, chainId: 31337, epoch: 1 },
    data: { now: NOW, metrics: [...chainMetrics], markets: [] },
    reader: { getBlock: mocks.getBlock, send: mocks.send }, run: mocks.run, busy: false, canWrite: true, isAdmin: true,
  } as unknown as MetricApi;
  mocks.useMetricApp.mockImplementation(() => app);
});

describe("the new-market flow", () => {
  it("starts on daily rainfall ≥ 1.0 mm for the next Hong Kong day, previews it and links the new market", async () => {
    render(<NewMarket />);
    expect(screen.getByTestId("choice-official:TOTAL_RAINFALL")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Comparison")).toHaveValue("4");
    expect(screen.getByLabelText("Threshold")).toHaveValue("1.0");
    expect(screen.getByLabelText("Observation date (Hong Kong)")).toHaveValue(TOMORROW);
    expect(screen.getByTestId("preview-question")).toHaveTextContent("Will HKO headquarters record ≥ 1.0 mm of rain on 16 Jan?");
    expect(screen.getByTestId("new-preview")).toHaveTextContent("The reading is ≥ 1.0 mm. Anything else is No.");
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    const { config, rules } = created();
    expect(labels).toEqual(["Create prediction market"]);
    expect(config.condition).toEqual({ metricId: 4, comparison: 4, lower: 100, upper: 0 });
    expect(config.times).toEqual(hkDayMarketTimes({ openAt: NOW + 60, targetDate: "20270116", plan: local }));
    expect([decodeBytes32String(config.sourceId), decodeBytes32String(config.subjectId)]).toEqual(["HKO_DAILY_EXTRACT", "HKO"]);
    expect(rules.subject.parameters).toMatchObject({ station: "HKO", targetDate: "20270116" });
    const link = await screen.findByRole("link", { name: "Open market #7" });
    expect(link).toHaveAttribute("href", "#/market/7");
    expect(failures).toEqual([]);
  });

  it("takes its default day from the chain's clock once the first read arrives", () => {
    const loaded = app;
    app = { ...app, data: undefined } as unknown as MetricApi;
    const view = render(<NewMarket />);
    // Before the read, the wall clock gives a day. The chain may run ahead of it, as a local chain does after time travel.
    app = loaded;
    view.rerender(<NewMarket />);
    expect(screen.getByLabelText("Observation date (Hong Kong)")).toHaveValue(TOMORROW);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("gives every card a condition a person would ask about, never 0 to 1", async () => {
    render(<NewMarket />);
    const condition = () => [screen.getByLabelText("Comparison"), screen.getByLabelText(/Threshold|Lower bound/), screen.queryByLabelText("Upper bound")]
      .map((input) => (input as HTMLInputElement | null)?.value ?? "");
    const expected: Array<[string, string[]]> = [
      ["official:DAILY_MAX_TEMPERATURE", ["4", "28.0", ""]], ["field:mean-pressure", ["4", "1013.0", ""]],
      ["field:mean-temperature", ["4", "25.0", ""]], ["field:min-temperature", ["2", "22.0", ""]],
      ["field:mean-dew-point", ["4", "20.0", ""]], ["field:mean-humidity", ["5", "70", "85"]], ["field:mean-cloud", ["4", "60", ""]],
    ];
    for (const [key, values] of expected) {
      await choose(key);
      expect(condition()).toEqual(values);
    }
    expect(defaultCondition({ code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50_000, maxValue: 50_000, valueStep: 100, allowsTrace: false }))
      .toEqual({ comparison: "4", lower: "0.0", upper: "" });
  });

  it("registers a Daily Extract preset first, then creates its market: two wallet confirmations", async () => {
    render(<NewMarket />);
    await choose("field:mean-pressure");
    expect(screen.getByTestId("choice-field:mean-pressure")).toHaveTextContent("Registered on create");
    expect(createButton()).toHaveTextContent("Register and create");
    expect(screen.getByText("This takes two wallet confirmations: 1/2 registers Daily mean pressure, 2/2 creates the market.")).toBeVisible();
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    expect(labels).toEqual(["1/2 Register Daily mean pressure", "2/2 Create market"]);
    const pressure = field("mean-pressure").metric;
    expect(mocks.registerMetric).toHaveBeenCalledWith({
      code: encodeBytes32String("DAILY_MEAN_PRESSURE"), unit: encodeBytes32String("hPa"), minValue: 80_000, maxValue: 110_000, valueStep: 10,
      allowsTrace: false, rulesHash: pressure.rulesHash,
    });
    const { config, rules } = created();
    expect(config.condition).toEqual({ metricId: 9, comparison: 4, lower: 101_300, upper: 0 });
    const profile = assertCustomNumericProfile(rules);
    expect([profile.sourceUrl, profile.hko?.field.column, profile.hko?.targetDate]).toEqual([dailyExtractMonthUrl("20270116"), 1, "20270116"]);
    expect(mocks.downloadText).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it("defines a new metric next to its market: errors by their fields, then registration and a window market", async () => {
    render(<NewMarket />);
    await choose("new");
    await userEvent.click(createButton());
    expect(screen.getByText("Enter a metric code.")).toBeVisible();
    expect(screen.getByText("Enter the metric definition and calculation rules.")).toBeVisible();
    expect(screen.getByText("Enter the source name.")).toBeVisible();
    expect(mocks.run).not.toHaveBeenCalled();

    set(screen.getByLabelText("Metric code"), "TOTAL_RAINFALL");
    expect(screen.getByTestId("metric-error")).toHaveTextContent("TOTAL_RAINFALL is already registered with other rules.");
    set(screen.getByLabelText("Metric code"), "PEAK_GUST_TODAY");
    set(screen.getByLabelText("Unit"), "kmh");
    set(screen.getByLabelText("Minimum reading"), "0");
    set(screen.getByLabelText("Maximum reading"), "300");
    set(screen.getByLabelText("Reading step"), "0.1");
    set(screen.getByLabelText("Metric definition and calculation rules"), "Highest gust at Waglan Island over the window, in km/h.");
    fillSource();
    set(screen.getByLabelText("Comparison"), "2");
    set(screen.getByLabelText("Threshold"), "60.0");
    set(screen.getByLabelText("Observation window"), "window");
    set(screen.getByTestId("custom-start"), "2027-01-15T18:00");
    set(screen.getByTestId("custom-end"), "2027-01-15T21:30");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    const metric = customMetricRulesDocument({
      code: "PEAK_GUST_TODAY", unit: "kmh", minValue: 0, maxValue: 30_000, valueStep: 10, allowsTrace: false,
      interpretation: "Highest gust at Waglan Island over the window, in km/h.",
    });
    expect(mocks.registerMetric).toHaveBeenCalledWith(expect.objectContaining({ code: encodeBytes32String("PEAK_GUST_TODAY"), rulesHash: metric.rulesHash }));
    expect(localStorage.getItem(metricDocKey(MARKET, metric.rulesHash))).toBe(metric.rulesDocument);
    expect(mocks.downloadText).toHaveBeenCalledWith("PEAK_GUST_TODAY-rules.json", metric.rulesDocument);
    const { config, rules } = created();
    const start = hkt("2027-01-15T18:00:00");
    const end = hkt("2027-01-15T21:30:00");
    expect(config.condition).toEqual({ metricId: 9, comparison: 2, lower: 6_000, upper: 0 });
    expect(config.times).toEqual(windowMarketTimes({ openAt: NOW + 60, observationStart: start, observationEnd: end, plan: local }));
    expect([decodeBytes32String(config.sourceId), decodeBytes32String(config.subjectId)]).toEqual(["REGIONAL_WIND_REPORT", "PEAK_GUST_TODAY"]);
    expect(assertCustomNumericProfile(rules)).toEqual({ sourceName: SOURCE.name, sourceUrl: SOURCE.url, procedure: SOURCE.procedure });
    expect(rules.title).toBe("PEAK_GUST_TODAY ≤ 60.0 kmh, 2027-01-15T18:00 to 2027-01-15T21:30 HKT");
    expect(failures).toEqual([]);
  });

  it("asks for a registered custom metric's rules file, then creates an inclusive range market", async () => {
    render(<NewMarket />);
    await choose("metric:6");
    expect(screen.getByTestId("custom-rules-missing")).toHaveTextContent("PEAK_GUST");
    await userEvent.upload(screen.getByLabelText("Import the metric's rules file"), textFile(gust.rulesDocument, "PEAK_GUST-rules.json"));
    await waitFor(() => expect(screen.queryByTestId("custom-rules-missing")).not.toBeInTheDocument());
    fillSource();
    set(screen.getByLabelText("Comparison"), "5");
    set(screen.getByLabelText("Lower bound"), "40.5");
    set(screen.getByLabelText("Upper bound"), "60");
    expect(screen.getByTestId("preview-question")).toHaveTextContent("PEAK GUST, 16 Jan: will it be between 40.5 kmh and 60.0 kmh (inclusive)?");
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    expect(labels).toEqual(["Create prediction market"]);
    const { config, rules } = created();
    expect(config.condition).toEqual({ metricId: 6, comparison: 5, lower: 4_050, upper: 6_000 });
    expect(config.times).toEqual(hkDayMarketTimes({ openAt: NOW + 60, targetDate: "20270116", plan: local }));
    expect(rules.metric.rulesDocument).toBe(gust.rulesDocument);
  });

  it("shows each broken rule next to its own field and sends nothing", async () => {
    localStorage.setItem(metricDocKey(MARKET, gust.rulesHash), gust.rulesDocument);
    render(<NewMarket />);
    await choose("metric:6");
    fillSource();
    set(screen.getByTestId("custom-source-url-input"), "example.org/wind.csv");
    set(screen.getByLabelText("Comparison"), "5");
    set(screen.getByLabelText("Lower bound"), "60");
    set(screen.getByLabelText("Upper bound"), "40");
    set(screen.getByLabelText("Observation window"), "window");
    set(screen.getByTestId("custom-start"), "2027-01-15T15:00");
    set(screen.getByTestId("custom-end"), "2027-01-15T14:00");
    expect(screen.getByTestId("threshold-error")).toHaveTextContent("The lower bound must not be above the upper bound.");
    expect(screen.getByText("The source link must be a complete address, such as https://…, without spaces.")).toBeVisible();
    expect(screen.getByText("Betting must close after it opens.")).toBeVisible();
    expect(createButton()).toBeDisabled();

    set(screen.getByLabelText("Lower bound"), "40");
    set(screen.getByLabelText("Upper bound"), "60");
    set(screen.getByTestId("custom-source-url-input"), SOURCE.url);
    set(screen.getByTestId("custom-start"), "2027-01-15T18:00");
    set(screen.getByTestId("custom-end"), "2027-01-15T21:00");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    // Any time can be set by hand. The contract's order and minimums still apply.
    await openAdvanced();
    set(screen.getByTestId("custom-time-refundAt"), "2027-01-16T21:30");
    expect(screen.getByTestId("timing-error")).toHaveTextContent("The refund deadline must come at least 1 hour after the last submission time plus the challenge period.");
    set(screen.getByTestId("custom-time-refundAt"), "2027-01-16T23:30");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    set(screen.getByLabelText("Challenge period (seconds)"), "59");
    expect(screen.getByText("Challenge period must be an integer of at least 60 seconds.")).toBeVisible();
    expect(createButton()).toBeDisabled();
    fireEvent.submit(screen.getByTestId("new-market-form"));
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("fixes the source, column and whole Hong Kong day for an HKO Daily Extract field", async () => {
    render(<NewMarket />);
    await choose("field:mean-humidity");
    expect(screen.getByTestId("choice-field:mean-humidity")).toHaveTextContent("Registered as #3");
    expect(screen.queryByTestId("custom-source-name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Observation window")).not.toBeInTheDocument();
    expect(screen.getByTestId("custom-field-source")).toHaveTextContent("column 6 (Mean Relative Humidity (%))");
    set(screen.getByLabelText("Observation date (Hong Kong)"), "2027-01-20");
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    const { config, rules } = created();
    expect(config.condition).toEqual({ metricId: 3, comparison: 5, lower: 7_000, upper: 8_500 });
    expect(config.times).toEqual(hkDayMarketTimes({ openAt: NOW + 60, targetDate: "20270120", plan: local }));
    const profile = assertCustomNumericProfile(rules);
    expect([profile.sourceUrl, profile.hko?.targetDate, profile.hko?.field.column]).toEqual([dailyExtractMonthUrl("20270120"), "20270120", 6]);
  });

  it("uses a week to submit, a two-hour challenge and a day's buffer on Sepolia", async () => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    render(<NewMarket />);
    expect(screen.getByLabelText("Challenge period (seconds)")).toHaveValue(7200);
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    expect(created().config.times).toEqual(hkDayMarketTimes({ openAt: NOW + 300, targetDate: "20270116", plan: { proposalWindow: 168 * 3_600, assertionLiveness: 7_200, refundBuffer: 86_400 } }));
    set(screen.getByLabelText("Challenge period (seconds)"), "3600");
    expect(screen.getByTestId("advanced-problem")).toHaveTextContent("Check these settings.");
    await openAdvanced();
    expect(screen.getByText("Challenge period must be an integer of at least 7200 seconds.")).toBeVisible();
    expect(createButton()).toBeDisabled();
  });

  it("offers the sports demos in their own group on the local chain and creates a basketball demo for its match", async () => {
    render(<NewMarket />);
    expect(screen.getByTestId("demo-choices")).toHaveTextContent("Sports demo Synthetic results. Local chain only.");
    await choose("sports:SCORE_MARGIN");
    expect(screen.getByTestId("choice-sports:SCORE_MARGIN")).toHaveTextContent("Basketball marginDemoRegistered on create");
    expect([screen.getByLabelText("Comparison"), screen.getByLabelText("Threshold")].map((input) => (input as HTMLInputElement).value)).toEqual(["3", "0"]);
    expect([screen.getByTestId("match-id"), screen.getByTestId("match-team-a"), screen.getByTestId("match-team-b")].map((input) => (input as HTMLInputElement).value))
      .toEqual(["LAL_BOS_DEMO01", "LAL", "BOS"]);
    expect(screen.getByTestId("match-note")).toHaveTextContent("The reading is team A minus team B. Overtime counts.");
    // A match has a start and an end. It names no source of its own.
    expect(screen.queryByLabelText("Observation window")).not.toBeInTheDocument();
    expect(screen.queryByTestId("custom-source-name")).not.toBeInTheDocument();
    set(screen.getByTestId("custom-start"), "2027-01-15T19:30");
    set(screen.getByTestId("custom-end"), "2027-01-15T22:00");
    expect(screen.getByTestId("preview-question")).toHaveTextContent("LAL vs BOS: will the margin (LAL − BOS) be > 0 points?");
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.createMarket).toHaveBeenCalledOnce());
    expect(labels).toEqual(["1/2 Register Basketball margin", "2/2 Create market"]);
    const score = NUMERIC_METRIC_PRESETS.find((item) => item.code === "SCORE_MARGIN")!;
    expect(mocks.registerMetric).toHaveBeenCalledWith(expect.objectContaining({ code: encodeBytes32String("SCORE_MARGIN"), rulesHash: score.rulesHash }));
    const { config, rules } = created();
    expect([decodeBytes32String(config.sourceId), decodeBytes32String(config.subjectId)]).toEqual(["DEMO_BASKETBALL", "LAL_BOS_DEMO01"]);
    expect(config.condition).toEqual({ metricId: 9, comparison: 3, lower: 0, upper: 0 });
    expect(config.times).toEqual(windowMarketTimes({ openAt: NOW + 60, observationStart: hkt("2027-01-15T19:30:00"), observationEnd: hkt("2027-01-15T22:00:00"), plan: local }));
    expect(rules.synthetic).toBe(true);
    expect(assertSportsNumericProfile(rules)).toEqual({ sport: "BASKETBALL", matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS", scoreScope: "INCLUDING_OVERTIME" });
    expect(rules.title).toBe("DEMO LAL_BOS_DEMO01 LAL vs BOS, SCORE_MARGIN > 0 points, 2027-01-15T19:30 to 2027-01-15T22:00 HKT");
    expect(failures).toEqual([]);
  });

  it("checks a match next to its fields", async () => {
    render(<NewMarket />);
    await choose("sports:GOAL_MARGIN");
    expect([screen.getByTestId("match-id"), screen.getByTestId("match-team-a"), screen.getByTestId("match-team-b")].map((input) => (input as HTMLInputElement).value))
      .toEqual(["ARS_CHE_DEMO01", "ARS", "CHE"]);
    expect(screen.getByTestId("match-note")).toHaveTextContent("90 minutes plus stoppage time.");
    set(screen.getByTestId("match-team-b"), "ARS");
    expect(screen.getByText("The two teams must differ.")).toBeVisible();
    set(screen.getByTestId("match-team-b"), "CHE");
    set(screen.getByTestId("match-id"), "");
    await userEvent.click(createButton());
    expect(screen.getByText("Enter a match ID.")).toBeVisible();
    set(screen.getByTestId("match-id"), "M".repeat(32));
    expect(screen.getByText("Match ID must contain 1–31 UTF-8 bytes and no control characters.")).toBeVisible();
    expect(createButton()).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("offers no sports demo on Sepolia", () => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    render(<NewMarket />);
    expect(screen.queryByTestId("demo-choices")).not.toBeInTheDocument();
    expect(screen.queryByTestId("choice-sports:SCORE_MARGIN")).not.toBeInTheDocument();
    expect(screen.queryByTestId("choice-sports:GOAL_MARGIN")).not.toBeInTheDocument();
  });

  it("refuses unreadable pending timestamps and a chain metric with other rules", async () => {
    render(<NewMarket />);
    for (const [index, pending] of [null, { timestamp: NOW }, { timestamp: "0xgg" }].entries()) {
      mocks.send.mockResolvedValueOnce(pending);
      await userEvent.click(createButton());
      await waitFor(() => expect(failures).toHaveLength(index + 1));
      expect(failures[index]).toMatch(/pending block timestamp/i);
    }
    mocks.getMetric.mockResolvedValueOnce({ ...chainMetric(chainMetrics[2]!), rulesHash: `0x${"88".repeat(32)}` });
    await userEvent.click(createButton());
    await waitFor(() => expect(failures[3]).toContain("onchain metric does not match"));
    expect(mocks.createMarket).not.toHaveBeenCalled();
  });

  it("drops a request when the inputs or the wallet change while it reads the chain", async () => {
    const view = render(<NewMarket />);
    const pendingBlock = deferred<{ timestamp: number; number: number }>();
    mocks.getBlock.mockReturnValueOnce(pendingBlock.promise);
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.getBlock).toHaveBeenCalledOnce());
    set(screen.getByLabelText("Threshold"), "5.0");
    await act(async () => { pendingBlock.resolve({ timestamp: NOW, number: 123 }); });
    await waitFor(() => expect(failures).toEqual([expect.stringContaining("settings changed")]));

    const second = deferred<{ timestamp: number; number: number }>();
    mocks.getBlock.mockReturnValueOnce(second.promise);
    await userEvent.click(createButton());
    await waitFor(() => expect(mocks.getBlock).toHaveBeenCalledTimes(2));
    app = { ...app, wallet: { ...app.wallet, account: "0x00000000000000000000000000000000000000b2", epoch: 2 } };
    view.rerender(<NewMarket />);
    await act(async () => { second.resolve({ timestamp: NOW, number: 123 }); });
    await waitFor(() => expect(failures).toHaveLength(2));
    expect(failures[1]).toContain("settings changed");
    expect(mocks.createMarket).not.toHaveBeenCalled();
  });

  it("keeps the title within 240 bytes and disables everything while a transaction runs", async () => {
    const view = render(<NewMarket />);
    await openAdvanced();
    set(screen.getByLabelText("Market title (optional)"), "€".repeat(81));
    expect(screen.getByText("The title can have at most 240 UTF-8 bytes.")).toBeVisible();
    expect(createButton()).toBeDisabled();
    app = { ...app, busy: true, canWrite: false };
    view.rerender(<NewMarket />);
    for (const label of ["Comparison", "Threshold", "Observation date (Hong Kong)"]) expect(screen.getByLabelText(label)).toBeDisabled();
    for (const card of within(screen.getByTestId("new-market-form")).getAllByRole("radio")) expect(card).toBeDisabled();
  });
});

describe("templates", () => {
  const market = (input: { metric: MetricView; comparison: number; lower: bigint; upper: bigint; subject: MarketData["subject"]; start: number; end: number }) => ({
    view: { metric: input.metric },
    condition: { comparison: input.comparison, lower: input.lower, upper: input.upper },
    subject: input.subject,
    times: {
      openAt: 0n, closeAt: BigInt(input.start), observationStart: BigInt(input.start), observationEnd: BigInt(input.end), earliestAssertionAt: BigInt(input.end),
      proposalCutoff: BigInt(input.end + 168 * 3_600), refundAt: BigInt(input.end + 168 * 3_600 + 7_200 + 86_400), assertionLiveness: 7_200n,
    },
  }) as unknown as MarketData;

  it("moves a day market to the next open day and keeps its metric, condition and timing", () => {
    const old = market({
      metric: chainMetrics[1]!, comparison: 5, lower: 6_500n, upper: 7_500n, subject: { kind: "CUSTOM", sourceName: "", sourceUrl: "", procedure: "", targetDate: "20261105" },
      start: hkt("2026-11-05T00:00:00"), end: hkt("2026-11-06T00:00:00"),
    });
    render(<NewMarket template={old} />);
    expect(screen.getByTestId("choice-field:mean-humidity")).toHaveAttribute("aria-checked", "true");
    expect([screen.getByLabelText("Lower bound"), screen.getByLabelText("Upper bound")].map((input) => (input as HTMLInputElement).value)).toEqual(["65", "75"]);
    expect(screen.getByLabelText("Observation date (Hong Kong)")).toHaveValue(TOMORROW);
    expect(screen.getByLabelText("Challenge period (seconds)")).toHaveValue(7200);
  });

  it("keeps a sports demo's match and window", () => {
    const score = { ...NUMERIC_METRIC_PRESETS.find((item) => item.code === "SCORE_MARGIN")!, id: 8 };
    const old = market({
      metric: score, comparison: 3, lower: 0n, upper: 0n, subject: { kind: "SYNTHETIC", sport: "BASKETBALL", matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" },
      start: hkt("2026-11-05T19:30:00"), end: hkt("2026-11-05T22:00:00"),
    });
    const template = templateOf(old, NOW, 60);
    expect(template).toMatchObject({ choiceKey: "sports:SCORE_MARGIN", condition: { comparison: "3", lower: "0" }, source: null, match: { matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" } });
    expect(template.window).toEqual({ mode: "window", start: hkt("2027-01-15T19:30:00"), end: hkt("2027-01-15T22:00:00") });
  });

  it("keeps a window's time of day and length, and its source", () => {
    const old = market({
      metric: chainMetrics[3]!, comparison: 4, lower: 4_000n, upper: 0n, subject: { kind: "CUSTOM", sourceName: SOURCE.name, sourceUrl: SOURCE.url, procedure: SOURCE.procedure, targetDate: null },
      start: hkt("2026-11-05T14:00:00"), end: hkt("2026-11-05T17:00:00"),
    });
    const template = templateOf(old, NOW, 60);
    expect(template).toMatchObject({ choiceKey: "metric:6", condition: { comparison: "4", lower: "40.0", upper: "" }, source: { name: SOURCE.name } });
    // 16:00 is past 14:00 today, so the window moves to tomorrow 14:00–17:00.
    expect(template.window).toEqual({ mode: "window", start: hkt("2027-01-16T14:00:00"), end: hkt("2027-01-16T17:00:00") });
    expect(nextOpenDay(hkt("2027-01-15T23:57:00"), 300)).toBe("2027-01-17");
  });
});
