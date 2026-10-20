/** One symbol on the Compare chart. */
export interface CompareEntry {
  key: string;
  symbol: string;
  conId?: number;
  name?: string;
  /** Palette slot assigned when the symbol is added; stable across removals. */
  slot: number;
}

/** What the Compare chart starts with, and what **Clear** resets it to. */
export const DEFAULT_COMPARE_ENTRIES: CompareEntry[] = [{ key: "SPY", symbol: "SPY", slot: 0 }];

/** localStorage key holding the Compare tab's selected symbols. */
export const COMPARE_STORAGE_KEY = "ibkr-client:compareSelection";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // access can throw when site data is blocked
  }
}

function isEntry(e: unknown): e is CompareEntry {
  if (e == null || typeof e !== "object") return false;
  const x = e as CompareEntry;
  return (
    typeof x.key === "string" &&
    x.key !== "" &&
    typeof x.symbol === "string" &&
    x.symbol !== "" &&
    Number.isInteger(x.slot) &&
    x.slot >= 0 &&
    (x.conId === undefined || typeof x.conId === "number") &&
    (x.name === undefined || typeof x.name === "string")
  );
}

/**
 * Read the persisted selection. A missing, corrupt, or inaccessible store
 * yields the default (SPY only); a saved empty list stays empty. Malformed
 * entries and duplicate keys/slots are dropped. Never throws.
 */
export function loadCompareEntries(storage = defaultStorage()): CompareEntry[] {
  try {
    const raw = storage?.getItem(COMPARE_STORAGE_KEY);
    if (raw == null) return DEFAULT_COMPARE_ENTRIES;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COMPARE_ENTRIES;
    const keys = new Set<string>();
    const slots = new Set<number>();
    const out: CompareEntry[] = [];
    for (const e of parsed) {
      if (!isEntry(e) || keys.has(e.key) || slots.has(e.slot)) continue;
      keys.add(e.key);
      slots.add(e.slot);
      out.push({ key: e.key, symbol: e.symbol, conId: e.conId, name: e.name, slot: e.slot });
    }
    return out;
  } catch {
    return DEFAULT_COMPARE_ENTRIES;
  }
}

/** Persist the selection; failures (quota, blocked storage) are ignored. */
export function saveCompareEntries(entries: CompareEntry[], storage = defaultStorage()): void {
  try {
    storage?.setItem(COMPARE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // best-effort persistence
  }
}
