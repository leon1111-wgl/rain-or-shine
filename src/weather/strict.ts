export type WeatherErrorCode = "DATA_UNAVAILABLE" | "DATA_INVALID" | "EVIDENCE_MISMATCH";

export class WeatherDataError extends Error {
  readonly code: WeatherErrorCode;

  constructor(code: WeatherErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WeatherDataError";
    this.code = code;
  }
}

export type ReadingKind = "NUMERIC" | "TRACE";

export interface RainfallValue {
  kind: ReadingKind;
  mm100: number;
  text: string;
}

export const MAX_RAIN_MM100 = 999_990;

const RAIN_RE = /^(0|[1-9]\d{0,3})\.(\d)$/;
const UNAVAILABLE_TOKENS = new Set(["", "-", "--", "—", "–", "N/A", "NA", "n/a"]);

export function parseRainfallToken(token: unknown, field: string): RainfallValue {
  if (token === undefined) throw new WeatherDataError("DATA_UNAVAILABLE", `${field} is missing`);
  if (token === null) throw new WeatherDataError("DATA_UNAVAILABLE", `${field} is null`);
  if (typeof token !== "string") {
    throw new WeatherDataError("DATA_INVALID", `${field} must be a string as published, got ${typeof token}`);
  }
  const text = token.replaceAll(" ", "");
  if (UNAVAILABLE_TOKENS.has(text)) throw new WeatherDataError("DATA_UNAVAILABLE", `${field}="${token}" is blank or a dash (no value published)`);
  if (text.includes("*")) throw new WeatherDataError("DATA_UNAVAILABLE", `${field}="${token}" is marked unavailable (***) by HKO`);
  if (text.includes("#")) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is flagged "# data incomplete" by HKO and cannot settle a pool`);
  if (text === "Trace") return { kind: "TRACE", mm100: 0, text };
  const m = RAIN_RE.exec(text);
  if (!m) {
    if (/^\d+\.\d{2,}$/.test(text)) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" has unsupported precision (one decimal place expected)`);
    if (/^-/.test(text)) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is negative`);
    throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is neither "<mm>.<d>" nor "Trace"`);
  }
  const mm100 = Number(m[1]) * 100 + Number(m[2]) * 10;
  if (mm100 > MAX_RAIN_MM100) throw new WeatherDataError("DATA_INVALID", `${field}=${text} mm is outside the accepted range`);
  return { kind: "NUMERIC", mm100, text };
}

export function formatMm100(mm100: number | bigint): string {
  const v = BigInt(mm100);
  if (v < 0n) throw new RangeError("rainfall cannot be negative");
  const whole = v / 100n;
  const cents = v % 100n;
  return cents % 10n === 0n ? `${whole}.${cents / 10n}` : `${whole}.${cents.toString().padStart(2, "0")}`;
}

export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WeatherDataError("DATA_INVALID", "response is not valid UTF-8");
  }
  return text.startsWith("﻿") ? text.slice(1) : text;
}

export function parseJsonStrict(text: string): unknown {
  const keyStack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      keyStack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      keyStack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      keyStack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = keyStack.at(-1) instanceof Set;
    } else if (ch === ":") {
      expectKey = false;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const keys = keyStack.at(-1);
      if (expectKey && keys instanceof Set) {
        let key: string;
        try {
          key = JSON.parse(text.slice(i, j + 1)) as string;
        } catch {
          throw new WeatherDataError("DATA_INVALID", "malformed JSON object key");
        }
        if (keys.has(key)) throw new WeatherDataError("DATA_INVALID", `duplicate JSON key "${key}"`);
        keys.add(key);
      }
      i = j;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new WeatherDataError("DATA_INVALID", `malformed JSON: ${(err as Error).message}`);
  }
}

export const MIN_TEMPERATURE_C100 = -10_000;
export const MAX_TEMPERATURE_C100 = 10_000;

export interface TemperatureValue {
  kind: "NUMERIC";
  celsius100: number;
  text: string;
}

/** The trimmed text of a published Daily Extract value. Blank, dash and *** mean no value. # means incomplete. */
function publishedText(token: unknown, field: string): string {
  if (token === undefined || token === null) throw new WeatherDataError("DATA_UNAVAILABLE", `${field} is missing or null`);
  if (typeof token !== "string") throw new WeatherDataError("DATA_INVALID", `${field} must be a published string`);
  const text = token.trim();
  if (UNAVAILABLE_TOKENS.has(text) || text.includes("*")) {
    throw new WeatherDataError("DATA_UNAVAILABLE", `${field}="${token}" has no published value`);
  }
  if (text.includes("#")) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is flagged incomplete by HKO`);
  return text;
}

export function parseTemperatureToken(token: unknown, field: string): TemperatureValue {
  const text = publishedText(token, field);
  const match = /^(-?)(0|[1-9]\d{0,2})\.(\d)$/.exec(text);
  if (!match) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" must be a signed or unsigned temperature with one decimal place`);
  const magnitude = Number(match[2]) * 100 + Number(match[3]) * 10;
  const celsius100 = match[1] === "-" && magnitude !== 0 ? -magnitude : magnitude;
  if (celsius100 < MIN_TEMPERATURE_C100 || celsius100 > MAX_TEMPERATURE_C100) {
    throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is outside the accepted -100.0 to 100.0 degC range`);
  }
  return { kind: "NUMERIC", celsius100, text };
}

export interface PercentValue {
  kind: "NUMERIC";
  percent100: number;
  text: string;
}

/** HKO publishes relative humidity and cloud as a whole percent ("87"). The value is that percent multiplied by 100. */
export function parseWholePercentToken(token: unknown, field: string): PercentValue {
  const text = publishedText(token, field);
  if (!/^(0|[1-9]\d{0,2})$/.test(text) || Number(text) > 100) {
    throw new WeatherDataError("DATA_INVALID", `${field}="${token}" must be a whole percent from 0 to 100`);
  }
  return { kind: "NUMERIC", percent100: Number(text) * 100, text };
}

export function parseOneDecimalToken(token: unknown, field: string, min100: number, max100: number): { value100: number; text: string } {
  const text = publishedText(token, field);
  const match = /^(-?)(0|[1-9]\d{0,4})\.(\d)$/.exec(text);
  if (!match) throw new WeatherDataError("DATA_INVALID", `${field}="${token}" must be a number with one decimal place`);
  const magnitude = Number(match[2]) * 100 + Number(match[3]) * 10;
  const value100 = match[1] === "-" && magnitude !== 0 ? -magnitude : magnitude;
  if (value100 < min100 || value100 > max100) {
    throw new WeatherDataError("DATA_INVALID", `${field}="${token}" is outside the accepted ${min100 / 100} to ${max100 / 100} range`);
  }
  return { value100, text };
}
