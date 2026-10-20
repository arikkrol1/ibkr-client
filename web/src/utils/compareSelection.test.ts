import { describe, expect, it } from "vitest";
import {
  COMPARE_STORAGE_KEY,
  DEFAULT_COMPARE_ENTRIES,
  loadCompareEntries,
  saveCompareEntries,
  type CompareEntry,
} from "./compareSelection";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const entries: CompareEntry[] = [
  { key: "SPY", symbol: "SPY", slot: 0 },
  { key: "c123", symbol: "AAA", conId: 123, name: "Alpha Corp", slot: 2 },
];

describe("loadCompareEntries", () => {
  it("defaults to SPY only when nothing is stored", () => {
    expect(loadCompareEntries(memoryStorage())).toEqual(DEFAULT_COMPARE_ENTRIES);
    expect(loadCompareEntries(undefined)).toEqual(DEFAULT_COMPARE_ENTRIES);
  });

  it("round-trips a saved selection", () => {
    const s = memoryStorage();
    saveCompareEntries(entries, s);
    expect(loadCompareEntries(s)).toEqual(entries);
  });

  it("keeps a saved empty selection empty", () => {
    const s = memoryStorage();
    saveCompareEntries([], s);
    expect(loadCompareEntries(s)).toEqual([]);
  });

  it("falls back to the default on corrupt or non-array data", () => {
    expect(loadCompareEntries(memoryStorage({ [COMPARE_STORAGE_KEY]: "{oops" }))).toEqual(
      DEFAULT_COMPARE_ENTRIES,
    );
    expect(loadCompareEntries(memoryStorage({ [COMPARE_STORAGE_KEY]: '{"a":1}' }))).toEqual(
      DEFAULT_COMPARE_ENTRIES,
    );
  });

  it("drops malformed entries and duplicate keys or slots", () => {
    const raw = JSON.stringify([
      { key: "SPY", symbol: "SPY", slot: 0 },
      { key: "SPY", symbol: "SPY", slot: 1 },
      { key: "BBB", symbol: "BBB", slot: 0 },
      { key: "CCC", symbol: "", slot: 3 },
      { key: "DDD", symbol: "DDD", slot: -1 },
      { key: "EEE", symbol: "EEE", slot: 4, conId: "x" },
      null,
      { key: "FFF", symbol: "FFF", slot: 5, extra: true },
    ]);
    expect(loadCompareEntries(memoryStorage({ [COMPARE_STORAGE_KEY]: raw }))).toEqual([
      { key: "SPY", symbol: "SPY", slot: 0 },
      { key: "FFF", symbol: "FFF", slot: 5 },
    ]);
  });

  it("returns the default when storage access throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(loadCompareEntries(throwing)).toEqual(DEFAULT_COMPARE_ENTRIES);
  });
});

describe("saveCompareEntries", () => {
  it("ignores storage failures", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveCompareEntries(entries, throwing)).not.toThrow();
  });
});
