// Chain reads with explicit loading and error states.
// - `key` covers every input of the request. A new key reads again. Responses from older runs are dropped.
// - `identity` names the owner of the data. A new identity clears the old data at once.
//   One account's or market's numbers never appear as another's. Refreshes keep data on screen.
// - An RPC error never becomes empty or zero data. It shows next to the last good read.

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
    // Update state during render for a new identity. React documents this pattern. The old data goes now.
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
