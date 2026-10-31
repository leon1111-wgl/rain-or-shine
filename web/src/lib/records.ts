// Records the dashboard does not hold: the evidence a proposer published with a market's assertion, and the
// connected account's claims. Logs are read in bounded block ranges from the contracts' deployment blocks, and every
// record is checked against the market it belongs to before it is shown.

import { toUtf8String, type Provider } from "ethers";
import { adapterOf, marketOf, type MetricDeployment } from "../metric/client";
import type { MarketData } from "./markets";

const SPAN = 5000;

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
    // Not UTF-8: the bytes are shown as hex, exactly as published.
    if (err instanceof Error) return bytes;
    throw err;
  }
}

/** The AssertionProposed and EvidencePublished logs of the market's assertion, newest blocks first. */
export async function loadEvidence(dep: MetricDeployment, reader: Provider, m: MarketData): Promise<EvidenceRecord | null> {
  const a = m.assertion;
  if (!a) return null;
  const adapter = adapterOf(dep, reader);
  const first = dep.contracts.UmaMetricOracleAdapter.blockNumber;
  const latest = await reader.getBlockNumber();
  for (let to = latest; to >= first; to -= SPAN) {
    const from = Math.max(first, to - SPAN + 1);
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

/** The account's Claimed logs, by market. */
export async function loadClaims(dep: MetricDeployment, reader: Provider, account: string): Promise<Map<number, ClaimRecord>> {
  const market = marketOf(dep, reader);
  const first = dep.contracts.PredictionMarket.blockNumber;
  const latest = await reader.getBlockNumber();
  const claims = new Map<number, ClaimRecord>();
  for (let from = first; from <= latest; from += SPAN) {
    const logs = await market.queryFilter(market.filters.Claimed(undefined, account), from, Math.min(latest, from + SPAN - 1));
    for (const log of logs) {
      const id = Number(log.args.marketId);
      claims.set(id, { market: id, amount: log.args.amount, refund: log.args.claimType === 1n, txHash: log.transactionHash });
    }
  }
  return claims;
}
