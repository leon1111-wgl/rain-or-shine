// A panel's view of a transaction sent through the numeric client's runner (web/src/metric/context.tsx), which
// verifies the deployment before and after signing, checks the receipt and refreshes the chain reads. The client
// runs one action at a time. This remembers which action this panel started and how it ended.

import type { ContractTransactionResponse, JsonRpcSigner } from "ethers";
import { useCallback, useState } from "react";
import { t } from "../i18n";
import { useMetricApp } from "../metric/context";
import { localizeChainMessage } from "../lib/chainErrors";
import { useToasts } from "./useToasts";

export type TxResult = "ok" | "failed";

export interface TxState {
  label: string;
  result: TxResult | null;
}

export function useTransaction() {
  const api = useMetricApp();
  const toasts = useToasts();
  const [state, setState] = useState<TxState | null>(null);

  const finish = useCallback(
    (label: string, ok: boolean) => {
      setState({ label, result: ok ? "ok" : "failed" });
      toasts.show(ok ? t("toast.confirmed", { label }) : t("toast.failedShort", { label }), ok ? "ok" : "bad");
    },
    [toasts],
  );

  const run = useCallback(
    async (label: string, send: (signer: JsonRpcSigner) => Promise<ContractTransactionResponse>): Promise<boolean> => {
      setState({ label, result: null });
      const ok = await api.run(label, send);
      finish(label, ok);
      return ok;
    },
    [api, finish],
  );

  /** A checked step that sends no transaction (a review or a local-chain control). */
  const action = useCallback(
    async (label: string, task: () => Promise<void>): Promise<boolean> => {
      setState({ label, result: null });
      const ok = await api.action(label, task);
      setState({ label, result: ok ? "ok" : "failed" });
      return ok;
    },
    [api],
  );

  return { state, run, action, busy: api.busy };
}

/** The client's last message for `label`, without the label, in the interface language. */
export function detailOf(message: string, label: string): string {
  const rest = message.startsWith(label) ? message.slice(label.length).replace(/^[:…\s]+/, "") : message;
  return localizeChainMessage(rest);
}
