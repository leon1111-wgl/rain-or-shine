import { describe, expect, it } from "vitest";
import { payoutIfWins } from "../../src/metric/payout.js";

const milli = (n: bigint) => n * 10n ** 15n;

describe("payout if a side wins", () => {
  it("rounds down like Math.mulDiv", () => {
    // 1 of 3 on Yes, 4 on No: 1 × 7 / 3 = 2.33…
    expect(payoutIfWins({ yesTotal: 3n, noTotal: 4n, side: "YES", stake: 1n, add: 0n })).toBe(2n);
    expect(payoutIfWins({ yesTotal: milli(3n), noTotal: milli(4n), side: "YES", stake: milli(1n), add: 0n })).toBe(2_333_333_333_333_333n);
  });

  it("adds a top-up to the position and to the totals", () => {
    // 2 of 5 on Yes, 5 on No, adding 1: 3 × 11 / 6 = 5.5
    expect(payoutIfWins({ yesTotal: 5n, noTotal: 5n, side: "YES", stake: 2n, add: 1n })).toBe(5n);
    // A first bet of 4 on No: 4 × 14 / 9 = 6.2…
    expect(payoutIfWins({ yesTotal: 5n, noTotal: 5n, side: "NO", stake: 0n, add: 4n })).toBe(6n);
  });

  it("returns only the stake while the other side is empty, and nothing while its own side is", () => {
    expect(payoutIfWins({ yesTotal: milli(5n), noTotal: 0n, side: "YES", stake: milli(2n), add: milli(1n) })).toBe(milli(3n));
    expect(payoutIfWins({ yesTotal: 0n, noTotal: milli(10n), side: "YES", stake: 0n, add: 0n })).toBe(0n);
  });

  it("keeps every wei for large totals", () => {
    const yesTotal = 123_456_789_012_345_678_901_234_567n;
    const noTotal = 987_654_321_098_765_432_109_876_543n;
    const stake = 111_111_111_111_111_111_111n;
    expect(payoutIfWins({ yesTotal, noTotal, side: "YES", stake, add: 0n })).toBe((stake * (yesTotal + noTotal)) / yesTotal);
    const big = 2n ** 200n;
    expect(payoutIfWins({ yesTotal: big, noTotal: big, side: "NO", stake: big / 2n, add: 0n })).toBe(big);
  });

  it("refuses negative inputs and a stake larger than its side", () => {
    expect(() => payoutIfWins({ yesTotal: -1n, noTotal: 0n, side: "YES", stake: 0n, add: 0n })).toThrow(RangeError);
    expect(() => payoutIfWins({ yesTotal: 1n, noTotal: 0n, side: "YES", stake: 2n, add: 0n })).toThrow(RangeError);
  });
});
