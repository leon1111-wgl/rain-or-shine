import { useEffect, useState } from "react";

export type MarketView = "detail" | "waiting" | "settlement";
export type ListTab = "markets" | "ranks" | "data";

export type Route =
  | { page: "landing" }
  | { page: "list"; tab: ListTab }
  | { page: "market"; view: MarketView; id: number }
  | { page: "pick"; view: MarketView }
  | { page: "mine" }
  | { page: "ops"; id?: number; template?: number }
  | { page: "not-found"; path: string };

const ID = "([1-9]\\d{0,8})";

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { page: "landing" };
  if (path === "/markets") return { page: "list", tab: "markets" };
  const tab = /^\/markets\/(ranks|data)$/.exec(path);
  if (tab) return { page: "list", tab: tab[1] as ListTab };
  if (path === "/mine") return { page: "mine" };
  if (path === "/ops") return { page: "ops" };
  const ops = new RegExp(`^/ops/${ID}$`).exec(path);
  if (ops) return { page: "ops", id: Number(ops[1]) };
  const template = new RegExp(`^/ops/new/${ID}$`).exec(path);
  if (template) return { page: "ops", template: Number(template[1]) };
  const pick = /^\/(detail|waiting|settlement)$/.exec(path);
  if (pick) return { page: "pick", view: pick[1] as MarketView };
  const market = new RegExp(`^/market/${ID}(?:/(waiting|settlement))?$`).exec(path);
  if (market) return { page: "market", id: Number(market[1]), view: (market[2] as MarketView | undefined) ?? "detail" };
  return { page: "not-found", path };
}

export const href = {
  home: "#/",
  list: "#/markets",
  tab: (tab: ListTab) => (tab === "markets" ? "#/markets" : `#/markets/${tab}`),
  market: (id: number, view: MarketView = "detail") => `#/market/${id}${view === "detail" ? "" : `/${view}`}`,
  pick: (view: MarketView) => `#/${view}`,
  mine: "#/mine",
  ops: (id?: number) => (id ? `#/ops/${id}` : "#/ops"),
  template: (id: number) => `#/ops/new/${id}`,
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
