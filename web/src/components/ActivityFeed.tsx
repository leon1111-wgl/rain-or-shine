import type { AsyncState } from "../hooks/useAsync";
import { useWallet } from "../hooks/useWallet";
import { type MessageKey, t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEth } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { formatHktShort } from "../lib/time";
import { LoadError, Skeleton, TxLink } from "./primitives";

const ROWS = 20;
const LABEL: Record<ActivityItem["kind"], MessageKey> = {
  BET: "activity.bet",
  TOP_UP: "activity.topUp",
};

export function ActivityFeed({ feed }: { feed: AsyncState<ActivityItem[]> }) {
  const wallet = useWallet();
  const me = wallet.account?.toLowerCase();
  const items = (feed.data ?? []).slice(-ROWS).reverse();
  return (
    <div data-testid="activity">
      {feed.error && <LoadError error={feed.error} retry={feed.reload} />}
      {feed.loading && !feed.data && <Skeleton rows={4} />}
      {feed.data && items.length === 0 && (
        <p className="small muted" data-testid="activity-empty">
          {t("activity.empty")}
        </p>
      )}
      {items.length > 0 && (
        <ol className="activity-list" aria-live="polite">
          {items.map((item) => {
            const mine = item.account.toLowerCase() === me;
            return (
              <li key={`${item.txHash}:${item.logIndex}`} className={mine ? "mine" : ""} data-testid="activity-item">
                <span className="activity-time">{formatHktShort(BigInt(item.timestamp))}</span>
                <span className="activity-who mono" title={item.account}>
                  {shortHex(item.account)}
                  {mine && <span className="tag">{t("activity.you")}</span>}
                </span>
                <span className={`activity-what ${item.side === "YES" ? "yes-text" : "no-text"}`}>{t(LABEL[item.kind], { side: item.side === "YES" ? "Yes" : "No" })}</span>
                <strong className="activity-amount">{formatEth(item.amount)} ETH</strong>
                <TxLink hash={item.txHash} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
