/** Encodes decimal text exactly as an int32 ×100. The metric step plays no part. */
export function parseFixed100(input: string): number {
  const token = input.trim();
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(token);
  if (!match) throw new Error("use a decimal with at most two fractional digits, without exponent notation");
  const magnitude = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  const value = match[1] === "-" ? -magnitude : magnitude;
  if (value < -2147483648n || value > 2147483647n) throw new Error("scaled value is outside int32");
  return Number(value);
}

export function formatFixed100(input: number | bigint): string {
  if (typeof input === "number" && !Number.isSafeInteger(input)) throw new Error("scaled value must be an integer");
  const value = BigInt(input);
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % 100n).toString().padStart(2, "0").replace(/0$/, "");
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${fraction}`;
}
