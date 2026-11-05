// What a winning position is paid, exactly as PredictionMarket._entitlement computes it: the position's stake times
// all stakes, divided by the winning side's stakes, rounded down (OpenZeppelin Math.mulDiv), with no fee. A refund
// returns the stake and is not computed here.

export type PayoutSide = "YES" | "NO";

export interface PayoutInput {
  yesTotal: bigint;
  noTotal: bigint;
  side: PayoutSide;
  stake: bigint;
  add: bigint;
}

/** Wei paid to the position if its side wins once `add` has joined it; 0n while that side has no stake at all. */
export function payoutIfWins({ yesTotal, noTotal, side, stake, add }: PayoutInput): bigint {
  if (yesTotal < 0n || noTotal < 0n || stake < 0n || add < 0n) throw new RangeError("payout inputs must not be negative");
  const sideBefore = side === "YES" ? yesTotal : noTotal;
  if (stake > sideBefore) throw new RangeError("the stake is larger than its side's total");
  const sideTotal = sideBefore + add;
  if (sideTotal === 0n) return 0n;
  return ((stake + add) * (yesTotal + noTotal + add)) / sideTotal;
}
