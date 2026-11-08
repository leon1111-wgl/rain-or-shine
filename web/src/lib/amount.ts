// ETH amounts as integer wei (bigint). Inputs are parsed from strict decimal strings, never from JS numbers.
// Float rounding such as 0.1 + 0.2 never reaches a transaction.

import { t } from "../i18n";

export const WEI_PER_ETH = 10n ** 18n;
export const MIN_BET_WEI = 10n ** 15n; // 0.001 ETH, PredictionMarket.MIN_BET

export type ParseResult = { ok: true; value: bigint } | { ok: false; error: string };

const ETH_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function parseEthInput(input: string): ParseResult {
  const text = input.trim();
  if (text === "") return { ok: false, error: t("amount.empty") };
  const m = ETH_RE.exec(text);
  if (!m) return { ok: false, error: t("amount.format") };
  const fraction = m[2] ?? "";
  if (fraction.length > 18) return { ok: false, error: t("amount.decimals") };
  return { ok: true, value: BigInt(m[1]!) * WEI_PER_ETH + BigInt(fraction.padEnd(18, "0")) };
}

export function parseBetAmount(input: string): ParseResult {
  const parsed = parseEthInput(input);
  if (!parsed.ok) return parsed;
  if (parsed.value < MIN_BET_WEI) return { ok: false, error: t("amount.belowMin") };
  return parsed;
}

export function formatEth(wei: bigint, maxFraction = 6, minFraction = 3): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  let fraction = (abs % WEI_PER_ETH).toString().padStart(18, "0").slice(0, maxFraction);
  while (fraction.length > minFraction && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "−" : ""}${abs / WEI_PER_ETH}${fraction ? `.${fraction}` : ""}`;
}

export const formatEthFixed = (wei: bigint, decimals = 3) => formatEth(wei, decimals, decimals);

export function formatEthSigned(wei: bigint): string {
  return wei > 0n ? `+${formatEth(wei)}` : formatEth(wei);
}

export function stakeShare(part: bigint, total: bigint): number {
  if (total === 0n) return 50;
  return Number((part * 10_000n) / total) / 100;
}
