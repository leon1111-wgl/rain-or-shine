// Proposing on a custom market: import or paste the source document, type the reading its procedure gives, and see
// the hash, the on-chain excerpt and the contract's outcome before the bond goes to the oracle.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeBytes32String, hexlify, keccak256, sha256, toUtf8Bytes, ZeroHash, type ContractTransactionResponse, type JsonRpcSigner } from "ethers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument, type CustomMetric,
} from "../../src/metric/custom-profile";
import type { NumericRulesChainExpectation, NumericRulesContext } from "../../src/metric/numeric-rules";
import { hkDayWindow } from "../../src/weather/profile";
import type { MarketView } from "../../web/src/metric/client";
import type { useMetricApp } from "../../web/src/metric/context";
import { OracleActions } from "../../web/src/metric/OracleActions";

type MetricApi = ReturnType<typeof useMetricApp>;
const mocks = vi.hoisted(() => ({
  useMetricApp: vi.fn<() => MetricApi>(),
  run: vi.fn<MetricApi["run"]>(),
  action: vi.fn<MetricApi["action"]>(),
  readNumericContext: vi.fn(),
  numericContextForMarket: vi.fn(),
  marketOf: vi.fn(),
  adapterOf: vi.fn(),
  tokenOf: vi.fn(),
  oracleOf: vi.fn(),
  mockOracleOf: vi.fn(),
  assertOracleSubmissionSupported: vi.fn(),
  checkProposal: vi.fn(),
  previewClaim: vi.fn(),
  propose: vi.fn(),
  proposeStatic: vi.fn(),
  downloadText: vi.fn(),
}));
vi.mock("../../web/src/metric/context", () => ({ useMetricApp: mocks.useMetricApp, downloadText: mocks.downloadText }));
vi.mock("../../web/src/metric/client", () => ({
  readNumericContext: mocks.readNumericContext,
  numericContextForMarket: mocks.numericContextForMarket,
  marketOf: mocks.marketOf,
  adapterOf: mocks.adapterOf,
  tokenOf: mocks.tokenOf,
  oracleOf: mocks.oracleOf,
  mockOracleOf: mocks.mockOracleOf,
  assertOracleSubmissionSupported: mocks.assertOracleSubmissionSupported,
}));

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const NOW = 1_800_000_000;
const BOND = 1_000_000n;
const signer = { getAddress: async () => ACCOUNT } as JsonRpcSigner;
const tx = { hash: `0x${"12".repeat(32)}` } as ContractTransactionResponse;
const index = customMetricRulesDocument({
  code: "CITY_INDEX", unit: "points", minValue: 0, maxValue: 100_000_000, valueStep: 1, allowsTrace: false,
  interpretation: "The index level the provider publishes for the end of the observation window, in points with two decimals.",
});
const humidity = HKO_DAILY_EXTRACT_FIELDS.find((field) => field.key === "mean-humidity")!;
const SOURCE = { sourceName: "City index daily report", sourceUrl: "https://example.org/index/daily.csv", procedure: "Read the CLOSE column of the row dated on the last day of the observation window." };
let app: MetricApi;
let market: MarketView;
let failures: string[];

// jsdom and node:crypto use different Uint8Array realms.
beforeAll(() => { sha256.register((data) => Uint8Array.from(sha256._(data))); });
afterAll(() => { sha256.register(sha256._); });

function documentFile(bytes: Uint8Array, name: string, type: string): File {
  const file = new File([bytes.slice()], name, { type });
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(bytes.slice().buffer) });
  return file;
}
const toBig = (o: object) => Object.fromEntries(Object.entries(o).map(([key, value]) => [key, BigInt(value as number)]));

/** A market on `metric` whose observation has ended, with rules from `build`. */
function customMarket(metric: CustomMetric, condition: { comparison: number; lower: number; upper: number }, window: { start: number; end: number }, ids: [string, string], build: (context: NumericRulesContext) => string): MarketView {
  const metricId = 7;
  const config = {
    proposer: ACCOUNT, sourceId: encodeBytes32String(ids[0]), subjectId: encodeBytes32String(ids[1]),
    condition: { metricId, ...condition },
    times: {
      openAt: window.start - 7_200, closeAt: window.start - 60, observationStart: window.start, observationEnd: window.end,
      earliestAssertionAt: window.end, proposalCutoff: NOW + 600, refundAt: NOW + 600 + 120 + 3_600, assertionLiveness: 120,
    },
  };
  const chainMetric = { ...metric.definition, code: encodeBytes32String(metric.definition.code), unit: encodeBytes32String(metric.definition.unit), rulesHash: metric.rulesHash };
  const context = { config, metricId, metric: chainMetric };
  const rulesDocument = build(context);
  const rulesHash = keccak256(toUtf8Bytes(rulesDocument));
  const expected: NumericRulesChainExpectation = { ...context, marketRulesHash: rulesHash };
  mocks.numericContextForMarket.mockImplementation(() => expected);
  mocks.readNumericContext.mockImplementation(async () => ({ expected, chainTimestamp: NOW }));
  return {
    id: 5, config: { ...config, condition: toBig(config.condition), times: toBig(config.times) },
    metric: { id: metricId, ...metric.definition, rulesHash: metric.rulesHash }, rulesDocument, rulesHash, title: "t",
    state: { yesTotal: 10n, noTotal: 10n, paidOut: 0n, yesAccounts: 1n, noAccounts: 1n, terminal: 0n, refundReason: 0n },
    position: { side: 0n, claimed: false, stake: 0n }, claimable: 0n,
    assertion: { assertionId: ZeroHash, reading: { kind: 0n, value: 0n }, rawSha256: ZeroHash, proposedAt: 0n, disputed: false, returned: false, rejected: false },
    effectiveTerminal: 0n, effectiveRefundReason: 0n, mockResolutionReady: false,
  } as unknown as MarketView;
}
function indexMarket(): MarketView {
  return customMarket(index, { comparison: 5, lower: 2_500_000, upper: 2_550_000 }, { start: NOW - 7_200, end: NOW - 600 }, ["CITY_INDEX_DAILY_REPORT", "CITY_INDEX"],
    (context) => buildCustomNumericRules({ title: "CITY_INDEX between 25000 and 25500 points inclusive", ...SOURCE, metricRulesDocument: index.rulesDocument }, context));
}

const checkButton = () => screen.getByRole("button", { name: "Check result" });
const proposeButton = () => screen.getByRole("button", { name: "2. Submit result" });

beforeEach(() => {
  vi.resetAllMocks();
  failures = [];
  mocks.checkProposal.mockResolvedValue(1n);
  mocks.previewClaim.mockResolvedValue(hexlify(toUtf8Bytes("NUMERIC_OBSERVATION_V1 preview")));
  mocks.propose.mockResolvedValue(tx);
  mocks.proposeStatic.mockResolvedValue(`0x${"33".repeat(32)}`);
  mocks.assertOracleSubmissionSupported.mockResolvedValue(undefined);
  mocks.marketOf.mockReturnValue({ checkProposal: mocks.checkProposal });
  mocks.adapterOf.mockReturnValue({ previewClaim: mocks.previewClaim, propose: Object.assign(mocks.propose, { staticCall: mocks.proposeStatic }) });
  mocks.run.mockImplementation(async (_label, send) => {
    try { await send(signer); return true; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return false; }
  });
  mocks.action.mockImplementation(async (_label, action) => {
    try { await action(); return true; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return false; }
  });
  app = {
    dep: { chainId: 31337, environment: "LOCAL_MOCK", bindingTransactionHash: "binding-1",
      contracts: { PredictionMarket: { address: "0x0000000000000000000000000000000000000011" }, UmaMetricOracleAdapter: { address: "0x0000000000000000000000000000000000000022" } },
      oracle: { bondDecimals: 6, bondSymbol: "tBOND" } },
    wallet: { account: ACCOUNT, chainId: 31337, epoch: 1, isCorrectChain: true, getSigner: async () => signer },
    data: { now: NOW, bondAmount: BOND }, reader: {},
    run: mocks.run, action: mocks.action, busy: false, canWrite: true, isAdmin: true, ready: true,
  } as unknown as MetricApi;
  mocks.useMetricApp.mockImplementation(() => app);
  market = indexMarket();
});

describe("custom market proposals", () => {
  it("proposes a pasted document with the typed reading after the contract's check and a static call", async () => {
    render(<OracleActions market={market} />);
    expect(screen.getByText(/import the source document or paste its text/)).toBeVisible();
    const text = "date,close\n2027-01-15,25321.40\n";
    await userEvent.type(screen.getByTestId("result-paste"), text.replaceAll("\n", "{Enter}"));
    await userEvent.click(screen.getByTestId("result-use-paste"));
    await waitFor(() => expect(screen.getByText("Imported: Pasted text.")).toBeVisible());
    expect(proposeButton()).toBeDisabled();
    await userEvent.type(screen.getByTestId("result-reading-input"), "25321.4");
    const bytes = toUtf8Bytes(text);
    expect(screen.getByTestId("result-sha256").querySelector("[title]")).toHaveAttribute("title", sha256(bytes));
    expect(screen.getByTestId("result-excerpt-size")).toHaveTextContent(`${bytes.length} bytes`);
    expect(screen.getByTestId("result-reading")).toHaveTextContent("25321.4 points");

    await userEvent.click(checkButton());
    await waitFor(() => expect(screen.getByTestId("result-outcome")).toHaveTextContent("If the oracle accepts this reading, the market resolves Yes."));
    const reading = { kind: 1, value: 2_532_140 };
    expect(mocks.checkProposal).toHaveBeenCalledWith(5, ACCOUNT, reading, sha256(bytes));
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    const evidence = { sourceUrl: SOURCE.sourceUrl, rawSha256: sha256(bytes), capturedAt: NOW, excerpt: hexlify(bytes) };
    expect(mocks.proposeStatic).toHaveBeenCalledWith(5, reading, evidence, BOND);
    expect(mocks.propose).toHaveBeenCalledWith(5, reading, evidence, BOND);
    expect(mocks.proposeStatic.mock.invocationCallOrder[0]).toBeLessThan(mocks.propose.mock.invocationCallOrder[0]!);
    expect(failures).toEqual([]);
  });

  it("asks for an exact excerpt of a large web page and shows the contract's outcome", async () => {
    mocks.checkProposal.mockResolvedValue(2n);
    render(<OracleActions market={market} />);
    const excerpt = '<td id="close">25612.00</td>';
    const page = toUtf8Bytes(`<!doctype html><html><body>${"<p>market commentary</p>".repeat(120)}<table><tr>${excerpt}</tr></table></body></html>`);
    expect(page.length).toBeGreaterThan(2_048);
    await userEvent.upload(screen.getByLabelText("Import source document"), documentFile(page, "close.html", "text/html"));
    await waitFor(() => expect(screen.getByText("Imported: close.html.")).toBeVisible());
    await userEvent.type(screen.getByTestId("result-reading-input"), "25612");
    expect(screen.getByTestId("result-draft-problem")).toHaveTextContent(/excerpt/);
    await userEvent.type(screen.getByTestId("result-excerpt"), '<td id="close">25612</td>');
    expect(screen.getByTestId("result-draft-problem")).toHaveTextContent(/excerpt/);
    await userEvent.clear(screen.getByTestId("result-excerpt"));
    await userEvent.type(screen.getByTestId("result-excerpt"), excerpt);
    expect(screen.queryByTestId("result-draft-problem")).not.toBeInTheDocument();
    expect(screen.getByTestId("result-excerpt-size")).toHaveTextContent(`${toUtf8Bytes(excerpt).length} bytes`);
    expect(screen.getByTestId("result-sha256").querySelector("[title]")).toHaveAttribute("title", sha256(page));
    await userEvent.click(checkButton());
    await waitFor(() => expect(screen.getByTestId("result-outcome")).toHaveTextContent("the market resolves No."));
    expect(mocks.checkProposal).toHaveBeenCalledWith(5, ACCOUNT, { kind: 1, value: 2_561_200 }, sha256(page));
    expect(failures).toEqual([]);
  });

  it("refuses a reading the metric cannot hold before anything is checked on-chain", async () => {
    render(<OracleActions market={market} />);
    await userEvent.type(screen.getByTestId("result-paste"), "close 25321.40");
    await userEvent.click(screen.getByTestId("result-use-paste"));
    await waitFor(() => expect(screen.getByText("Imported: Pasted text.")).toBeVisible());
    await userEvent.type(screen.getByTestId("result-reading-input"), "Trace");
    expect(screen.getByTestId("result-draft-problem")).toBeVisible();
    await userEvent.click(proposeButton());
    await waitFor(() => expect(failures).toHaveLength(1));
    expect(mocks.checkProposal).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("reads an HKO Daily Extract field from the monthly file without a typed reading", async () => {
    const raw = new Uint8Array(readFileSync(new NodeURL("../../fixtures/official/hko-daily-extract/dailyExtract_202609_20261002T095227Z.raw", import.meta.url)));
    const window = hkDayWindow("20260914");
    market = customMarket(humidity.metric, { comparison: 5, lower: 7_000, upper: 8_500 }, { start: Number(window.start), end: Number(window.end) }, ["HKO_DAILY_EXTRACT", "HKO"],
      (context) => buildHkoFieldNumericRules({ title: "Mean humidity 70 to 85 % on 14 September", targetDate: "20260914" }, context));
    render(<OracleActions market={market} />);
    expect(screen.queryByTestId("result-reading-input")).not.toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Import source document"), documentFile(raw, "dailyExtract_202609.json", "application/json"));
    await waitFor(() => expect(screen.getByTestId("result-reading")).toHaveTextContent("84 %"));
    await userEvent.click(checkButton());
    await waitFor(() => expect(screen.getByTestId("result-outcome")).toHaveTextContent("resolves Yes"));
    const row = ["14", "1014.1", "28.7", "27.8", "26.1", "24.8", "84", "88", " 37.9"];
    const [, , reading, rawSha256] = mocks.checkProposal.mock.calls[0]!;
    expect([reading, rawSha256]).toEqual([{ kind: 1, value: 8_400 }, sha256(raw)]);
    expect(mocks.previewClaim.mock.calls[0]![2]).toMatchObject({ excerpt: hexlify(toUtf8Bytes(JSON.stringify(row))) });
    expect(failures).toEqual([]);
  });
});
