import { type MessageKey, t } from "../i18n";
import { Dialog } from "./Dialog";

const RULES = ["question", "source", "decision", "missing", "asset", "sideLock", "exit", "payout", "refund", "timeout", "claim", "oracle", "fixed"] as const;

export function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={t("rules.title")} onClose={onClose} testId="rules-dialog">
      <ul className="rule-list">
        {RULES.map((r) => (
          <li key={r}>{t(`rules.${r}` as MessageKey)}</li>
        ))}
      </ul>
      <p className="fine-print">{t("rules.footnote")}</p>
    </Dialog>
  );
}
