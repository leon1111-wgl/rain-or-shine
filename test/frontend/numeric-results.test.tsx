import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  encodeBytes32String, hexlify, keccak256, sha256, toUtf8Bytes, ZeroHash,
  type ContractTransactionResponse, type JsonRpcSigner,
} from "ethers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCustomNumericRules, customMetricRulesDocument } from "../../src/metric/custom-profile";
import { buildHkoNumericRules, buildSportsNumericRules, NUMERIC_METRIC_PRESETS } from "../../src/metric/numeric-profiles";
import type { NumericRulesChainExpectation } from "../../src/metric/numeric-rules";
import { buildObservationBundle } from "../../src/weather/observation-evidence";
import { parseDailyExtractObservation } from "../../src/weather/observations";
import type { RawEvidence } from "../../src/weather/parse";
import { dailyExtractMonthUrl, hkDayWindow } from "../../src/weather/profile";
import { viaPageServer } from "../../web/src/lib/hko";
import type { MarketView } from "../../web/src/metric/client";
import type { useMetricApp } from "../../web/src/metric/context";
import { OracleActions as MarketPanel } from "../../web/src/metric/OracleActions";

type MetricApi = ReturnType<typeof useMetricApp>;
// Match Vite's browser decoder to avoid Node/jsdom Uint8Array realm conflicts.
// Retain the real base64 validation and hashing.
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    decodeBase64: (encoded: string): Uint8Array => {
      const decoded = atob(encoded);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      return actual.getBytes(bytes);
    },
  };
});
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
vi.mock("../../web/src/metric/context", () => ({
  useMetricApp: mocks.useMetricApp,
  dateTime: (value: number | bigint) => String(value),
  downloadText: mocks.downloadText,
}));
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
const MARKET = "0x0000000000000000000000000000000000000011";
const NOW = 1800000000;
/** The default market: a custom weekly rainfall total, read from a document the proposer imports. */
const weekly = customMetricRulesDocument({
  code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999_990, valueStep: 10, allowsTrace: false,
  interpretation: "Total rainfall at HKO headquarters over the market observation window, in mm.",
});
const SOURCE_URL = "https://example.org/weekly-rainfall";
const signer = { getAddress: async () => ACCOUNT } as JsonRpcSigner;
const tx = { hash: `0x${"12".repeat(32)}` } as ContractTransactionResponse;
let app: MetricApi;
let currentMarket: MarketView;
let expected: NumericRulesChainExpectation;
let failures: string[];

// jsdom and node:crypto use different Uint8Array realms.
beforeAll(() => { sha256.register((data) => Uint8Array.from(sha256._(data))); });
afterAll(() => { sha256.register(sha256._); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function buffer(bytes: Uint8Array): ArrayBuffer {
  const value = new ArrayBuffer(bytes.length);
  new Uint8Array(value).set(bytes);
  return value;
}
function resultText(total = "23.4") {
  return `Weekly rainfall at HKO headquarters: ${total} mm`;
}
function resultFile(bytes = toUtf8Bytes(resultText()), name = "weekly.txt", read?: () => Promise<ArrayBuffer>): File {
  const file = new File([buffer(bytes)], name, { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: read ?? (() => Promise.resolve(buffer(bytes))) });
  return file;
}
const uploadInput = () => screen.getByLabelText(/^(Import source document|Upload result file)$/);
const previewButton = () => screen.getByRole("button", { name: "Check result" });
const proposeButton = () => screen.getByRole("button", { name: "2. Submit result" });
const clearButton = () => screen.getByRole("button", { name: "Clear result file" });
/** Imports the file and, for a custom market, types the reading the document gives. */
async function upload(file = resultFile(), reading = "23.4") {
  await userEvent.upload(uploadInput(), file);
  const input = await screen.findByTestId("result-reading-input").catch(() => null);
  if (input) {
    await userEvent.clear(input);
    await userEvent.type(input, reading);
  }
  await waitFor(() => expect(previewButton()).toBeEnabled());
}

function useHkoMarket() {
  const fixtureRoot = "../../fixtures/official/hko-daily-extract/dailyExtract_202609_20261002T095227Z";
  const metadata = JSON.parse(readFileSync(new NodeURL(`${fixtureRoot}.meta.json`, import.meta.url), "utf8")) as {
    requestUrl: string; fetchedAt: string; httpStatus: number; contentType: string; lastModified: string;
  };
  const raw: RawEvidence = {
    bytes: new Uint8Array(readFileSync(new NodeURL(`${fixtureRoot}.raw`, import.meta.url))),
    sourceURL: metadata.requestUrl, fetchedAt: metadata.fetchedAt, httpStatus: metadata.httpStatus,
    contentType: metadata.contentType, lastModified: metadata.lastModified,
  };
  const temperature = NUMERIC_METRIC_PRESETS.find((item) => item.code === "DAILY_MAX_TEMPERATURE")!;
  const window = hkDayWindow("20260914");
  const capture = Math.floor(Date.parse(metadata.fetchedAt) / 1000);
  const config = {
    proposer: ACCOUNT, sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"), subjectId: encodeBytes32String("HKO"),
    condition: { metricId: 1, comparison: 3, lower: 2800, upper: 0 },
    times: {
      openAt: Number(window.start) - 120, closeAt: Number(window.start) - 60,
      observationStart: Number(window.start), observationEnd: Number(window.end),
      earliestAssertionAt: Number(window.end), proposalCutoff: capture + 86400,
      refundAt: capture + 86400 + 60 + 3600, assertionLiveness: 60,
    },
  };
  const metric = {
    code: encodeBytes32String(temperature.code), unit: encodeBytes32String(temperature.unit),
    minValue: temperature.minValue, maxValue: temperature.maxValue,
    valueStep: temperature.valueStep, allowsTrace: temperature.allowsTrace, rulesHash: temperature.rulesHash,
  };
  const context = { config, metricId: 1, metric };
  const rulesDocument = buildHkoNumericRules({ title: "HKO maximum temperature > 28 C", targetDate: "20260914" }, context);
  const rulesHash = keccak256(toUtf8Bytes(rulesDocument));
  expected = { ...context, marketRulesHash: rulesHash };
  currentMarket = {
    ...currentMarket, rulesDocument, rulesHash, metric: { ...temperature, id: 1 },
    config: {
      ...config,
      condition: Object.fromEntries(Object.entries(config.condition).map(([key, value]) => [key, BigInt(value)])),
      times: Object.fromEntries(Object.entries(config.times).map(([key, value]) => [key, BigInt(value)])),
    } as unknown as MarketView["config"],
  };
  app = { ...app, data: { ...app.data!, now: capture + 60 } };
  mocks.readNumericContext.mockImplementation(async () => ({ expected, chainTimestamp: capture + 60 }));
  const bundle = buildObservationBundle(raw, parseDailyExtractObservation(raw, "20260914", "DAILY_MAX_TEMPERATURE_C"));
  return { raw, capture, bundle };
}

/** Switches the panel to a football demo: ARS against CHE, Yes when ARS wins. */
function useSportsMarket() {
  const goal = NUMERIC_METRIC_PRESETS.find((item) => item.code === "GOAL_MARGIN")!;
  const config = {
    ...currentMarket.config, sourceId: encodeBytes32String("DEMO_FOOTBALL"), subjectId: encodeBytes32String("ARS_CHE_DEMO01"),
    condition: { metricId: 3n, comparison: 3n, lower: 0n, upper: 0n },
  };
  const plain = {
    ...config,
    condition: Object.fromEntries(Object.entries(config.condition).map(([key, value]) => [key, Number(value)])),
    times: Object.fromEntries(Object.entries(config.times).map(([key, value]) => [key, Number(value)])),
  } as unknown as NumericRulesChainExpectation["config"];
  const metric = {
    code: encodeBytes32String(goal.code), unit: encodeBytes32String(goal.unit), minValue: goal.minValue, maxValue: goal.maxValue,
    valueStep: goal.valueStep, allowsTrace: goal.allowsTrace, rulesHash: goal.rulesHash,
  };
  const context = { config: plain, metricId: 3, metric };
  const rulesDocument = buildSportsNumericRules({ title: "Will ARS win?", sport: "FOOTBALL", matchId: "ARS_CHE_DEMO01", teamA: "ARS", teamB: "CHE" }, context);
  const rulesHash = keccak256(toUtf8Bytes(rulesDocument));
  expected = { ...context, marketRulesHash: rulesHash };
  currentMarket = { ...currentMarket, config: config as unknown as MarketView["config"], metric: { ...goal, id: 3 }, rulesDocument, rulesHash, title: "Will ARS win?" };
  return new Uint8Array(readFileSync(new NodeURL("../../fixtures/demo/sports/football-ars-che.json", import.meta.url)));
}
const sportsResult = (overrides: Record<string, unknown> = {}) => toUtf8Bytes(JSON.stringify({
  schema: "RAINPOOL_SPORTS_DEMO_V1", synthetic: true, sport: "FOOTBALL", matchId: "ARS_CHE_DEMO01", teamA: "ARS", teamB: "CHE",
  scoreScope: "REGULATION_90", status: "FINAL", scoreA: 2, scoreB: 1, ...overrides,
}));

beforeEach(() => {
  vi.resetAllMocks();
  failures = [];
  const config = {
    proposer: ACCOUNT, sourceId: encodeBytes32String("WEEKLY_REPORT"),
    subjectId: encodeBytes32String("WEEKLY_RAINFALL"),
    condition: { metricId: 2, comparison: 4, lower: 2000, upper: 0 },
    times: {
      openAt: NOW - 600, closeAt: NOW - 500, observationStart: NOW - 400,
      observationEnd: NOW - 200, earliestAssertionAt: NOW - 100,
      proposalCutoff: NOW + 600, refundAt: NOW + 600 + 60 + 3600, assertionLiveness: 60,
    },
  };
  const metric = {
    ...weekly.definition, code: encodeBytes32String(weekly.definition.code), unit: encodeBytes32String(weekly.definition.unit),
    rulesHash: weekly.rulesHash,
  };
  const context = { config, metricId: 2, metric };
  const rulesDocument = buildCustomNumericRules({
    title: "Weekly rainfall at least 20 mm", sourceName: "Weekly report", sourceUrl: SOURCE_URL,
    procedure: "Read the weekly total in mm from the report.", metricRulesDocument: weekly.rulesDocument,
  }, context);
  const rulesHash = keccak256(toUtf8Bytes(rulesDocument));
  expected = { ...context, marketRulesHash: rulesHash };
  currentMarket = {
    id: 1, config: {
      ...config,
      condition: Object.fromEntries(Object.entries(config.condition).map(([key, value]) => [key, BigInt(value)])),
      times: Object.fromEntries(Object.entries(config.times).map(([key, value]) => [key, BigInt(value)])),
    },
    metric: { id: 2, ...weekly.definition, rulesHash: weekly.rulesHash }, rulesDocument, rulesHash, title: "Weekly rainfall at least 20 mm",
    state: { yesTotal: 10n, noTotal: 10n, paidOut: 0n, yesAccounts: 1n, noAccounts: 1n, terminal: 0n, refundReason: 0n },
    position: { side: 0n, claimed: false, stake: 0n }, claimable: 0n,
    assertion: { assertionId: ZeroHash, reading: { kind: 0n, value: 0n }, rawSha256: ZeroHash, proposedAt: 0n, disputed: false, returned: false, rejected: false },
    effectiveTerminal: 0n, effectiveRefundReason: 0n, mockResolutionReady: false,
  } as unknown as MarketView;
  mocks.numericContextForMarket.mockImplementation(() => expected);
  mocks.readNumericContext.mockImplementation(async () => ({ expected, chainTimestamp: NOW }));
  // checkProposal returns the outcome the contract would apply: 1 Yes, 2 No.
  mocks.checkProposal.mockResolvedValue(1n);
  mocks.previewClaim.mockResolvedValue(hexlify(toUtf8Bytes("NUMERIC_OBSERVATION_V1 preview")));
  mocks.propose.mockResolvedValue(tx);
  mocks.proposeStatic.mockResolvedValue(`0x${"33".repeat(32)}`);
  mocks.assertOracleSubmissionSupported.mockResolvedValue(undefined);
  mocks.marketOf.mockReturnValue({ checkProposal: mocks.checkProposal });
  mocks.adapterOf.mockReturnValue({ previewClaim: mocks.previewClaim, propose: Object.assign(mocks.propose, { staticCall: mocks.proposeStatic }) });
  mocks.tokenOf.mockReturnValue({ approve: vi.fn(async () => tx) });
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
      contracts: { PredictionMarket: { address: MARKET }, UmaMetricOracleAdapter: { address: "0x0000000000000000000000000000000000000022" } },
      oracle: { bondDecimals: 6, bondSymbol: "tBOND" } },
    wallet: { account: ACCOUNT, chainId: 31337, epoch: 1, isCorrectChain: true, getSigner: async () => signer },
    data: { now: NOW, bondAmount: 10000000n }, reader: {},
    run: mocks.run, action: mocks.action, busy: false, canWrite: true, isAdmin: true, ready: true,
  } as unknown as MetricApi;
  mocks.useMetricApp.mockImplementation(() => app);
});

describe("post-event numeric result submission", () => {
  it("does not send a new proposal after UMA removes its collateral", async () => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    mocks.assertOracleSubmissionSupported.mockRejectedValue(new Error("CollateralWhitelist removed token"));
    render(<MarketPanel market={currentMarket} />);
    await upload();
    await userEvent.click(proposeButton());
    await waitFor(() => expect(failures).toEqual(["CollateralWhitelist removed token"]));
    expect(mocks.assertOracleSubmissionSupported).toHaveBeenCalledWith(app.dep, signer);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it.each([true, false])("checks current UMA support before sending a dispute (supported=%s)", async (supported) => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    if (!supported) mocks.assertOracleSubmissionSupported.mockRejectedValue(new Error("IdentifierWhitelist removed identifier"));
    currentMarket = {
      ...currentMarket, assertion: { ...currentMarket.assertion, assertionId: `0x${"11".repeat(32)}` },
      oracleAssertion: { settled: false, expirationTime: BigInt(NOW + 60), bond: 10000000n } as MarketView["oracleAssertion"],
    };
    const disputeAssertion = vi.fn(async () => tx);
    mocks.oracleOf.mockReturnValue({ disputeAssertion });
    render(<MarketPanel market={currentMarket} />);
    await userEvent.click(screen.getByRole("button", { name: "Dispute assertion" }));
    expect(mocks.assertOracleSubmissionSupported).toHaveBeenCalledWith(app.dep, signer);
    if (supported) {
      expect(disputeAssertion).toHaveBeenCalledWith(currentMarket.assertion.assertionId, ACCOUNT);
      expect(failures).toEqual([]);
    } else {
      expect(disputeAssertion).not.toHaveBeenCalled();
      expect(failures).toEqual(["IdentifierWhitelist removed identifier"]);
    }
  });

  it("hides local time and manual dispute controls on Sepolia and requires live settlement readiness", () => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    currentMarket = {
      ...currentMarket, assertion: { ...currentMarket.assertion, assertionId: `0x${"11".repeat(32)}`, disputed: true },
      oracleAssertion: { settled: false, expirationTime: BigInt(NOW - 1), bond: 10000000n } as MarketView["oracleAssertion"],
      mockResolutionReady: true, settlementReady: false,
    };
    const view = render(<MarketPanel market={currentMarket} />);
    expect(screen.queryByText("Local time controls")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Simulate: assertion true" })).not.toBeInTheDocument();
    expect(screen.getByText(/Sepolia UMA OOv3 has no DVM dispute resolution/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Settle assertion" })).toBeDisabled();
    currentMarket = { ...currentMarket, settlementReady: true };
    view.rerender(<MarketPanel market={currentMarket} />);
    expect(screen.getByRole("button", { name: "Settle assertion" })).toBeEnabled();
  });

  it("approves the configured external OO for disputes instead of relying on a Mock deployment entry", async () => {
    const externalOracle = "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944";
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111,
      oracle: { ...app.dep.oracle, optimisticOracleV3: externalOracle } } };
    currentMarket = {
      ...currentMarket, assertion: { ...currentMarket.assertion, assertionId: `0x${"11".repeat(32)}` },
      oracleAssertion: { settled: false, expirationTime: BigInt(NOW + 60), bond: 10000000n } as MarketView["oracleAssertion"],
    };
    const approve = vi.fn(async () => tx);
    mocks.tokenOf.mockReturnValue({ approve });
    render(<MarketPanel market={currentMarket} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve oracle dispute bond" }));
    expect(approve).toHaveBeenCalledWith(externalOracle, 10000000n);
    expect(failures).toEqual([]);
  });

  it("rechecks real settlement before sending and aborts if the wallet changes during that check", async () => {
    app = { ...app, dep: { ...app.dep, environment: "SEPOLIA_UMA", chainId: 11155111 } };
    currentMarket = {
      ...currentMarket, assertion: { ...currentMarket.assertion, assertionId: `0x${"11".repeat(32)}` },
      oracleAssertion: { settled: false, expirationTime: BigInt(NOW - 1), bond: 10000000n } as MarketView["oracleAssertion"],
      settlementReady: true,
    };
    const pending = deferred<undefined>(), settle = vi.fn(async () => tx), staticCall = vi.fn(() => pending.promise);
    mocks.oracleOf.mockReturnValue({ settleAssertion: { staticCall } });
    mocks.adapterOf.mockReturnValue({ settle });
    const view = render(<MarketPanel market={currentMarket} />);
    await userEvent.click(screen.getByRole("button", { name: "Settle assertion" }));
    expect(staticCall).toHaveBeenCalledWith(currentMarket.assertion.assertionId);
    app = { ...app, wallet: { ...app.wallet, epoch: 2, chainId: 31337 } };
    view.rerender(<MarketPanel market={currentMarket} />);
    await act(async () => { pending.resolve(undefined); });
    await waitFor(() => expect(failures[0]).toContain("changed"));
    expect(settle).not.toHaveBeenCalled();
  });

  it("imports a sports demo's synthetic result file and submits its margin with the whole file as evidence", async () => {
    const raw = useSportsMarket();
    render(<MarketPanel market={currentMarket} />);
    expect(screen.getByText("Synthetic match results are for the demo only.")).toBeVisible();
    await upload(resultFile(raw, "football-ars-che.json"));
    await userEvent.click(previewButton());
    await waitFor(() => expect(mocks.previewClaim).toHaveBeenCalledOnce());
    expect(mocks.checkProposal).toHaveBeenCalledWith(1, ACCOUNT, { kind: 1, value: 100 }, sha256(raw));
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    expect(mocks.propose).toHaveBeenCalledWith(1, { kind: 1, value: 100 }, {
      sourceUrl: "onchain:UmaMetricOracleAdapter.EvidencePublished.excerpt", rawSha256: sha256(raw), capturedAt: NOW, excerpt: hexlify(raw),
    }, 10000000n);
    expect(failures).toEqual([]);
  });

  it.each([
    ["another match", { matchId: "OTHER_MATCH" }],
    ["reversed teams", { teamA: "CHE", teamB: "ARS" }],
    ["another score scope", { scoreScope: "INCLUDING_OVERTIME" }],
  ])("rejects a sports result for %s before any oracle transaction", async (_label, overrides) => {
    useSportsMarket();
    render(<MarketPanel market={currentMarket} />);
    await userEvent.upload(uploadInput(), resultFile(sportsResult(overrides), "result.json"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(proposeButton()).toBeDisabled();
    expect(mocks.previewClaim).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("requires a result file, preserves its BOM bytes and keeps acquisition time when previewing and submitting later", async () => {
    render(<MarketPanel market={currentMarket} />);
    expect(previewButton()).toBeDisabled();
    expect(proposeButton()).toBeDisabled();
    const raw = toUtf8Bytes(`\uFEFF${resultText()}\r\n`);
    await upload(resultFile(raw));
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText(sha256(raw))).not.toBeInTheDocument(); // shown short, never as the whole value
    expect(screen.queryByText(currentMarket.rulesHash)).not.toBeInTheDocument();

    mocks.readNumericContext.mockImplementation(async () => ({ expected, chainTimestamp: NOW + 10 }));
    await userEvent.click(previewButton());
    await waitFor(() => expect(mocks.previewClaim).toHaveBeenCalledOnce());
    expect(mocks.checkProposal).toHaveBeenCalledWith(1, ACCOUNT, { kind: 1, value: 2340 }, sha256(raw));
    const evidence = { sourceUrl: SOURCE_URL, rawSha256: sha256(raw), capturedAt: NOW, excerpt: hexlify(raw) };
    expect(mocks.previewClaim).toHaveBeenLastCalledWith(1, { kind: 1, value: 2340 }, evidence);
    expect(screen.getByText("Result checks passed.")).toBeVisible();
    expect(screen.queryByLabelText("Assertion preview")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Market rules")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download market rules" }));
    expect(mocks.downloadText).toHaveBeenCalledWith("market-1-rules.json", currentMarket.rulesDocument);

    mocks.readNumericContext.mockImplementation(async () => ({ expected, chainTimestamp: NOW + 20 }));
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    expect(mocks.propose).toHaveBeenCalledWith(1, { kind: 1, value: 2340 }, evidence, 10000000n);
    expect(mocks.checkProposal).toHaveBeenCalledTimes(2);
    expect(mocks.previewClaim).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([]);
  });

  it("imports a retained HKO snapshot using its original capture time, whole response hash and day excerpt", async () => {
    const { raw, capture, bundle } = useHkoMarket();
    render(<MarketPanel market={currentMarket} />);
    await upload(resultFile(toUtf8Bytes(JSON.stringify(bundle)), "hko-evidence.json"));
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    const evidence = {
      sourceUrl: raw.sourceURL, rawSha256: sha256(raw.bytes), capturedAt: capture,
      excerpt: hexlify(toUtf8Bytes(bundle.observation.excerpt)),
    };
    expect(mocks.propose).toHaveBeenCalledWith(1, { kind: 1, value: 2870 }, evidence, 10000000n);
    expect(evidence.rawSha256).not.toBe(sha256(evidence.excerpt));
    expect(failures).toEqual([]);
  });

  it("fetches HKO's monthly file through the page's server, or takes the same file imported by hand", async () => {
    const { raw, capture } = useHkoMarket();
    const official = dailyExtractMonthUrl("20260914");
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input) === viaPageServer(official)
      ? new Response(buffer(raw.bytes), { status: 200, headers: { "content-type": "text/xml" } }) : new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<MarketPanel market={currentMarket} />);
    await userEvent.click(screen.getByTestId("result-fetch"));
    await waitFor(() => expect(previewButton()).toBeEnabled());
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    // The page fixes the capture time at the chain time of the import, like any imported file.
    const evidence = { sourceUrl: official, rawSha256: sha256(raw.bytes), capturedAt: capture + 60, excerpt: hexlify(toUtf8Bytes(JSON.stringify(["14", "1014.1", "28.7", "27.8", "26.1", "24.8", "84", "88", " 37.9"]))) };
    expect(mocks.propose).toHaveBeenCalledWith(1, { kind: 1, value: 2870 }, evidence, 10000000n);
    view.unmount();
    mocks.propose.mockClear();
    render(<MarketPanel market={currentMarket} />);
    await upload(resultFile(raw.bytes, "dailyExtract_202609.xml"));
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    expect(mocks.propose).toHaveBeenCalledWith(1, { kind: 1, value: 2870 }, evidence, 10000000n);
    expect(failures).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("asks for the file by hand when the page has no relay, as on a static host", async () => {
    useHkoMarket();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><title>Rain or Shine</title>", { status: 200, headers: { "content-type": "text/html" } })));
    render(<MarketPanel market={currentMarket} />);
    await userEvent.click(screen.getByTestId("result-fetch"));
    const note = await screen.findByTestId("result-fetch-note");
    expect(note).toHaveTextContent("This page cannot read HKO's file directly. Open the file, save it, then import it here.");
    expect(within(note).getByRole("link", { name: "Open the HKO file" })).toHaveAttribute("href", dailyExtractMonthUrl("20260914"));
    expect(mocks.propose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses legacy creation rules instead of falling back to the old fixture path", () => {
    currentMarket = { ...currentMarket, rulesDocument: JSON.stringify({ schema: "RAINPOOL_METRIC_MARKET_V1", dataMode: "DEMO_FIXTURE" }) };
    render(<MarketPanel market={currentMarket} />);
    expect(proposeButton()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("does not restore a delayed file after the user clears it", async () => {
    render(<MarketPanel market={currentMarket} />);
    const pending = deferred<ArrayBuffer>();
    await userEvent.upload(uploadInput(), resultFile(toUtf8Bytes(resultText()), "delayed.json", () => pending.promise));
    await userEvent.click(clearButton());
    await act(async () => { pending.resolve(buffer(toUtf8Bytes(resultText()))); });
    expect(previewButton()).toBeDisabled();
    expect(proposeButton()).toBeDisabled();
    expect(screen.queryByText(/delayed.json/)).not.toBeInTheDocument();
  });

  it("keeps the newest result when an older read finishes last", async () => {
    render(<MarketPanel market={currentMarket} />);
    const pending = deferred<ArrayBuffer>();
    await userEvent.upload(uploadInput(), resultFile(toUtf8Bytes(resultText()), "old.json", () => pending.promise));
    const newer = toUtf8Bytes(resultText("31.0"));
    await upload(resultFile(newer, "new.txt"), "31.0");
    await act(async () => { pending.resolve(buffer(toUtf8Bytes(resultText()))); });
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.propose).toHaveBeenCalledOnce());
    expect(mocks.propose.mock.calls[0]?.[1]).toEqual({ kind: 1, value: 3100 });
    expect(mocks.propose.mock.calls[0]?.[2]).toMatchObject({ rawSha256: sha256(newer), excerpt: hexlify(newer) });
  });

  it("invalidates a pending import on wallet switch", async () => {
    const view = render(<MarketPanel market={currentMarket} />);
    const pending = deferred<ArrayBuffer>();
    await userEvent.upload(uploadInput(), resultFile(toUtf8Bytes(resultText()), "pending.json", () => pending.promise));
    app = { ...app, wallet: { ...app.wallet, account: "0x00000000000000000000000000000000000000b2", epoch: 2 } };
    view.rerender(<MarketPanel market={currentMarket} />);
    await act(async () => { pending.resolve(buffer(toUtf8Bytes(resultText()))); });
    expect(proposeButton()).toBeDisabled();
    expect(screen.queryByText(/pending.json/)).not.toBeInTheDocument();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("rejects a file imported before observation end even if it could be read after that boundary", async () => {
    mocks.readNumericContext.mockResolvedValueOnce({
      expected, chainTimestamp: Number(expected.config.times.observationEnd) - 1,
    });
    const read = vi.fn(async () => buffer(toUtf8Bytes(resultText())));
    render(<MarketPanel market={currentMarket} />);
    await userEvent.upload(uploadInput(), resultFile(toUtf8Bytes(resultText()), "early.json", read));
    expect(await screen.findByRole("alert")).toHaveTextContent("The observation period has not ended");
    expect(read).not.toHaveBeenCalled();
    expect(proposeButton()).toBeDisabled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("blocks an in-flight submission after the wallet network changes", async () => {
    const view = render(<MarketPanel market={currentMarket} />);
    await upload();
    const fresh = deferred<{ expected: NumericRulesChainExpectation; chainTimestamp: number }>();
    mocks.readNumericContext.mockReturnValue(fresh.promise);
    await userEvent.click(proposeButton());
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    app = { ...app, wallet: { ...app.wallet, chainId: 11155111, epoch: 2 } };
    view.rerender(<MarketPanel market={currentMarket} />);
    await act(async () => { fresh.resolve({ expected, chainTimestamp: NOW }); });
    await waitFor(() => expect(failures).toEqual([expect.stringContaining("changed")]));
    expect(mocks.checkProposal).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("blocks a pending submission when chain configuration no longer matches the committed rules", async () => {
    render(<MarketPanel market={currentMarket} />);
    await upload();
    mocks.readNumericContext.mockResolvedValue({
      expected: { ...expected, config: { ...expected.config, condition: { ...expected.config.condition, lower: 100 } } },
      chainTimestamp: NOW,
    });
    await userEvent.click(proposeButton());
    await waitFor(() => expect(failures.length).toBe(1));
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.previewClaim).not.toHaveBeenCalled();
  });
});
