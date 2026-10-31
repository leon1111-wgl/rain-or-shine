// Chain reads with explicit loading/error states.
// - `key` encodes every input of the request. A new key re-reads, and responses of superseded runs
//   (previous account, chain, market, input or poll tick) are discarded.
// - `identity` names what the data belongs to. When it changes the old data is cleared immediately, so
//   one account's or market's numbers are never shown as another's. Refreshes keep data on screen.
// - An RPC error never turns into empty or zero data: it is reported next to the last good read.

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export interface AsyncOptions {
  pollMs?: number;
  enabled?: boolean;
  identity?: string;
}

interface Slot<T> {
  identity: string;
  data: T | undefined;
  error: string | null;
  settled: boolean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0]! : String(err));

export function useAsync<T>(load: () => Promise<T>, key: string, opts: AsyncOptions = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const identity = opts.identity ?? "";
  const pollMs = opts.pollMs;
  const [nonce, setNonce] = useState(0);
  const [slot, setSlot] = useState<Slot<T>>({ identity, data: undefined, error: null, settled: false });
  if (slot.identity !== identity) {
    // Adjusting state while rendering for a new identity (React's documented pattern): drop old data now.
    setSlot({ identity, data: undefined, error: null, settled: false });
  }
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sequence = 0;
    const run = () => {
      const mine = ++sequence;
      loadRef.current().then(
        (data) => {
          if (!cancelled && mine === sequence) setSlot({ identity, data, error: null, settled: true });
        },
        (err: unknown) => {
          if (!cancelled && mine === sequence) setSlot((s) => ({ ...s, identity, error: messageOf(err), settled: true }));
        },
      );
    };
    run();
    const timer = pollMs ? setInterval(run, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, identity, enabled, pollMs, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = slot.identity === identity ? slot : { data: undefined, error: null, settled: false };
  return { data: current.data, error: current.error, loading: enabled && !current.settled, reload };
}
