// The previous totals live in state, adjusted while rendering (React's documented pattern), so no ref is read during render.

import { useState } from "react";
import { flashTone } from "../lib/market";

type Tone = "up" | "down" | null;

export function useFlash(yes: bigint, no: bigint): { tone: Tone; nonce: number } {
  const [state, setState] = useState<{ yes: bigint; no: bigint; tone: Tone; nonce: number }>({ yes, no, tone: null, nonce: 0 });
  if (state.yes !== yes || state.no !== no) {
    setState({ yes, no, tone: flashTone(state, { yes, no }), nonce: state.nonce + 1 });
  }
  return { tone: state.tone, nonce: state.nonce };
}
