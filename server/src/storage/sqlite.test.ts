import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "./sqlite.js";
import type { StoredBar, StoredTrade } from "./storage.js";

let db: SqliteStorage;

beforeEach(() => {
  db = new SqliteStorage(":memory:");
});

const trade = (tradeKey: string, time: number, extra: Partial<StoredTrade> = {}): StoredTrade => ({
  tradeKey,
  symbol: "AAPL",
  multiplier: 1,
  time,
  quantity: 1,
  price: 10,
  commission: -1,
  ...extra,
});

const bar = (time: number, close: number): StoredBar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
});

describe("SqliteStorage", () => {
  it("inserts trades once per key and returns them in time order", async () => {
    expect(await db.upsertTrades([trade("b", 200), trade("a", 100, { conId: 7, secType: "STK" })])).toBe(2);
    expect(await db.upsertTrades([trade("a", 100), trade("c", 50)])).toBe(1);
    const all = await db.getAllTrades();
    expect(all.map((t) => t.tradeKey)).toEqual(["c", "a", "b"]);
    expect(all[1]).toEqual({
      tradeKey: "a",
      symbol: "AAPL",
      conId: 7,
      secType: "STK",
      currency: undefined,
      multiplier: 1,
      time: 100,
      quantity: 1,
      price: 10,
      commission: -1,
    });
  });

  it("archives Flex statements in order", async () => {
    await db.archiveFlexStatement("q1", "<a/>");
    await db.archiveFlexStatement("q2", "<b/>");
    const s = await db.getFlexStatements();
    expect(s.map((x) => [x.queryId, x.xml])).toEqual([
      ["q1", "<a/>"],
      ["q2", "<b/>"],
    ]);
    expect(s[0].fetchedAt).toBeTypeOf("number");
  });

  it("upserts, filters and replaces daily bars per contract", async () => {
    await db.upsertDailyBars("1", [bar(100, 1), bar(200, 2)]);
    await db.upsertDailyBars("1", [bar(200, 3)]);
    await db.upsertDailyBars("2", [bar(100, 9)]);
    expect((await db.getDailyBars("1", 0)).map((b) => b.close)).toEqual([1, 3]);
    expect((await db.getDailyBars("1", 150)).map((b) => b.time)).toEqual([200]);

    await db.replaceDailyBars("1", [bar(300, 4)]);
    expect((await db.getDailyBars("1", 0)).map((b) => b.time)).toEqual([300]);
    expect(await db.getDailyBars("2", 0)).toHaveLength(1);
  });

  it("merges account days field by field", async () => {
    await db.upsertAccountDays([{ date: 100, currency: "USD", nav: 1000, cash: 100, stock: 900 }]);
    await db.upsertAccountDays([{ date: 100, twr: 0.5 }, { date: 50, nav: 990 }]);
    expect(await db.getAccountDays(0)).toEqual([
      { date: 50, currency: null, nav: 990, cash: null, stock: null, twr: null },
      { date: 100, currency: "USD", nav: 1000, cash: 100, stock: 900, twr: 0.5 },
    ]);
    expect(await db.getAccountDays(60)).toHaveLength(1);
  });

  it("inserts cash transactions once per key", async () => {
    const row = { txKey: "c1", time: 100, type: "Dividends", kind: "income" as const, amount: 5 };
    expect(await db.upsertCashTransactions([row, { ...row, txKey: "c2", time: 50 }])).toBe(2);
    expect(await db.upsertCashTransactions([row])).toBe(0);
    const rows = await db.getCashTransactions(0);
    expect(rows.map((r) => r.txKey)).toEqual(["c2", "c1"]);
    expect(await db.getCashTransactions(60)).toHaveLength(1);
  });

  it("stores, overwrites and deletes meta values", async () => {
    expect(await db.getMeta("k")).toBeNull();
    await db.setMeta("k", "1");
    await db.setMeta("k", "2");
    expect(await db.getMeta("k")).toBe("2");
    await db.deleteMeta("k");
    expect(await db.getMeta("k")).toBeNull();
  });

  it("rolls back a failed batch", async () => {
    await expect(
      // An unbindable value makes the driver throw mid-batch.
      db.upsertTrades([trade("ok", 1), { ...trade("bad", 2), price: {} as unknown as number }]),
    ).rejects.toThrow();
    expect(await db.getAllTrades()).toEqual([]);
  });
});
