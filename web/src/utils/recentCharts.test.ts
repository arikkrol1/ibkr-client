import { describe, expect, it } from "vitest";
import type { SymbolMatch } from "../api";
import {
  MAX_RECENTS,
  RECENTS_STORAGE_KEY,
  loadRecents,
  pushRecent,
  recentKey,
  saveRecents,
} from "./recentCharts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const sym = (symbol: string, conId?: number): SymbolMatch => ({ symbol, conId });

describe("recentKey", () => {
  it("prefers conId, falls back to the ticker", () => {
    expect(recentKey(sym("AAA", 1))).toBe("1");
    expect(recentKey(sym("AAA"))).toBe("AAA");
  });
});

describe("pushRecent", () => {
  it("puts the newest visit first", () => {
    const list = pushRecent(pushRecent([], sym("AAA", 1)), sym("BBB", 2));
    expect(list.map((m) => m.symbol)).toEqual(["BBB", "AAA"]);
  });

  it("moves a revisited symbol to the front without duplicating it", () => {
    let list: SymbolMatch[] = [];
    for (const s of [sym("AAA", 1), sym("BBB", 2), sym("CCC", 3), sym("AAA", 1)]) {
      list = pushRecent(list, s);
    }
    expect(list.map((m) => m.symbol)).toEqual(["AAA", "CCC", "BBB"]);
  });

  it(`caps the list at ${MAX_RECENTS}, dropping the oldest`, () => {
    let list: SymbolMatch[] = [];
    for (let i = 0; i < MAX_RECENTS + 5; i++) list = pushRecent(list, sym(`S${i}`, i));
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].symbol).toBe(`S${MAX_RECENTS + 4}`);
    expect(list[MAX_RECENTS - 1].symbol).toBe("S5");
  });
});

describe("loadRecents / saveRecents", () => {
  it("round-trips the list in order", () => {
    const storage = memoryStorage();
    const list = [sym("BBB", 2), sym("AAA", 1)];
    saveRecents(list, storage);
    expect(loadRecents(storage)).toEqual(list);
  });

  it("returns an empty list when nothing is stored", () => {
    expect(loadRecents(memoryStorage())).toEqual([]);
    expect(loadRecents(undefined)).toEqual([]);
  });

  it("ignores corrupt or non-array data", () => {
    expect(loadRecents(memoryStorage({ [RECENTS_STORAGE_KEY]: "{not json" }))).toEqual([]);
    expect(loadRecents(memoryStorage({ [RECENTS_STORAGE_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it("drops malformed entries, dedupes and caps stored data", () => {
    const stored = [
      sym("AAA", 1),
      null,
      { conId: 9 },
      sym("BBB", 2),
      sym("AAA", 1),
      ...Array.from({ length: MAX_RECENTS + 5 }, (_, i) => sym(`S${i}`, 100 + i)),
    ];
    const list = loadRecents(memoryStorage({ [RECENTS_STORAGE_KEY]: JSON.stringify(stored) }));
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list.slice(0, 3).map((m) => m.symbol)).toEqual(["AAA", "BBB", "S0"]);
  });

  it("does not throw when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadRecents(broken)).toEqual([]);
    expect(() => saveRecents([sym("AAA", 1)], broken)).not.toThrow();
  });
});
