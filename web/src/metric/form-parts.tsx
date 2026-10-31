// Pieces the market forms share: the labelled field with its own error, the guard that drops a request when its inputs
// or the wallet change, the pending block's timestamp, where a browser keeps metric rules, and the threshold message.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { formatFixed100, parseFixed100 } from "@shared/metric/fixed100";
import { conditionProblems, type ConditionProblem } from "@shared/metric/numeric-rules";
import { type MessageKey, t } from "../i18n";
import { unitOf } from "../lib/markets";
import type { useMetricApp } from "./context";

/** A labelled input. Its error shows right under it, outside the label, so the label stays the input's name. */
export function Field({ title, children, error, testId }: { title: string; children: ReactNode; error?: string | null; testId?: string }) {
  return <div className="field">
    <label className="field-label"><span>{title}</span>{children}</label>
    {error && <span className="input-note error" role="alert" data-testid={testId}>{error}</span>}
  </div>;
}

/** Where this browser keeps a custom metric's rules document after registering it. */
export const metricDocKey = (address: string, hash: string) => "rainpool:metric-rules:" + address.toLowerCase() + ":" + hash.toLowerCase();
export const identityOf = (api: ReturnType<typeof useMetricApp>) => [
  api.dep.chainId, api.dep.contracts.PredictionMarket.address, api.dep.bindingTransactionHash,
  api.dep.publicRpcUrl, api.wallet.account, api.wallet.chainId, api.wallet.epoch,
];

/** Invalidate pending requests when the wallet or inputs change, or the component unmounts. */
export function useContextGuard(key: string) {
  const latest = useRef(key);
  useLayoutEffect(() => {
    latest.current = key;
    return () => { latest.current = ""; };
  }, [key]);
  return () => {
    if (latest.current !== key) throw new Error(t("form.changed"));
  };
}

/** The pending block's timestamp from a raw eth_getBlockByNumber("pending") answer. */
export function pendingTimestamp(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(t("form.pendingBlock"));
  }
  const timestamp = (value as Record<string, unknown>).timestamp;
  if (typeof timestamp !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(timestamp)) {
    throw new Error(t("form.pendingHex"));
  }
  const seconds = BigInt(timestamp);
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(t("form.pendingRange"));
  return Number(seconds);
}

type ThresholdMetric = { unit: string; minValue: number; maxValue: number; valueStep: number; allowsTrace: boolean };
const CONDITION_KEYS: Record<ConditionProblem, MessageKey> = {
  RANGE_ORDER: "create.rangeOrder", OUTSIDE_RANGE: "create.thresholdRange", OFF_STEP: "create.thresholdStep", TRACE_UNDECIDABLE: "create.thresholdTrace",
};

/** createMarket's threshold checks (ConditionLib.validateForMetric, mirrored in the shared rules), as a message before anything is sent. */
export function thresholdProblem(metric: ThresholdMetric | undefined, comparison: string, lower: string, upper: string): string | null {
  if (!metric) return null;
  const range = comparison === "5";
  let low: number, high: number;
  try {
    low = parseFixed100(lower);
    high = range ? parseFixed100(upper) : 0;
  } catch {
    return t("create.thresholdInvalid"); // parseFixed100 accepts only a plain decimal with at most two places
  }
  const [problem] = conditionProblems({ comparison: Number(comparison), lower: low, upper: high }, metric);
  const facts = { min: formatFixed100(metric.minValue), max: formatFixed100(metric.maxValue), step: formatFixed100(metric.valueStep), unit: unitOf(metric.unit) };
  return problem ? t(CONDITION_KEYS[problem], facts) : null;
}
