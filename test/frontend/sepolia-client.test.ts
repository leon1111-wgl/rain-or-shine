import { beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, ZeroAddress, encodeBytes32String, keccak256, toUtf8Bytes, type Provider } from "ethers";
import generatedAbi from "../../web/src/generated/metric-abi.json";
import { CANONICAL_SEPOLIA_OOV3, SEPOLIA_BOND_CURRENCY } from "../../src/metric/deployment";
import {
  assertOracleSubmissionSupported, localTokenOf, mockOracleOf, oracleOf, readAssertionStatus, selectMetricDeployment,
  tokenOf, verifyMetricDeployment, type MetricDeployment,
} from "../../web/src/metric/client";

const doubles = vi.hoisted(() => ({
  contracts: new Map<string, object>(),
  constructed: vi.fn(),
}));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class ContractStub {
    readonly target: string;
    constructor(address: string, ...rest: unknown[]) {
      this.target = address;
      doubles.constructed(address, ...rest);
      const contract = doubles.contracts.get(address.toLowerCase());
      if (!contract) throw new Error("Unexpected contract " + address);
      Object.assign(this, contract);
    }
  }
  return { ...actual, Contract: ContractStub };
});

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hash = (s: string) => keccak256(toUtf8Bytes(s));
const CODE = "0x60016001";
const OO_CODE = "0x60026002";
const TOKEN_CODE = "0x60036003";
const ADMIN = address(99), FINDER = address(97), WHITELIST = address(98), IDENTIFIERS = address(96);
const ID = hash("assertion");
const BLOCK = { number: 120, timestamp: 1000, hash: hash("block") };
type Name = keyof typeof generatedAbi;
function entry(name: Name, n: number) {
  return {
    address: address(n), transactionHash: hash(name), blockNumber: n,
    constructorArguments: [], abiKeccak256: hash(JSON.stringify(generatedAbi[name])),
    runtimeCodeKeccak256: keccak256(CODE),
  };
}
function deployment(local = false): MetricDeployment {
  return {
    schemaVersion: 1, product: "rainpool-metric-v1", environment: local ? "LOCAL_MOCK" : "SEPOLIA_UMA",
    network: local ? "localhost" : "sepolia", chainId: local ? 31337 : 11155111,
    publicRpcUrl: local ? "http://127.0.0.1:9" : "https://example.invalid",
    deployedAt: "2026-10-21T00:00:00Z", admin: ADMIN, bindingTransactionHash: hash("binding"),
    contracts: {
      PredictionMarket: entry("PredictionMarket", 1), UmaMetricOracleAdapter: entry("UmaMetricOracleAdapter", 2),
      ...(local ? { TestBondToken: entry("TestBondToken", 3), MockOptimisticOracleV3: entry("MockOptimisticOracleV3", 4) } : {}),
    },
    oracle: {
      optimisticOracleV3: local ? address(4) : CANONICAL_SEPOLIA_OOV3,
      bondCurrency: local ? address(3) : SEPOLIA_BOND_CURRENCY, bondSymbol: local ? "tBOND" : "6TEST", bondDecimals: 6,
      policyBond: "10000000", minimumBond: "0", identifier: encodeBytes32String("ASSERT_TRUTH"),
      note: "Test doubles; no network calls.",
      ...(local ? {} : {
        runtimeCodeKeccak256: keccak256(OO_CODE), bondRuntimeCodeKeccak256: keccak256(TOKEN_CODE),
        dvmSupport: false as const,
      }),
    },
  };
}

const settleCall = vi.fn();
const getAssertion = vi.fn();
const getAssertionResult = vi.fn();
const mockReady = vi.fn(), mockAnswer = vi.fn();
const tokenDecimals = vi.fn(), tokenSymbol = vi.fn();
const whitelistCheck = vi.fn(), getImplementationAddress = vi.fn(), finderAddress = vi.fn();
const identifierCheck = vi.fn(), localWhitelistCheck = vi.fn();
const providerMethods = {
  getNetwork: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), getTransactionReceipt: vi.fn(),
};
const provider = providerMethods as unknown as Provider;
function prepare(dep: MetricDeployment) {
  doubles.contracts.set(dep.contracts.PredictionMarket.address.toLowerCase(), {
    oracleAdapter: vi.fn(async () => dep.contracts.UmaMetricOracleAdapter.address), metricAdmin: vi.fn(async () => dep.admin),
  });
  doubles.contracts.set(dep.contracts.UmaMetricOracleAdapter.address.toLowerCase(), {
    market: vi.fn(async () => dep.contracts.PredictionMarket.address),
    oov3: vi.fn(async () => dep.oracle.optimisticOracleV3),
    bondCurrency: vi.fn(async () => dep.oracle.bondCurrency),
    policyBond: vi.fn(async () => BigInt(dep.oracle.policyBond)),
    identifier: vi.fn(async () => dep.oracle.identifier),
  });
  tokenDecimals.mockResolvedValue(6n); tokenSymbol.mockResolvedValue(dep.oracle.bondSymbol);
  doubles.contracts.set(dep.oracle.bondCurrency.toLowerCase(), { decimals: tokenDecimals, symbol: tokenSymbol });
  doubles.contracts.set(dep.oracle.optimisticOracleV3.toLowerCase(), {
    defaultIdentifier: vi.fn(async () => dep.oracle.identifier),
    getAssertion, getAssertionResult, settleAssertion: { staticCall: settleCall },
    admin: vi.fn(async () => dep.admin), isWhitelisted: localWhitelistCheck,
    hasSimulatedResolution: mockReady, simulatedResolution: mockAnswer,
    getFunction: (name: string) => { if (name !== "finder") throw new Error(name); return finderAddress; },
  });
  doubles.contracts.set(FINDER.toLowerCase(), {
    getFunction: (name: string) => { if (name !== "getImplementationAddress") throw new Error(name); return getImplementationAddress; },
  });
  doubles.contracts.set(WHITELIST.toLowerCase(), {
    getFunction: (name: string) => { if (name !== "isOnWhitelist") throw new Error(name); return whitelistCheck; },
  });
  doubles.contracts.set(IDENTIFIERS.toLowerCase(), {
    getFunction: (name: string) => { if (name !== "isIdentifierSupported") throw new Error(name); return identifierCheck; },
  });
  finderAddress.mockResolvedValue(FINDER);
  getImplementationAddress.mockImplementation(async (name: string) => {
    if (name === encodeBytes32String("CollateralWhitelist")) return WHITELIST;
    if (name === encodeBytes32String("IdentifierWhitelist")) return IDENTIFIERS;
    throw new Error("Unexpected Finder lookup");
  });
  whitelistCheck.mockResolvedValue(true); identifierCheck.mockResolvedValue(true); localWhitelistCheck.mockResolvedValue(true);
  providerMethods.getNetwork.mockResolvedValue({ chainId: BigInt(dep.chainId) });
  providerMethods.getBlock.mockResolvedValue(BLOCK);
  providerMethods.getCode.mockImplementation(async (target: string) => {
    if (dep.environment === "SEPOLIA_UMA" && target === dep.oracle.optimisticOracleV3) return OO_CODE;
    if (dep.environment === "SEPOLIA_UMA" && target === dep.oracle.bondCurrency) return TOKEN_CODE;
    return CODE;
  });
  providerMethods.getTransactionReceipt.mockImplementation(async (tx: string) => {
    if (tx === dep.bindingTransactionHash) return { status: 1, to: dep.contracts.PredictionMarket.address };
    const own = Object.values(dep.contracts).find((c) => c.transactionHash === tx);
    if (!own) throw new Error("Requested nonexistent external deployment receipt");
    return { status: 1, blockNumber: own.blockNumber, contractAddress: own.address };
  });
}

beforeEach(() => {
  vi.resetAllMocks(); doubles.contracts.clear();
  getAssertion.mockResolvedValue({ settled: false, disputer: ZeroAddress, expirationTime: 900n });
  mockReady.mockResolvedValue(false); mockAnswer.mockResolvedValue(false);
  settleCall.mockResolvedValue(undefined);
});

describe("explicit numeric deployment selection", () => {
  it("selects only the requested network and defaults to local", () => {
    const local = deployment(true), sepolia = deployment();
    const source = { deployments: { "31337": local, "11155111": sepolia } };
    expect(selectMetricDeployment(source, "31337")).toBe(local);
    expect(selectMetricDeployment(source, "11155111")).toBe(sepolia);
    vi.stubEnv("VITE_TARGET_CHAIN_ID", undefined);
    try { expect(selectMetricDeployment(source)).toBe(local); } finally { vi.unstubAllEnvs(); }
  });
  it("requires Sepolia deployment rather than falling back to existing local contracts", () => {
    expect(() => selectMetricDeployment({ deployments: { "31337": deployment(true) } }, "11155111")).toThrow(/Sepolia/);
    expect(() => selectMetricDeployment({ deployments: { "11155111": deployment() } }, "31337")).toThrow();
    expect(() => selectMetricDeployment({ deployments: {} }, "1")).toThrow();
  });
  it("refuses mismatched network metadata and stale exported ABI", () => {
    const dep = deployment();
    expect(() => selectMetricDeployment({ deployments: { "31337": dep } }, "31337")).toThrow();
    dep.contracts.PredictionMarket.abiKeccak256 = hash("different ABI");
    expect(() => selectMetricDeployment({ deployments: { "11155111": dep } }, "11155111")).toThrow(/ABI/);
  });
  it("refuses Sepolia with mock addresses or an unsupported DVM claim", () => {
    const dep = deployment();
    expect(() => selectMetricDeployment({ deployments: { "11155111": {
      ...dep, oracle: { ...dep.oracle, optimisticOracleV3: address(4) },
    } } }, "11155111")).toThrow();
    expect(() => selectMetricDeployment({ deployments: { "11155111": {
      ...dep, oracle: { ...dep.oracle, dvmSupport: true },
    } } }, "11155111")).toThrow();
  });
});

describe("Sepolia deployment verification", () => {
  it.each(["PredictionMarket", "UmaMetricOracleAdapter", "binding"] as const)("explains an unavailable %s receipt without accepting the deployment", async (name) => {
    const dep = deployment(); prepare(dep);
    const original = providerMethods.getTransactionReceipt.getMockImplementation()!;
    const missing = name === "binding" ? dep.bindingTransactionHash : dep.contracts[name].transactionHash;
    providerMethods.getTransactionReceipt.mockImplementation(async (tx: string) => tx === missing ? null : original(tx));
    await expect(verifyMetricDeployment(dep, provider)).rejects.toThrow(/receipt is unavailable from this RPC/);
  });
  it.each(["status", "block", "address", "code"] as const)("still rejects a deployment with mismatched %s", async (field) => {
    const dep = deployment(); prepare(dep);
    const entry = dep.contracts.PredictionMarket;
    const original = providerMethods.getTransactionReceipt.getMockImplementation()!;
    providerMethods.getTransactionReceipt.mockImplementation(async (tx: string) => {
      const receipt = await original(tx);
      if (tx !== entry.transactionHash) return receipt;
      return { ...receipt, ...(field === "status" ? { status: 0 } : field === "block" ? { blockNumber: entry.blockNumber + 1 } : field === "address" ? { contractAddress: address(99) } : {}) };
    });
    if (field === "code") providerMethods.getCode.mockResolvedValue("0x1234");
    await expect(verifyMetricDeployment(dep, provider)).rejects.toThrow(/does not match the deployment/);
  });
  it("checks app deployment receipts and external bytecode and token metadata independently of admission policy", async () => {
    const dep = deployment(); prepare(dep);
    await verifyMetricDeployment(dep, provider);
    expect(providerMethods.getTransactionReceipt.mock.calls.map(([tx]) => tx).sort()).toEqual([
      dep.contracts.PredictionMarket.transactionHash, dep.contracts.UmaMetricOracleAdapter.transactionHash, dep.bindingTransactionHash,
    ].sort());
    expect(providerMethods.getCode).toHaveBeenCalledWith(dep.oracle.optimisticOracleV3, BLOCK.number);
    expect(providerMethods.getCode).toHaveBeenCalledWith(dep.oracle.bondCurrency, BLOCK.number);
    expect(getImplementationAddress).not.toHaveBeenCalled();
    expect(whitelistCheck).not.toHaveBeenCalled();
    expect(mockReady).not.toHaveBeenCalled();
  });
  it.each(["oracle", "token"] as const)("rejects changed external %s code", async (which) => {
    const dep = deployment(); prepare(dep);
    const original = providerMethods.getCode.getMockImplementation()!;
    const wrong = which === "oracle" ? dep.oracle.optimisticOracleV3 : dep.oracle.bondCurrency;
    providerMethods.getCode.mockImplementation(async (target: string) => target === wrong ? "0x" : original(target));
    await expect(verifyMetricDeployment(dep, provider)).rejects.toThrow(/code/);
  });
  it("keeps deployment verification available after token removal but refuses new oracle submissions", async () => {
    const dep = deployment(); prepare(dep); whitelistCheck.mockResolvedValue(false);
    await expect(verifyMetricDeployment(dep, provider)).resolves.toBeUndefined();
    await expect(assertOracleSubmissionSupported(dep, provider)).rejects.toThrow(/CollateralWhitelist/);
  });
  it("checks both live UMA whitelists before new submissions", async () => {
    const dep = deployment(); prepare(dep);
    await assertOracleSubmissionSupported(dep, provider);
    expect(getImplementationAddress).toHaveBeenCalledWith(encodeBytes32String("CollateralWhitelist"), { blockTag: "latest" });
    expect(getImplementationAddress).toHaveBeenCalledWith(encodeBytes32String("IdentifierWhitelist"), { blockTag: "latest" });
    expect(whitelistCheck).toHaveBeenCalledWith(dep.oracle.bondCurrency, { blockTag: "latest" });
    expect(identifierCheck).toHaveBeenCalledWith(dep.oracle.identifier, { blockTag: "latest" });
    identifierCheck.mockResolvedValue(false);
    await expect(verifyMetricDeployment(dep, provider)).resolves.toBeUndefined();
    await expect(assertOracleSubmissionSupported(dep, provider)).rejects.toThrow(/IdentifierWhitelist/);
  });
  it("also preserves local deployment reads after mock token removal", async () => {
    const dep = deployment(true); prepare(dep); localWhitelistCheck.mockResolvedValue(false);
    await expect(verifyMetricDeployment(dep, provider)).resolves.toBeUndefined();
    expect(localWhitelistCheck).not.toHaveBeenCalled();
    await expect(assertOracleSubmissionSupported(dep, provider)).rejects.toThrow(/support/);
    expect(finderAddress).not.toHaveBeenCalled();
  });
  it("rejects a wrong RPC chain before reading contract addresses", async () => {
    const dep = deployment(); prepare(dep); providerMethods.getNetwork.mockResolvedValue({ chainId: 31337n });
    await expect(verifyMetricDeployment(dep, provider)).rejects.toThrow(/RPC network mismatch/);
    expect(doubles.constructed).not.toHaveBeenCalled();
  });
  it("rejects token metadata that no longer agrees with the manifest", async () => {
    const dep = deployment(); prepare(dep); tokenDecimals.mockResolvedValue(18n);
    await expect(verifyMetricDeployment(dep, provider)).rejects.toThrow(/bindings/);
  });
  it("still verifies all four local deployments without calling the Sepolia whitelist", async () => {
    const dep = deployment(true); prepare(dep);
    await verifyMetricDeployment(dep, provider);
    expect(providerMethods.getTransactionReceipt).toHaveBeenCalledTimes(5);
    expect(finderAddress).not.toHaveBeenCalled();
  });
});

describe("real OO settlement readiness and local-only methods", () => {
  it("uses a settlement simulation for an expired assertion, not the unresolved result getter", async () => {
    const dep = deployment(); prepare(dep);
    const result = await readAssertionStatus(dep, provider, ID, BLOCK);
    expect(result.settlementReady).toBe(true);
    expect(settleCall).toHaveBeenCalledWith(ID, { blockTag: BLOCK.number });
    expect(getAssertionResult).not.toHaveBeenCalled();
    expect(mockReady).not.toHaveBeenCalled();
  });
  it("keeps an unresolved dispute un-settleable after challenge expiry", async () => {
    const dep = deployment(); prepare(dep);
    getAssertion.mockResolvedValue({ settled: false, disputer: address(55), expirationTime: 900n });
    settleCall.mockRejectedValue(Object.assign(new Error("DVM answer unavailable"), { code: "CALL_EXCEPTION" }));
    const result = await readAssertionStatus(dep, provider, ID, BLOCK);
    expect(result.settlementReady).toBe(false);
    expect(result.settlementUnavailable).toContain("not available yet");
    expect(getAssertionResult).not.toHaveBeenCalled();
  });
  it("accepts a disputed assertion only when actual settlement simulation succeeds", async () => {
    const dep = deployment(); prepare(dep);
    getAssertion.mockResolvedValue({ settled: false, disputer: address(55), expirationTime: 1100n });
    expect((await readAssertionStatus(dep, provider, ID, BLOCK)).settlementReady).toBe(true);
    expect(settleCall).toHaveBeenCalledOnce();
  });
  it.each([
    { settled: true, disputer: ZeroAddress, expirationTime: 900n },
    { settled: false, disputer: ZeroAddress, expirationTime: 1100n },
  ])("does not treat settled or still-challengeable assertions as ready", async (assertion) => {
    const dep = deployment(); prepare(dep); getAssertion.mockResolvedValue(assertion);
    expect((await readAssertionStatus(dep, provider, ID, BLOCK)).settlementReady).toBe(false);
    expect(settleCall).not.toHaveBeenCalled();
  });
  it("surfaces RPC failure rather than reporting a chain decision to refuse settlement", async () => {
    const dep = deployment(); prepare(dep);
    settleCall.mockRejectedValue(new Error("RPC offline"));
    await expect(readAssertionStatus(dep, provider, ID, BLOCK)).rejects.toThrow("RPC offline");
  });
  it("retains local manual dispute resolution without using real settlement preflight", async () => {
    const dep = deployment(true); prepare(dep);
    getAssertion.mockResolvedValue({ settled: false, disputer: address(55), expirationTime: 900n });
    expect((await readAssertionStatus(dep, provider, ID, BLOCK)).settlementReady).toBe(false);
    mockReady.mockResolvedValue(true); mockAnswer.mockResolvedValue(false);
    expect(await readAssertionStatus(dep, provider, ID, BLOCK)).toMatchObject({
      settlementReady: true, mockResolutionReady: true, mockResolution: false,
    });
    expect(settleCall).not.toHaveBeenCalled();
  });
  it("rejects mint and mock helpers on Sepolia before constructing a contract", () => {
    const dep = deployment(); prepare(dep);
    expect(() => localTokenOf(dep, provider)).toThrow(/local chain only/);
    expect(() => mockOracleOf(dep, provider)).toThrow(/local chain only/);
    expect(doubles.constructed).not.toHaveBeenCalled();
  });
  it("uses external token/OO addresses and generic ABIs without local mint or DVM simulation", () => {
    const dep = deployment(); prepare(dep); tokenOf(dep, provider); oracleOf(dep, provider);
    const [tokenAddress, tokenAbi] = doubles.constructed.mock.calls[0]!;
    const [ooAddress, ooAbi] = doubles.constructed.mock.calls[1]!;
    expect(tokenAddress).toBe(dep.oracle.bondCurrency); expect(ooAddress).toBe(CANONICAL_SEPOLIA_OOV3);
    expect(new Interface(tokenAbi).getFunction("mint")).toBeNull();
    expect(new Interface(tokenAbi).getFunction("approve")).not.toBeNull();
    expect(new Interface(ooAbi).getFunction("simulateDvmResolution")).toBeNull();
  });
});
