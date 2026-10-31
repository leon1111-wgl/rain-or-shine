import { beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, encodeBytes32String, keccak256, toUtf8Bytes, type Provider } from "ethers";
import { PredictionMarket__factory } from "../../types/ethers-contracts/factories/PredictionMarket__factory";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules } from "../../src/metric/numeric-profiles";
import { hkDayWindow } from "../../src/weather/profile";
import { assertNumericMarketRulesMatchChain, type NumericRulesContext } from "../../src/metric/numeric-rules";
import {
  assertNumericMarketAbi, numericContextForMarket, readNumericContext,
  selectMetricDeployment, verifyMetricDeployment,
  type MarketView, type MetricDeployment,
} from "../../web/src/metric/client";

const mocks = vi.hoisted(() => {
  const condition = "(uint32 metricId,uint8 comparison,int32 lower,int32 upper)";
  const times = "(uint64 openAt,uint64 closeAt,uint64 observationStart,uint64 observationEnd,uint64 earliestAssertionAt,uint64 proposalCutoff,uint64 refundAt,uint64 assertionLiveness)";
  const config = `(uint8 dataMode,address proposer,bytes32 sourceId,bytes32 subjectId,${condition} condition,${times} times)`;
  return {
    // 独立保存旧接口：重新部署、导出新版 ABI 后，这项回归测试仍然有效。
    oldAbi: [
      `function createMarket(${config} config,bytes rulesDocument) returns (uint256 marketId)`,
      `function getMarketConfig(uint256 marketId) view returns (${config} config)`,
    ],
    constructed: vi.fn(),
    getMarketConfig: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getMetric: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    marketRulesHash: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
});

vi.mock("../../web/src/generated/metric-abi.json", () => ({
  default: {
    PredictionMarket: mocks.oldAbi,
    UmaMetricOracleAdapter: [],
    TestBondToken: [],
    MockOptimisticOracleV3: [],
  },
}));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class ContractStub {
    getMarketConfig = mocks.getMarketConfig;
    getMetric = mocks.getMetric;
    marketRulesHash = mocks.marketRulesHash;
    constructor(...args: unknown[]) { mocks.constructed(...args); }
  }
  return { ...actual, Contract: ContractStub };
});

const hash = (text: string) => keccak256(toUtf8Bytes(text));
const HASH = `0x${"11".repeat(32)}`;
const OTHER_HASH = `0x${"22".repeat(32)}`;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
// The rainfall market observes 3 Nov 2026 in Hong Kong. The block below is two minutes after that day ends.
const DAY = hkDayWindow("20261103");
const START = Number(DAY.end);
const address = (value: number) => `0x${String(value).padStart(40, "0")}`;
const deploymentContract = (value: number, abi: readonly string[] = []) => ({
  address: address(value), transactionHash: HASH, blockNumber: 1,
  constructorArguments: [], abiKeccak256: hash(JSON.stringify(abi)), runtimeCodeKeccak256: HASH,
});
const dep: MetricDeployment = {
  schemaVersion: 1, product: "rainpool-metric-v1", environment: "LOCAL_MOCK",
  network: "localhost", chainId: 31337, publicRpcUrl: "http://127.0.0.1:9",
  deployedAt: "2026-10-20T00:00:00Z", admin: ACCOUNT, bindingTransactionHash: HASH,
  contracts: {
    PredictionMarket: deploymentContract(1, mocks.oldAbi),
    UmaMetricOracleAdapter: deploymentContract(2),
    TestBondToken: deploymentContract(3),
    MockOptimisticOracleV3: deploymentContract(4),
  },
  oracle: {
    optimisticOracleV3: address(4), bondCurrency: address(3), bondSymbol: "tBOND",
    bondDecimals: 6, policyBond: "10000000", minimumBond: "0", identifier: HASH,
    note: "Unit-test metadata only; no RPC connection is created.",
  },
};

const preset = NUMERIC_METRIC_PRESETS.find((item) => item.key === "rainfall")!;
const base: NumericRulesContext = {
  metricId: 2,
  metric: {
    code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit),
    minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep,
    allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash,
  },
  config: {
    proposer: ACCOUNT, sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"),
    subjectId: encodeBytes32String("HKO"),
    condition: { metricId: 2, comparison: 4, lower: 100, upper: 0 },
    times: {
      openAt: Number(DAY.start) - 120, closeAt: Number(DAY.start) - 60, observationStart: Number(DAY.start),
      observationEnd: START, earliestAssertionAt: START + 60,
      proposalCutoff: START + 3660, refundAt: START + 3660 + 60 + 3600, assertionLiveness: 60,
    },
  },
};
const rulesDocument = buildHkoNumericRules({ title: "11月3日天文台总部降雨量至少 1.0 毫米？", targetDate: "20261103" }, base);
const rulesHash = hash(rulesDocument);
const iface = new Interface(PredictionMarket__factory.abi);
// 真正执行 ABI 解码，使 named Result tuple 与 bigint 的兼容性也得到验证。
const configTuple = iface.decodeFunctionResult(
  "getMarketConfig", iface.encodeFunctionResult("getMarketConfig", [base.config]),
)[0] as MarketView["config"];
const metricTuple = iface.decodeFunctionResult(
  "getMetric", iface.encodeFunctionResult("getMetric", [base.metric]),
)[0] as NumericRulesContext["metric"];
const displayMarket = {
  id: 7, config: configTuple, rulesDocument, rulesHash, title: "11月3日天文台总部降雨量至少 1.0 毫米？",
  metric: {
    id: 2, code: preset.code, unit: preset.unit, minValue: preset.minValue,
    maxValue: preset.maxValue, valueStep: preset.valueStep,
    allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash,
  },
} as MarketView;

interface BlockStub { number: number; hash: string | null; timestamp: number }
const block: BlockStub = { number: 123, hash: HASH, timestamp: START + 120 };
const readerMethods = {
  getNetwork: vi.fn<() => Promise<{ chainId: bigint }>>(),
  getBlock: vi.fn<(tag: string | number) => Promise<BlockStub | null>>(),
};
const reader = readerMethods as unknown as Provider;

beforeEach(() => {
  vi.resetAllMocks();
  readerMethods.getNetwork.mockResolvedValue({ chainId: 31337n });
  readerMethods.getBlock.mockResolvedValue({ ...block });
  mocks.getMarketConfig.mockResolvedValue(configTuple);
  mocks.getMetric.mockResolvedValue(metricTuple);
  mocks.marketRulesHash.mockResolvedValue(rulesHash);
});

describe("numeric ABI and deployment boundary", () => {
  it("accepts the freshly generated contract ABI with the five-field MarketConfig", () => {
    expect(() => assertNumericMarketAbi(PredictionMarket__factory.abi)).not.toThrow();
    expect(iface.getFunction("createMarket")!.inputs[0]!.components!.map((field) => [field.name, field.baseType])).toEqual([
      ["proposer", "address"], ["sourceId", "bytes32"], ["subjectId", "bytes32"],
      ["condition", "tuple"], ["times", "tuple"],
    ]);
  });

  it("rejects old dataMode interfaces even when the old manifest ABI hashes match", async () => {
    expect(dep.contracts.PredictionMarket.abiKeccak256).toBe(hash(JSON.stringify(mocks.oldAbi)));
    expect(() => assertNumericMarketAbi(mocks.oldAbi)).toThrow(/deploy:metric:local/);
    expect(() => selectMetricDeployment({ deployments: { "31337": dep } })).toThrow(/deploy:metric:local/);
    await expect(verifyMetricDeployment(dep, reader)).rejects.toThrow(/deploy:metric:local/);
    expect(readerMethods.getNetwork).not.toHaveBeenCalled();
    expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it("rejects a mixed export whose create input is new but config read output is old", () => {
    const withoutRead = PredictionMarket__factory.abi.filter((entry) =>
      !(entry.type === "function" && entry.name === "getMarketConfig"));
    expect(() => assertNumericMarketAbi([...withoutRead, mocks.oldAbi[1]!])).toThrow(/deploy:metric:local/);
    expect(() => assertNumericMarketAbi([])).toThrow(/deploy:metric:local/);
  });
});

describe("numeric context binding", () => {
  it("reconstructs the full display context from chain config, metric and market hash", () => {
    const expected = numericContextForMarket(displayMarket);
    expect(expected.config).toBe(configTuple);
    expect(expected.metricId).toBe(2);
    expect(expected.metric).toEqual(base.metric);
    expect(expected.marketRulesHash).toBe(rulesHash);
    const checked = assertNumericMarketRulesMatchChain(rulesDocument, expected);
    expect(checked.config.times).toEqual(base.config.times);
    expect(checked.config.condition).toEqual(base.config.condition);
    expect(checked.config.sourceId).toBe("HKO_DAILY_EXTRACT");
    expect(checked.config.subjectId).toBe("HKO");
    expect(checked.config.proposer).toBe(ACCOUNT);
  });

  it("does not replace independent metric identity or hashes with document claims", () => {
    const changes: MarketView[] = [
      { ...displayMarket, rulesHash: OTHER_HASH },
      { ...displayMarket, metric: { ...displayMarket.metric, id: 3 } },
      { ...displayMarket, metric: { ...displayMarket.metric, rulesHash: OTHER_HASH } },
      { ...displayMarket, metric: { ...displayMarket.metric, valueStep: 200 } },
    ];
    for (const changed of changes) {
      expect(() => assertNumericMarketRulesMatchChain(rulesDocument, numericContextForMarket(changed))).toThrow();
    }
  });

  it("reads config, metric and hash at one block and returns that block's chain time", async () => {
    const result = await readNumericContext(dep, reader, 7);
    expect(readerMethods.getBlock.mock.calls).toEqual([["latest"], [123]]);
    expect(mocks.getMarketConfig.mock.calls).toEqual([[7, { blockTag: 123 }]]);
    expect(mocks.getMetric.mock.calls).toEqual([[2n, { blockTag: 123 }]]);
    expect(mocks.marketRulesHash.mock.calls).toEqual([[7, { blockTag: 123 }]]);
    expect(mocks.constructed.mock.calls).toEqual([[dep.contracts.PredictionMarket.address, mocks.oldAbi, reader]]);
    expect(result.chainTimestamp).toBe(block.timestamp);
    expect(result.expected.config).toBe(configTuple);
    expect(result.expected.metric).toBe(metricTuple);
    expect(result.expected.marketRulesHash).toBe(rulesHash);
    expect(() => assertNumericMarketRulesMatchChain(rulesDocument, result.expected)).not.toThrow();
  });

  it("refuses a wrong RPC chain or an unavailable latest block before reading contracts", async () => {
    readerMethods.getNetwork.mockResolvedValueOnce({ chainId: 1n });
    await expect(readNumericContext(dep, reader, 7)).rejects.toThrow(/network/);
    for (const unavailable of [null, { ...block, hash: null }]) {
      readerMethods.getBlock.mockResolvedValueOnce(unavailable);
      await expect(readNumericContext(dep, reader, 7)).rejects.toThrow(/latest block/);
    }
    expect(mocks.constructed).not.toHaveBeenCalled();
    expect(mocks.getMarketConfig).not.toHaveBeenCalled();
  });

  it("discards the read when its block was replaced or disappeared", async () => {
    for (const changed of [{ ...block, hash: OTHER_HASH }, null]) {
      readerMethods.getBlock.mockResolvedValueOnce({ ...block }).mockResolvedValueOnce(changed);
      await expect(readNumericContext(dep, reader, 7)).rejects.toThrow(/reorganized or restarted/);
    }
    expect(mocks.getMarketConfig).toHaveBeenCalledTimes(2);
    expect(mocks.getMetric).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid IDs before any provider or contract operation", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readNumericContext(dep, reader, id)).rejects.toThrow(/market ID/);
    }
    expect(readerMethods.getNetwork).not.toHaveBeenCalled();
    expect(readerMethods.getBlock).not.toHaveBeenCalled();
    expect(mocks.constructed).not.toHaveBeenCalled();
  });
});
