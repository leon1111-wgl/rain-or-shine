// Read-only: saves the exact rules document and the chain state of Sepolia markets as a regression fixture.
// It reads the MarketCreated logs of the deployment in deployments/metric.sepolia.json, then each market's
// config, metric and rules hash at one pinned block. No key is read and nothing is sent.
//
//   MARKETS=1,2,3,4 npx tsx scripts/capture-sepolia-market-rules.ts
//   (SEPOLIA_RPC_URL overrides the public RPC. It is never printed.)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, keccak256, toUtf8String, type InterfaceAbi } from "ethers";
import { METRIC_ARTIFACTS, readMetricManifest } from "./lib/metric-deployment.js";
import { SEPOLIA_PUBLIC_RPC } from "./lib/uma-sepolia.js";

const OUT = "fixtures/sepolia/market-rules.json";
const manifest = await readMetricManifest("sepolia");
const ids = (process.env.MARKETS ?? "1,2,3,4").split(",").map((text) => Number(text.trim()));
if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("MARKETS lists market IDs, e.g. 1,2,3,4");
const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL?.trim() || SEPOLIA_PUBLIC_RPC, 11155111, { staticNetwork: true });
const abi = (JSON.parse(await readFile(METRIC_ARTIFACTS.PredictionMarket, "utf8")) as { abi: InterfaceAbi }).abi;
const market = new Contract(manifest.contracts.PredictionMarket.address, abi, provider);
const block = await provider.getBlockNumber();
const at = { blockTag: block };
const logs = await market.queryFilter(market.filters.MarketCreated!(), manifest.contracts.PredictionMarket.blockNumber, block);
const markets = [];
for (const id of ids) {
  const log = logs.find((entry) => "args" in entry && Number(entry.args.marketId) === id);
  if (!log || !("args" in log)) throw new Error(`No MarketCreated log for market #${id}`);
  const bytes = log.args.rulesDocument as string;
  if (keccak256(bytes) !== log.args.rulesHash) throw new Error(`Market #${id}: the logged document does not match its hash`);
  const config = await market.getFunction("getMarketConfig")(id, at);
  const metricId = Number(config.condition.metricId);
  const [metric, marketRulesHash] = await Promise.all([
    market.getFunction("getMetric")(metricId, at), market.getFunction("marketRulesHash")(id, at),
  ]);
  if (marketRulesHash !== log.args.rulesHash) throw new Error(`Market #${id}: the on-chain hash differs from the log`);
  markets.push({
    marketId: id,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    rulesHash: marketRulesHash as string,
    rulesDocument: toUtf8String(bytes),
    config: {
      proposer: config.proposer as string, sourceId: config.sourceId as string, subjectId: config.subjectId as string,
      condition: {
        metricId, comparison: Number(config.condition.comparison),
        lower: Number(config.condition.lower), upper: Number(config.condition.upper),
      },
      times: Object.fromEntries(([
        "openAt", "closeAt", "observationStart", "observationEnd",
        "earliestAssertionAt", "proposalCutoff", "refundAt", "assertionLiveness",
      ] as const).map((key) => [key, Number(config.times[key])])),
    },
    metricId,
    metric: {
      code: metric.code as string, unit: metric.unit as string, minValue: Number(metric.minValue),
      maxValue: Number(metric.maxValue), valueStep: Number(metric.valueStep), allowsTrace: metric.allowsTrace as boolean,
      rulesHash: metric.rulesHash as string,
    },
  });
}
await mkdir("fixtures/sepolia", { recursive: true });
await writeFile(OUT, JSON.stringify({
  network: "sepolia", chainId: 11155111, predictionMarket: manifest.contracts.PredictionMarket.address,
  readAtBlock: block, markets,
}, null, 2) + "\n");
console.log(`Saved ${markets.length} market rules documents read at block ${block} to ${OUT}`);
