import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { keccak256, toUtf8Bytes } from "ethers";
import { deployedContractNames, type MetricDeploymentManifest, type MetricNetwork } from "../src/metric/deployment.js";
import { METRIC_ARTIFACTS, metricManifestFile, readMetricManifest } from "./lib/metric-deployment.js";

const requested = process.env.EXPORT_NETWORKS?.split(",").map(value => value.trim());
const networks = requested ?? ["localhost", "sepolia"];
if (!networks.length || networks.some(name => !["localhost", "sepolia"].includes(name))) {
  throw new Error("EXPORT_NETWORKS supports localhost,sepolia only");
}
const deployments: Record<string, MetricDeploymentManifest> = {};
for (const name of networks) {
  const network = name as MetricNetwork;
  if (!existsSync(metricManifestFile(network))) {
    if (requested) throw new Error(`Missing ${metricManifestFile(network)}; deploy this network first`);
    continue;
  }
  const manifest = await readMetricManifest(network);
  deployments[String(manifest.chainId)] = manifest;
}
const abi: Record<string, unknown[]> = {};
const artifactFiles: Record<string, string> = {
  ...METRIC_ARTIFACTS,
  IOptimisticOracleV3: "artifacts/contracts/interfaces/IOptimisticOracleV3.sol/IOptimisticOracleV3.json",
};
for (const [name, file] of Object.entries(artifactFiles)) {
  const artifact = JSON.parse(await readFile(file, "utf8")) as { abi: unknown[] };
  if (!Array.isArray(artifact.abi)) throw new Error(file + ": ABI missing");
  abi[name] = artifact.abi;
}
for (const manifest of Object.values(deployments)) {
  for (const name of deployedContractNames(manifest)) {
    const deployed = manifest.contracts[name]!;
    if (keccak256(toUtf8Bytes(JSON.stringify(abi[name]))) !== deployed.abiKeccak256) {
      throw new Error(`${manifest.network} ${name}: ABI changed since deployment; use a compatible deployment`);
    }
  }
}

await mkdir("web/src/generated", { recursive: true });
await writeFile("web/src/generated/metric-abi.json", JSON.stringify(abi, null, 2) + "\n");
await writeFile(
  "web/src/generated/metric-deployments.json",
  JSON.stringify({ deployments }, null, 2) + "\n",
);
console.log(`Exported numeric ABIs and deployments for [${Object.keys(deployments).join(", ")}].`);
if (!Object.keys(deployments).length) console.log("No numeric deployments yet. The app will prompt you to deploy.");
