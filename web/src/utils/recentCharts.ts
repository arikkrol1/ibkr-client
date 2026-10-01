import type { SymbolMatch } from "../api";

/** How many recently viewed symbols the Charts tab remembers. */
export const MAX_RECENTS = 20;

/** localStorage key holding the recently viewed list (newest first). */
export const RECENTS_STORAGE_KEY = "ibkr-client:recentCharts";

/** Stable identity for a viewed symbol (conId when known, else the ticker). */
export function recentKey(m: SymbolMatch): string {
  return String(m.conId ?? m.symbol ?? "");
}

/**
 * Move `m` to the front of `list` (newest first), dropping any earlier visit of
 * the same symbol and capping the result at `max` entries.
 */
export function pushRecent(
  list: SymbolMatch[],
  m: SymbolMatch,
  max = MAX_RECENTS,
): SymbolMatch[] {
  const key = recentKey(m);
  return [m, ...list.filter((x) => recentKey(x) !== key)].slice(0, max);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // access can throw when site data is blocked
  }
}

/**
 * Read the persisted list, discarding anything malformed. Never throws — a
 * missing, corrupt, or inaccessible store just yields an empty list.
 */
export function loadRecents(storage = defaultStorage()): SymbolMatch[] {
  try {
    const raw = storage?.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (m): m is SymbolMatch =>
        m != null &&
        typeof m === "object" &&
        typeof (m as SymbolMatch).symbol === "string" &&
        (m as SymbolMatch).symbol !== "",
    );
    // Re-apply dedupe/cap in case the stored data predates a change to either.
    return valid.reduceRight<SymbolMatch[]>((acc, m) => pushRecent(acc, m), []);
  } catch {
    return [];
  }
}

/** Persist the list; failures (quota, blocked storage) are ignored. */
export function saveRecents(list: SymbolMatch[], storage = defaultStorage()): void {
  try {
    storage?.setItem(RECENTS_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    // best-effort persistence
  }
}
