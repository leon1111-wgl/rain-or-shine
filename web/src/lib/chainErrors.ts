// The numeric client reports contract errors and wallet outcomes in English (web/src/metric/client.ts,
// errorMessage). This shows the known ones in the interface language and keeps any detail in parentheses;
// unknown text is shown as it is, never hidden.

import { type MessageKey, t } from "../i18n";

const KNOWN: Array<[string, MessageKey]> = [
  ["Only the metric administrator can perform this action", "chainError.onlyAdmin"],
  ["This metric code is already registered", "chainError.duplicateMetric"],
  ["Invalid metric definition. Check the range, step and rules commitment", "chainError.invalidMetric"],
  ["Invalid market configuration (assertion liveness)", "chainError.livenessTooShort"],
  ["Invalid market configuration (settlement buffer)", "chainError.settleBuffer"],
  ["Invalid market configuration", "chainError.invalidMarket"],
  ["Market rules must contain 1–4096 bytes", "chainError.badRules"],
  ["Only the market's designated proposer can submit a result", "chainError.notProposer"],
  ["Each market accepts only one assertion", "chainError.alreadyProposed"],
  ["The assertion submission window is closed", "chainError.windowClosed"],
  ["This reading cannot determine the outcome; the threshold may overlap the Trace range", "chainError.indeterminate"],
  ["The reading does not match the metric range, step or Trace rules", "chainError.invalidReading"],
  ["The evidence does not meet the numeric observation requirements", "chainError.badEvidence"],
  ["Betting has not opened", "chainError.notOpen"],
  ["Betting has closed", "chainError.closed"],
  ["An account can bet on only one side of a market", "chainError.sideLocked"],
  ["The minimum bet is 0.001 ETH", "chainError.tooSmall"],
  ["This market has settled or entered refunds", "chainError.final"],
  ["No funds are claimable, or they have already been claimed", "chainError.nothingToClaim"],
  ["Refunds are not available yet", "chainError.refundNotAvailable"],
  ["The bond exceeds the confirmed limit. Refresh and try again", "chainError.bondAboveMax"],
  ["Insufficient bond token balance", "chainError.bondBalance"],
  ["Insufficient bond allowance. Approve the correct contract first", "chainError.bondAllowance"],
  ["Wallet signature request cancelled.", "chainError.cancelled"],
  ["The RPC is rate-limiting requests. Wait a moment, then refresh. If this continues, use another RPC in the app and wallet.", "chainError.rateLimited"],
  // Contract errors the client has no English hint for arrive under their own names.
  ["ProposerCannotBet", "chainError.proposerCannotBet"],
  ["ThresholdOutOfRange", "chainError.thresholdRange"],
  ["ThresholdStepMismatch", "chainError.thresholdStep"],
  ["IndeterminateTraceCondition", "chainError.traceCondition"],
  ["NotPinnedBondCurrency", "chainError.bondCurrency"],
  ["ZeroPolicyBond", "chainError.zeroBond"],
  ["complete", "chainError.complete"],
  ["waiting for confirmation…", "chainError.waiting"],
];

export function localizeChainMessage(text: string): string {
  for (const [english, key] of KNOWN) {
    if (text.startsWith(english)) return t(key) + text.slice(english.length);
  }
  return text;
}
