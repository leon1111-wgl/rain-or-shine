import { readFile } from "node:fs/promises";
import { validateMetricManifest, type MetricNetwork } from "../../src/metric/deployment.js";
export type { MetricContractDeployment, MetricDeploymentManifest } from "../../src/metric/deployment.js";

export const METRIC_MANIFEST_FILE = "deployments/metric.localhost.json";
export const metricManifestFile = (network: MetricNetwork) => `deployments/metric.${network}.json`;
export const METRIC_ARTIFACTS = {
  PredictionMarket: "artifacts/contracts/PredictionMarket.sol/PredictionMarket.json",
  UmaMetricOracleAdapter: "artifacts/contracts/UmaMetricOracleAdapter.sol/UmaMetricOracleAdapter.json",
  TestBondToken: "artifacts/contracts/test/TestBondToken.sol/TestBondToken.json",
  MockOptimisticOracleV3: "artifacts/contracts/test/MockOptimisticOracleV3.sol/MockOptimisticOracleV3.json",
} as const;

export async function readMetricManifest(network: MetricNetwork = "localhost") {
  const manifest = validateMetricManifest(JSON.parse(await readFile(metricManifestFile(network), "utf8")));
  if (manifest.network !== network) throw new Error("Numeric manifest is stored under the wrong network");
  return manifest;
}
