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
    // Update state during render for a new read. React documents this pattern.
    setAnchor({ chain, at: tick });
  }
  const wall = Math.floor(tick / 1000);
  const now = anchor ? Math.max(wall, anchor.chain + Math.floor((tick - anchor.at) / 1000)) : wall;
  return <ClockContext.Provider value={BigInt(now)}>{children}</ClockContext.Provider>;
}

export function useNow(): bigint {
  const now = useContext(ClockContext);
  if (now === null) throw new Error("useNow must be used inside <ClockProvider>");
  return now;
}

export function useApp() {
  const api = useMetricApp();
  const now = useNow();
  return { ...api, now };
}
