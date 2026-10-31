import { describe, expect, it } from "vitest";
import { formatFixed100, parseFixed100 } from "../../src/metric/fixed100.js";

describe("metric fixed-point inputs", () => {
  it.each([
    ["-0.01", -1], ["0.02", 2], ["32.0", 3200], [" -2.5 ", -250], ["-0.00", 0],
    ["21474836.47", 2147483647], ["-21474836.48", -2147483648],
  ] as const)("scales %s exactly", (text, value) => {
    expect(parseFixed100(text)).toBe(value);
    expect(parseFixed100(formatFixed100(value))).toBe(value);
  });

  it.each([
    "", "1e2", "0x20", "32.001", "21474836.48", "-21474836.49", "01.0", "1,2", "Infinity",
  ])("rejects ambiguous/out-of-range %s", (text) => {
    expect(() => parseFixed100(text)).toThrow();
  });

  it("formats signed cents and uint32 steps without floating point rounding", () => {
    expect(formatFixed100(-1n)).toBe("-0.01");
    expect(formatFixed100(-10)).toBe("-0.1");
    expect(formatFixed100(3200)).toBe("32.0");
    expect(formatFixed100(4294967295)).toBe("42949672.95");
    expect(() => formatFixed100(0.1)).toThrow();
    expect(() => formatFixed100(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
