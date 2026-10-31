import { t } from "../i18n";
import { localizeChainMessage } from "../lib/chainErrors";
import { useMetricApp } from "../metric/context";
import { TxLink } from "./primitives";

/** The numeric client's last action and its transaction, for panels that act through it directly. */
export function ClientStatus() {
  const api = useMetricApp();
  if (!api.message) return null;
  return (
    <div className={`tx ${api.busy ? "tx-info" : "tx-plain"}`} role="status" aria-live="polite" data-testid="client-status">
      <span>{localizeLabelled(api.message)}</span>
      {api.txHash && (
        <div className="small">
          {t("tx.hash")} <TxLink hash={api.txHash} full />
        </div>
      )}
    </div>
  );
}

/** "Label: detail" with the detail in the interface language. The label is already the page's own text. */
function localizeLabelled(message: string): string {
  const at = message.indexOf(": ");
  if (at < 0) return localizeChainMessage(message);
  return `${message.slice(0, at)}${t("tx.labelSep")}${localizeChainMessage(message.slice(at + 2))}`;
}
