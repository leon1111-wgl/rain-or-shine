import { toUtf8String, type Provider } from "ethers";
import { adapterOf, marketOf, type MetricDeployment } from "../metric/client";
import { LOG_BLOCK_SPAN } from "../metric/rpc-reader";
import type { MarketData } from "./markets";

export interface EvidenceRecord {
  txHash: string;
  bond: bigint;
  proposer: string;
  sourceUrl: string;
  rawSha256: string;
  capturedAt: bigint;
  excerpt: string;
}

export interface ClaimRecord {
  market: number;
  amount: bigint;
  refund: boolean;
  txHash: string;
}

function excerptText(bytes: string): string {
  try {
    return toUtf8String(bytes);
  } catch (err) {
    if (err instanceof Error) return bytes;
    throw err;
  }
}

export async function loadEvidence(dep: MetricDeployment, reader: Provider, m: MarketData): Promise<EvidenceRecord | null> {
  const a = m.assertion;
  if (!a) return null;
  const adapter = adapterOf(dep, reader);
  const first = dep.contracts.UmaMetricOracleAdapter.blockNumber;
  const latest = await reader.getBlockNumber();
  for (let to = latest; to >= first; to -= LOG_BLOCK_SPAN) {
    const from = Math.max(first, to - LOG_BLOCK_SPAN + 1);
    const [proposed, published] = await Promise.all([
      adapter.queryFilter(adapter.filters.AssertionProposed(m.id, a.id), from, to),
      adapter.queryFilter(adapter.filters.EvidencePublished(m.id, a.id), from, to),
    ]);
    const p = proposed[0];
    const e = published[0];
    if (p && e) {
      if (e.args.rawSha256.toLowerCase() !== a.rawSha256.toLowerCase()) throw new Error("The published evidence does not match the market's assertion.");
      return { txHash: p.transactionHash, bond: p.args.bond, proposer: p.args.proposer, sourceUrl: e.args.sourceUrl, rawSha256: e.args.rawSha256, capturedAt: e.args.capturedAt, excerpt: excerptText(e.args.excerpt) };
    }
  }
  return null;
}

export async function loadClaims(dep: MetricDeployment, reader: Provider, account: string): Promise<Map<number, ClaimRecord>> {
  const market = marketOf(dep, reader);
  const first = dep.contracts.PredictionMarket.blockNumber;
  const latest = await reader.getBlockNumber();
  const claims = new Map<number, ClaimRecord>();
  for (let from = first; from <= latest; from += LOG_BLOCK_SPAN) {
    const logs = await market.queryFilter(market.filters.Claimed(undefined, account), from, Math.min(latest, from + LOG_BLOCK_SPAN - 1));
    for (const log of logs) {
      const id = Number(log.args.marketId);
      claims.set(id, { market: id, amount: log.args.amount, refund: log.args.claimType === 1n, txHash: log.transactionHash });
    }
  }
  return claims;
}
