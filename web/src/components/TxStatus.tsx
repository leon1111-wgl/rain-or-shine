import { detailOf, type TxState } from "../hooks/useTransaction";
import { t } from "../i18n";
import { useMetricApp } from "../metric/context";
import { TxLink } from "./primitives";

/** Live region for the action this panel started. Success appears only after a successful receipt. */
export function TxStatus({ state }: { state: TxState | null }) {
  const api = useMetricApp();
  if (!state) return null;
  const running = state.result === null;
  const tone = running ? "info" : state.result === "ok" ? "ok" : "bad";
  const text = running ? (api.txHash ? t("tx.pending") : t("tx.signing")) : state.result === "ok" ? t("tx.confirmed") : detailOf(api.message, state.label);
  return (
    <div className={`tx tx-${tone}`} role="status" aria-live="polite" data-testid="tx-status" data-result={state.result ?? "running"}>
      <strong>{state.label}{t("tx.labelSep").trim()}</strong> <span>{text}</span>
      {api.txHash && (
        <div className="small">
          {t("tx.hash")} <TxLink hash={api.txHash} full />
        </div>
      )}
    </div>
  );
}
