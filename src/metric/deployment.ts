import { getAddress, ZeroAddress, ZeroHash } from "ethers";

export const CANONICAL_SEPOLIA_OOV3 = "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944";
/** UmaMetricOracleAdapter.SEPOLIA_BOND_CURRENCY: the UMA-whitelisted 6TEST token. */
export const SEPOLIA_BOND_CURRENCY = "0x3870419Ba2BBf0127060bCB37f69A1b1C090992B";
export const CORE_CONTRACT_NAMES = ["PredictionMarket", "UmaMetricOracleAdapter"] as const;
export const LOCAL_CONTRACT_NAMES = ["TestBondToken", "MockOptimisticOracleV3"] as const;
export type MetricContractName = typeof CORE_CONTRACT_NAMES[number] | typeof LOCAL_CONTRACT_NAMES[number];
export type MetricNetwork = "localhost" | "sepolia";

export interface MetricContractDeployment {
  address: string;
  transactionHash: string;
  blockNumber: number;
  constructorArguments: (string | number)[];
  abiKeccak256: string;
  runtimeCodeKeccak256: string;
}

export interface MetricDeploymentManifest {
  schemaVersion: 1;
  product: "rainpool-metric-v1";
  environment: "LOCAL_MOCK" | "SEPOLIA_UMA";
  network: MetricNetwork;
  chainId: 31337 | 11155111;
  publicRpcUrl: string;
  deployedAt: string;
  admin: string;
  contracts: Record<typeof CORE_CONTRACT_NAMES[number], MetricContractDeployment>
    & Partial<Record<typeof LOCAL_CONTRACT_NAMES[number], MetricContractDeployment>>;
  bindingTransactionHash: string;
  oracle: {
    optimisticOracleV3: string;
    bondCurrency: string;
    bondSymbol: string;
    bondDecimals: number;
    policyBond: string;
    minimumBond: string;
    identifier: string;
    note: string;
    runtimeCodeKeccak256?: string;
    bondRuntimeCodeKeccak256?: string;
    dvmSupport?: false;
  };
}

export function deployedContractNames(dep: MetricDeploymentManifest): MetricContractName[] {
  return dep.environment === "LOCAL_MOCK"
    ? [...CORE_CONTRACT_NAMES, ...LOCAL_CONTRACT_NAMES]
    : [...CORE_CONTRACT_NAMES];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: invalid object`);
  return value as Record<string, unknown>;
}
function address(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: invalid address`);
  const result = getAddress(value);
  if (result === ZeroAddress) throw new Error(`${label}: zero address`);
  return result;
}
function hash(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || value === ZeroHash) {
    throw new Error(`${label}: invalid hash`);
  }
}
function uint256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) >= (1n << 256n)) {
    throw new Error(`${label}: invalid uint256`);
  }
}

/** Validates export input and browser input. It does not trust the declared JSON types. */
export function validateMetricManifest(input: unknown): MetricDeploymentManifest {
  const dep = object(input, "Metric manifest");
  const local = dep.environment === "LOCAL_MOCK";
  if (dep.schemaVersion !== 1 || dep.product !== "rainpool-metric-v1"
    || (!local && dep.environment !== "SEPOLIA_UMA")
    || dep.network !== (local ? "localhost" : "sepolia")
    || dep.chainId !== (local ? 31337 : 11155111)) {
    throw new Error("Invalid numeric deployment environment / network / chainId");
  }
  address(dep.admin, "admin");
  hash(dep.bindingTransactionHash, "bindingTransactionHash");
  if (typeof dep.deployedAt !== "string" || !Number.isFinite(Date.parse(dep.deployedAt))) {
    throw new Error("Invalid deployment timestamp");
  }
  if (typeof dep.publicRpcUrl !== "string") throw new Error("Missing public RPC URL");
  const url = new URL(dep.publicRpcUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Public RPC URL must use HTTP(S) without embedded credentials");
  }
  const contracts = object(dep.contracts, "contracts");
  const names: MetricContractName[] = local
    ? [...CORE_CONTRACT_NAMES, ...LOCAL_CONTRACT_NAMES] : [...CORE_CONTRACT_NAMES];
  if (Object.keys(contracts).some(name => !names.includes(name as MetricContractName))) {
    throw new Error("Unexpected contract in numeric deployment manifest");
  }
  const addresses = new Set<string>();
  for (const name of names) {
    const entry = object(contracts[name], name);
    const deployed = address(entry.address, `${name}.address`);
    if (addresses.has(deployed)) throw new Error("Duplicate deployed contract address");
    addresses.add(deployed);
    for (const field of ["transactionHash", "abiKeccak256", "runtimeCodeKeccak256"]) hash(entry[field], `${name}.${field}`);
    if (!Number.isSafeInteger(entry.blockNumber) || Number(entry.blockNumber) < 0) {
      throw new Error(`${name}: invalid deployment block`);
    }
    if (!Array.isArray(entry.constructorArguments) || entry.constructorArguments.some(
      arg => typeof arg !== "string" && (typeof arg !== "number" || !Number.isSafeInteger(arg)),
    )) throw new Error(`${name}: invalid constructor arguments`);
  }
  const oracle = object(dep.oracle, "oracle");
  const oo = address(oracle.optimisticOracleV3, "oracle");
  const token = address(oracle.bondCurrency, "bondCurrency");
  if (oo === token || CORE_CONTRACT_NAMES.some(name => {
    const core = address(object(contracts[name], name).address, name);
    return core === oo || core === token;
  })) throw new Error("Oracle and token must be distinct from the application contracts");
  if (typeof oracle.bondSymbol !== "string" || !oracle.bondSymbol.trim()
    || !Number.isInteger(oracle.bondDecimals) || Number(oracle.bondDecimals) < 0 || Number(oracle.bondDecimals) > 255) {
    throw new Error("Invalid bond token metadata");
  }
  uint256(oracle.policyBond, "policyBond");
  if (oracle.policyBond === "0") throw new Error("policyBond: must be nonzero");
  uint256(oracle.minimumBond, "minimumBond");
  hash(oracle.identifier, "identifier");
  if (typeof oracle.note !== "string") throw new Error("Missing oracle environment note");
  if (local) {
    if (oo !== address(object(contracts.MockOptimisticOracleV3, "Mock").address, "Mock")
      || token !== address(object(contracts.TestBondToken, "Token").address, "Token")) {
      throw new Error("Local oracle/token addresses do not match deployed contracts");
    }
  } else {
    if (oo !== CANONICAL_SEPOLIA_OOV3 || oracle.dvmSupport !== false) {
      throw new Error("Sepolia requires canonical UMA OOv3 and dvmSupport:false");
    }
    if (token !== SEPOLIA_BOND_CURRENCY) throw new Error("Sepolia requires the pinned 6TEST bond currency");
    hash(oracle.runtimeCodeKeccak256, "external oracle code hash");
    hash(oracle.bondRuntimeCodeKeccak256, "external token code hash");
  }
  return input as MetricDeploymentManifest;
}
