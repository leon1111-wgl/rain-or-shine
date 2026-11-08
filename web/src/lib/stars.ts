const KEY = "rain-or-shine.stars";
const ENTRY = /^0x[0-9a-fA-F]{40}#[1-9]\d*$/;

export function readStars(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const raw = storage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string" && ENTRY.test(a)).map((a) => a.toLowerCase()) : [];
  } catch {
    return []; // Storage is blocked, or the entry is not from this page.
  }
}

export function writeStars(stars: string[], storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(stars));
  } catch {
    return; // Storage is unavailable. The choice still holds for this session.
  }
}

export const starKey = (contract: string, id: number) => `${contract.toLowerCase()}#${id}`;

export const isStarred = (stars: string[], key: string) => stars.includes(key.toLowerCase());

export function toggleStar(stars: string[], key: string): string[] {
  const a = key.toLowerCase();
  return stars.includes(a) ? stars.filter((s) => s !== a) : [...stars, a];
}
