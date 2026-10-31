// Starred events (自选): the markets a viewer wants to see first, kept per browser as "<contract>#<id>". Storage can be
// missing or blocked (private mode, a sandboxed frame), so every access is guarded. The list then lives for the
// session only. Nothing here reads the chain.

const KEY = "rainmark.stars";
const ENTRY = /^0x[0-9a-fA-F]{40}#[1-9]\d*$/;

/** The stored entries, lower-cased. An unreadable or malformed entry counts as no stars. */
export function readStars(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const raw = storage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string" && ENTRY.test(a)).map((a) => a.toLowerCase()) : [];
  } catch {
    return []; // storage blocked or the entry is not what this page wrote
  }
}

export function writeStars(stars: string[], storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(stars));
  } catch {
    return; // storage unavailable: the choice still applies for this session
  }
}

/** The key of market `id` of the contract at `contract`. */
export const starKey = (contract: string, id: number) => `${contract.toLowerCase()}#${id}`;

export const isStarred = (stars: string[], key: string) => stars.includes(key.toLowerCase());

/** The list with `key` added, or removed when it was there. */
export function toggleStar(stars: string[], key: string): string[] {
  const a = key.toLowerCase();
  return stars.includes(a) ? stars.filter((s) => s !== a) : [...stars, a];
}
