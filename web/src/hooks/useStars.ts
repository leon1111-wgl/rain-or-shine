// The viewer's starred events for the markets page: read once, written on every change, keyed by this
// deployment's market contract so another deployment's stars never apply.

import { useCallback, useState } from "react";
import { useMetricApp } from "../metric/context";
import { isStarred, readStars, starKey, toggleStar, writeStars } from "../lib/stars";

export function useStars() {
  const contract = useMetricApp().dep.contracts.PredictionMarket.address;
  const [stars, setStars] = useState<string[]>(() => readStars());
  const toggle = useCallback(
    (id: number) => {
      setStars((current) => {
        const next = toggleStar(current, starKey(contract, id));
        writeStars(next);
        return next;
      });
    },
    [contract],
  );
  const starred = useCallback((id: number) => isStarred(stars, starKey(contract, id)), [stars, contract]);
  return { starred, toggle };
}
