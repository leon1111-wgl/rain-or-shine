import { describe, expect, it } from "vitest";
import { ZeroAddress, ZeroHash, encodeBytes32String } from "ethers";
import {
  CANONICAL_SEPOLIA_OOV3, SEPOLIA_BOND_CURRENCY, deployedContractNames, validateMetricManifest,
  type MetricContractDeployment, type MetricDeploymentManifest,
} from "../../src/metric/deployment.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = `0x${"12".repeat(32)}`;
function entry(n: number): MetricContractDeployment {
  return { address: addr(n), transactionHash: hash, blockNumber: 12,
    constructorArguments: [addr(1), 6], abiKeccak256: hash, runtimeCodeKeccak256: hash };
}
function local(): MetricDeploymentManifest {
  return {
    schemaVersion: 1, product: "rainpool-metric-v1", environment: "LOCAL_MOCK",
    network: "localhost", chainId: 31337, admin: addr(1), deployedAt: "2026-10-21T00:00:00Z",
    publicRpcUrl: "http://127.0.0.1:8545", bindingTransactionHash: hash,
    contracts: { PredictionMarket: entry(2), UmaMetricOracleAdapter: entry(3),
      TestBondToken: entry(4), MockOptimisticOracleV3: entry(5) },
    oracle: { optimisticOracleV3: addr(5), bondCurrency: addr(4), bondSymbol: "tBOND", bondDecimals: 6,
      policyBond: "10000000", minimumBond: "1000000", identifier: encodeBytes32String("ASSERT_TRUTH"), note: "LOCAL_MOCK" },
  };
}
function sepolia(): MetricDeploymentManifest {
  const result = local();
  result.environment = "SEPOLIA_UMA";
  result.network = "sepolia";
  result.chainId = 11155111;
  result.publicRpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
  delete result.contracts.TestBondToken;
  delete result.contracts.MockOptimisticOracleV3;
  result.oracle = { ...result.oracle, optimisticOracleV3: CANONICAL_SEPOLIA_OOV3,
    bondCurrency: SEPOLIA_BOND_CURRENCY, bondSymbol: "6TEST", minimumBond: "0", runtimeCodeKeccak256: hash,
    bondRuntimeCodeKeccak256: hash, dvmSupport: false, note: "SEPOLIA_UMA: no DVM" };
  return result;
}
function set(input: unknown, path: string, value: unknown) {
  const parts = path.split(".");
  let target = input as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}

describe("numeric deployment environments", () => {
  it("keeps the existing local four-contract manifest compatible", () => {
    const dep = validateMetricManifest(local());
    expect(dep.environment).toBe("LOCAL_MOCK");
    expect(deployedContractNames(dep)).toEqual([
      "PredictionMarket", "UmaMetricOracleAdapter", "TestBondToken", "MockOptimisticOracleV3",
    ]);
  });
  it("accepts Sepolia with only the two owned contracts and pinned external bytecode", () => {
    const dep = validateMetricManifest(sepolia());
    expect(deployedContractNames(dep)).toEqual(["PredictionMarket", "UmaMetricOracleAdapter"]);
    expect(dep.oracle.minimumBond).toBe("0");
  });
  it.each([null, [], "unparsed JSON", 11155111])("rejects a non-manifest: %j", value => {
    expect(() => validateMetricManifest(value)).toThrow();
  });
  it.each([
    ["product", "rainpool-v3"], ["schemaVersion", 2],
    ["environment", "FORK"], ["network", "sepolia"], ["chainId", 11155111],
    ["admin", ZeroAddress], ["admin", 12], ["bindingTransactionHash", ZeroHash],
    ["deployedAt", "invalid"], ["publicRpcUrl", null], ["publicRpcUrl", "ftp://host"],
    ["publicRpcUrl", "https://user:password@host"],
    ["contracts", null], ["contracts.PredictionMarket", []],
    ["contracts.PredictionMarket.address", addr(3)],
    ["contracts.PredictionMarket.transactionHash", "0x1234"],
    ["contracts.PredictionMarket.blockNumber", -1],
    ["contracts.PredictionMarket.blockNumber", 1.5],
    ["contracts.PredictionMarket.constructorArguments", {}],
    ["contracts.PredictionMarket.constructorArguments", [true]],
    ["contracts.PredictionMarket.constructorArguments", [1.5]],
    ["oracle", null], ["oracle.bondCurrency", addr(5)],
    ["oracle.optimisticOracleV3", addr(2)], ["oracle.bondCurrency", addr(3)],
    ["oracle.bondCurrency", addr(6)], ["oracle.optimisticOracleV3", addr(6)],
    ["oracle.bondSymbol", "  "], ["oracle.bondDecimals", -1], ["oracle.bondDecimals", 256],
    ["oracle.bondDecimals", "6"], ["oracle.policyBond", "-1"], ["oracle.minimumBond", "01"],
    ["oracle.policyBond", (1n << 256n).toString()], ["oracle.policyBond", 1], ["oracle.policyBond", "0"],
    ["oracle.identifier", ZeroHash], ["oracle.note", null],
  ])("rejects invalid local field %s = %j", (path, value) => {
    const dep = local();
    set(dep, path, value);
    expect(() => validateMetricManifest(dep)).toThrow();
  });
  it.each([
    ["network", "localhost"], ["chainId", 31337],
    ["oracle.optimisticOracleV3", addr(5)], ["oracle.dvmSupport", true],
    ["oracle.dvmSupport", undefined], ["oracle.runtimeCodeKeccak256", undefined],
    ["oracle.bondRuntimeCodeKeccak256", ZeroHash],
    ["oracle.bondCurrency", addr(4)], ["oracle.policyBond", "0"],
    ["contracts.MockOptimisticOracleV3", entry(5)],
    ["contracts.RainPoolFactory", entry(6)],
  ])("rejects misleading Sepolia field %s = %j", (path, value) => {
    const dep = sepolia();
    set(dep, path, value);
    expect(() => validateMetricManifest(dep)).toThrow();
  });
});
