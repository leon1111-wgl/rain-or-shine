// The payout of a winning position. It matches PredictionMarket._entitlement.
// Payout = stake × all stakes ÷ winning stakes, rounded down with OpenZeppelin Math.mulDiv. There is no fee.
// A refund returns the stake. This file does not compute refunds.

export type PayoutSide = "YES" | "NO";

export interface PayoutInput {
  yesTotal: bigint;
  noTotal: bigint;
  side: PayoutSide;
  stake: bigint;
  add: bigint;
}

/** The position's payout in wei for a win, with `add` included. A side without stake pays 0n. */
export function payoutIfWins({ yesTotal, noTotal, side, stake, add }: PayoutInput): bigint {
  if (yesTotal < 0n || noTotal < 0n || stake < 0n || add < 0n) throw new RangeError("payout inputs must not be negative");
  const sideBefore = side === "YES" ? yesTotal : noTotal;
  if (stake > sideBefore) throw new RangeError("the stake is larger than its side's total");
  const sideTotal = sideBefore + add;
  if (sideTotal === 0n) return 0n;
  return ((stake + add) * (yesTotal + noTotal + add)) / sideTotal;
}
