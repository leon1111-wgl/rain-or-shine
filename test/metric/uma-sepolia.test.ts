import { readFileSync } from "node:fs";
import { Interface, ZeroAddress, ZeroHash, decodeBytes32String, encodeBytes32String, keccak256, parseEther, parseUnits, type Provider, type TransactionRequest } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_SEPOLIA_OOV3, ERC20_READ_ABI, OOV3_READ_ABI, SEPOLIA_BOND_CURRENCY, SEPOLIA_DEPLOY_GAS_LIMITS,
  assertUmaSepoliaReady, bondPolicy, deploymentBudget, readUmaSepoliaSnapshot, validateUmaSepoliaConfig,
  type UmaSepoliaConfig, type UmaSepoliaSnapshot,
} from "../../scripts/lib/uma-sepolia.js";

// The adapter pins this token on Sepolia, so the preflight configuration must select it.
const currency = SEPOLIA_BOND_CURRENCY;
const finder = "0x0000000000000000000000000000000000000022";
const idWhitelist = "0x0000000000000000000000000000000000000033";
const collateralWhitelist = "0x0000000000000000000000000000000000000044";
const store = "0x0000000000000000000000000000000000000055";
const dvm = "0x0000000000000000000000000000000000000066";
const oracleCode = "0x6000";
const tokenCode = "0x6001";
const config: UmaSepoliaConfig = {
  chainId: 11155111, optimisticOracleV3: CANONICAL_SEPOLIA_OOV3, selectedBondCurrency: currency,
  expected: {
    identifier: "ASSERT_TRUTH", runtimeCodeKeccak256: keccak256(oracleCode),
    bondRuntimeCodeKeccak256: keccak256(tokenCode),
  },
};
function snapshot(change: Partial<UmaSepoliaSnapshot> = {}): UmaSepoliaSnapshot {
  return {
    chainId: 11155111, blockNumber: 123, blockHash: `0x${"12".repeat(32)}`, blockTimestamp: 1800000000,
    oracle: CANONICAL_SEPOLIA_OOV3, oracleCodeHash: keccak256(oracleCode),
    currency, currencyCodeHash: keccak256(tokenCode),
    identifier: encodeBytes32String("ASSERT_TRUTH"), identifierSupported: true, identifierCached: true,
    finder, cachedOracle: dvm, finderOracle: dvm, dependencyCodePresent: true,
    currencySupported: true, currencyCached: true, cachedFinalFee: 0n, storeFinalFee: 0n,
    minimumBond: 0n, burnedBondPercentage: 500000000000000000n, symbol: "6TEST", decimals: 6,
    ...change,
  };
}
function fakeProvider() {
  const calls: TransactionRequest[] = [];
  const oo = new Interface(OOV3_READ_ABI);
  const token = new Interface(ERC20_READ_ABI);
  const locator = new Interface(["function getImplementationAddress(bytes32) view returns (address)"]);
  const ids = new Interface(["function isIdentifierSupported(bytes32) view returns (bool)"]);
  const whitelist = new Interface(["function isOnWhitelist(address) view returns (bool)"]);
  const fees = new Interface(["function computeFinalFee(address) view returns (tuple(uint256 rawValue))"]);
  const getNetwork = vi.fn(async () => ({ chainId: 11155111n }));
  const getBlock = vi.fn(async () => ({ number: 123, hash: snapshot().blockHash, timestamp: 1800000000 }));
  const getCode = vi.fn(async (address: string, blockTag: number): Promise<string> => {
    expect(blockTag).toBe(123);
    return address === CANONICAL_SEPOLIA_OOV3 ? oracleCode : address === currency ? tokenCode : "0x6002";
  });
  const provider = {
    getNetwork, getBlock, getCode,
    call: async (request: TransactionRequest) => {
      calls.push(request);
      expect(request.blockTag).toBe(123);
      const to = String(await request.to);
      const abi = to === CANONICAL_SEPOLIA_OOV3 ? oo : to === currency ? token : to === finder
        ? locator : to === idWhitelist ? ids : to === collateralWhitelist ? whitelist : fees;
      const parsed = abi.parseTransaction({ data: String(request.data) })!;
      let value: unknown[];
      if (parsed.name === "getImplementationAddress") {
        const addresses: Record<string, string> = { IdentifierWhitelist: idWhitelist, CollateralWhitelist: collateralWhitelist, Store: store, Oracle: dvm };
        value = [addresses[decodeBytes32String(String(parsed.args[0]))]];
      } else {
        const values: Record<string, unknown[]> = {
          defaultIdentifier: [encodeBytes32String("ASSERT_TRUTH")], finder: [finder], cachedOracle: [dvm],
          burnedBondPercentage: [500000000000000000n], cachedCurrencies: [true, 0n],
          getMinimumBond: [0n], symbol: ["6TEST"], decimals: [6], cachedIdentifiers: [true],
          isIdentifierSupported: [true], isOnWhitelist: [true], computeFinalFee: [[0n]],
        };
        const found = values[parsed.name];
        if (!found) throw new Error("Unexpected or non-read-only function " + parsed.name);
        value = found;
      }
      return abi.encodeFunctionResult(parsed.name, value);
    },
  };
  return { provider: provider as unknown as Provider, calls, getNetwork, getBlock, getCode };
}

describe("Sepolia UMA preflight", () => {
  it("accepts current zero-fee test-token state without treating zero as missing", () => {
    expect(() => assertUmaSepoliaReady(snapshot(), config)).not.toThrow();
    expect(bondPolicy(snapshot(), {})).toEqual({ policyBond: 1000000n, maxBond: 10000000n, bondAmount: 1000000n });
  });
  it("requires independently pinned canonical oracle and token code", () => {
    expect(() => validateUmaSepoliaConfig({ ...config, optimisticOracleV3: currency })).toThrow();
    expect(() => validateUmaSepoliaConfig({ ...config, selectedBondCurrency: ZeroAddress })).toThrow();
    expect(() => validateUmaSepoliaConfig({ ...config, selectedBondCurrency: finder })).toThrow(/6TEST/);
    expect(validateUmaSepoliaConfig(JSON.parse(readFileSync("config/uma-sepolia.json", "utf8"))).selectedBondCurrency)
      .toBe(SEPOLIA_BOND_CURRENCY);
    expect(() => validateUmaSepoliaConfig({ ...config, expected: { ...config.expected, bondRuntimeCodeKeccak256: ZeroHash } })).toThrow();
  });
  it("reads all dynamic dependencies at one block without a signer", async () => {
    const fake = fakeProvider();
    const value = await readUmaSepoliaSnapshot(fake.provider, config);
    expect(value).toEqual(snapshot());
    expect(() => assertUmaSepoliaReady(value, config)).not.toThrow();
    expect(fake.calls).toHaveLength(16);
    expect(fake.getCode).toHaveBeenCalledTimes(7);
    expect(fake.getBlock).toHaveBeenCalledWith("latest");
  });
  it("rejects a different chain before any contract calls", async () => {
    const fake = fakeProvider();
    fake.getNetwork.mockResolvedValue({ chainId: 31337n });
    await expect(readUmaSepoliaSnapshot(fake.provider, config)).rejects.toThrow(/11155111/);
    expect(fake.calls).toEqual([]);
  });
  it("rejects oracle code drift before trusting its getter results", async () => {
    const fake = fakeProvider();
    fake.getCode.mockResolvedValue("0x6003");
    await expect(readUmaSepoliaSnapshot(fake.provider, config)).rejects.toThrow(/OOv3 runtime/);
    expect(fake.calls).toEqual([]);
  });
  it("rejects a block reorganization instead of returning a mixed snapshot", async () => {
    const fake = fakeProvider();
    fake.getBlock.mockResolvedValueOnce({ number: 123, hash: snapshot().blockHash, timestamp: 1800000000 })
      .mockResolvedValueOnce({ number: 123, hash: ZeroHash, timestamp: 1800000000 });
    await expect(readUmaSepoliaSnapshot(fake.provider, config)).rejects.toThrow(/reorganized/);
  });
  it.each([
    ["unsupported identifier despite permissive cache", { identifierSupported: false, identifierCached: true }],
    ["different default identifier", { identifier: encodeBytes32String("ASSERT_TRUTH2") }],
    ["missing Finder dependency", { dependencyCodePresent: false }],
    ["stale cached Oracle", { cachedOracle: currency }],
    ["missing cached Oracle", { cachedOracle: ZeroAddress }],
    ["unsupported current collateral despite permissive cache", { currencySupported: false, currencyCached: true }],
    ["uncached collateral", { currencyCached: false }],
    ["stale final fee", { cachedFinalFee: 200000000n, storeFinalFee: 0n, minimumBond: 400000000n }],
    ["wrong minimum bond", { minimumBond: 1n }],
    ["zero burned percentage", { burnedBondPercentage: 0n }],
    ["burned percentage above one", { burnedBondPercentage: 1000000000000000001n }],
    ["invalid decimals", { decimals: 37 }],
  ] as const)("blocks %s", (_label, change) => {
    expect(() => assertUmaSepoliaReady(snapshot(change), config)).toThrow();
  });
  it("allows an empty identifier cache when the live whitelist accepts it, matching OOv3 lazy caching", () => {
    expect(() => assertUmaSepoliaReady(snapshot({ identifierCached: false }), config)).not.toThrow();
  });
  it("checks the actual integer minimum-bond formula from current Store fees", () => {
    expect(() => assertUmaSepoliaReady(snapshot({
      cachedFinalFee: 3n, storeFinalFee: 3n, minimumBond: 6n,
    }), config)).not.toThrow();
  });
});

describe("Sepolia deployment and bond cost caps", () => {
  const fee = { maxFeePerGas: parseUnits("0.1", "gwei"), maxPriorityFeePerGas: parseUnits("0.01", "gwei") };
  it("reserves the complete three-transaction budget before the first deployment", () => {
    const value = deploymentBudget(fee, parseEther("1"), {});
    expect(value.totalGasLimit).toBe(Object.values(SEPOLIA_DEPLOY_GAS_LIMITS).reduce((a, b) => a + b, 0n));
    expect(value.maximumCost).toBe(55300000n * fee.maxFeePerGas);
  });
  it("keeps the ETH ceiling when state-creation gas exceeds the old deployment budget", () => {
    expect(() => deploymentBudget({
      maxFeePerGas: parseUnits("1", "gwei"), maxPriorityFeePerGas: parseUnits("0.1", "gwei"),
    }, parseEther("1"), {})).toThrow(/MAX_DEPLOY_COST_ETH/);
  });
  it.each([
    ["missing EIP-1559 fees", { ...fee, maxFeePerGas: null }, parseEther("1"), {}],
    ["fee-rate cap", { ...fee, maxFeePerGas: parseUnits("21", "gwei") }, parseEther("1"), {}],
    ["invalid priority fee", { ...fee, maxPriorityFeePerGas: parseUnits("2", "gwei") }, parseEther("1"), {}],
    ["total deployment cap", fee, parseEther("1"), { MAX_DEPLOY_COST_ETH: "0.001" }],
    ["insufficient ETH for all three transactions", fee, parseEther("0.001"), {}],
  ])("rejects %s", (_label, fees, balance, env) => {
    expect(() => deploymentBudget(fees as typeof fee, balance as bigint, env as NodeJS.ProcessEnv)).toThrow();
  });
  it("uses the larger of policy and live minimum while respecting the maximum bond", () => {
    expect(bondPolicy(snapshot({ minimumBond: 2000000n }), {})).toMatchObject({ policyBond: 1000000n, bondAmount: 2000000n });
    expect(() => bondPolicy(snapshot({ minimumBond: 11000000n }), {})).toThrow(/SEPOLIA_MAX_BOND/);
    expect(() => bondPolicy(snapshot(), { SEPOLIA_POLICY_BOND: "-1" })).toThrow();
    expect(() => bondPolicy(snapshot(), { SEPOLIA_POLICY_BOND: "1e5" })).toThrow();
  });
});
