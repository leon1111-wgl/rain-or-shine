// The page clock and the app context. The numeric client (web/src/metric/context.tsx) owns the deployment, the
// verified chain reads and the transaction runner. This adds a clock that ticks every second from the last read
// block's time, so countdowns move between reads and follow a local chain that runs ahead of the wall clock.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useMetricApp } from "../metric/context";

const ClockContext = createContext<bigint | null>(null);

function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function ClockProvider({ children }: { children: ReactNode }) {
  const chain = useMetricApp().data?.now;
  const tick = useTicker(1000);
  const [anchor, setAnchor] = useState<{ chain: number; at: number } | null>(null);
  if (chain !== undefined && anchor?.chain !== chain) {
    // Adjusting state while rendering for a new read (React's documented pattern).
    setAnchor({ chain, at: tick });
  }
  const wall = Math.floor(tick / 1000);
  const now = anchor ? Math.max(wall, anchor.chain + Math.floor((tick - anchor.at) / 1000)) : wall;
  return <ClockContext.Provider value={BigInt(now)}>{children}</ClockContext.Provider>;
}

/** Estimated time of the next block: max(wall clock, last read block time + time since that read). */
export function useNow(): bigint {
  const now = useContext(ClockContext);
  if (now === null) throw new Error("useNow must be used inside <ClockProvider>");
  return now;
}

/** The numeric client's API plus the page clock. */
export function useApp() {
  const api = useMetricApp();
  const now = useNow();
  return { ...api, now };
}
