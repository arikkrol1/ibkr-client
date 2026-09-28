import { afterEach, describe, expect, it, vi } from "vitest";
import { of, Subject } from "rxjs";

const ibMock = vi.hoisted(() => ({
  api: { getManagedAccounts: vi.fn(), getAccountUpdates: vi.fn(), getPnL: vi.fn() },
}));
vi.mock("./connection.js", () => ({ ib: ibMock }));

import { getPortfolio, numTag, settleWhenComplete, sumAbsMarketValue } from "./portfolio.js";

type Tags = Map<string, Map<string, { value: string }>>;
const tags = (entries: Record<string, Record<string, string>>): Tags =>
  new Map(
    Object.entries(entries).map(([tag, perCcy]) => [
      tag,
      new Map(Object.entries(perCcy).map(([ccy, value]) => [ccy, { value }])),
    ]),
  );

describe("numTag", () => {
  it("prefers BASE, then USD, then the first currency", () => {
    expect(numTag(tags({ NetLiquidation: { USD: "90", BASE: "100" } }), "NetLiquidation")).toBe(100);
    expect(numTag(tags({ NetLiquidation: { EUR: "80", USD: "90" } }), "NetLiquidation")).toBe(90);
    expect(numTag(tags({ NetLiquidation: { EUR: "80" } }), "NetLiquidation")).toBe(80);
  });

  it("accepts alternative tag names in priority order", () => {
    const vals = tags({ CashBalance: { BASE: "5" } });
    expect(numTag(vals, "TotalCashValue", "CashBalance")).toBe(5);
  });

  it("returns undefined for missing or non-numeric values", () => {
    expect(numTag(undefined, "X")).toBeUndefined();
    expect(numTag(tags({}), "X")).toBeUndefined();
    expect(numTag(tags({ X: { BASE: "n/a" } }), "X")).toBeUndefined();
  });
});

describe("sumAbsMarketValue", () => {
  it("sums |market value| over non-zero rows", () => {
    const portfolio = new Map([
      ["U1", [{ pos: 10, marketValue: 100 }, { pos: -5, marketValue: -50 }, { pos: 0, marketValue: 999 }]],
      ["U2", [{ pos: 1 }]],
    ]);
    expect(sumAbsMarketValue(portfolio)).toBe(150);
    expect(sumAbsMarketValue(undefined)).toBe(0);
  });
});

describe("settleWhenComplete", () => {
  afterEach(() => vi.useRealTimers());

  const gate = (v: number) => v > 0;
  const complete = (v: number) => v >= 10;

  it("resolves on the first complete emission", async () => {
    const s = new Subject<number>();
    const p = settleWhenComplete(s, gate, complete, 600, 10_000);
    s.next(0);
    s.next(3);
    s.next(10);
    await expect(p).resolves.toBe(10);
  });

  it("falls back to the last emission once the stream goes quiet", async () => {
    vi.useFakeTimers();
    const s = new Subject<number>();
    const p = settleWhenComplete(s, gate, complete, 600, 10_000);
    s.next(3);
    await vi.advanceTimersByTimeAsync(300);
    s.next(5);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe(5);
  });

  it("rejects when nothing passes the gate before the deadline", async () => {
    vi.useFakeTimers();
    const s = new Subject<number>();
    const p = settleWhenComplete(s, gate, complete, 600, 10_000);
    const assertion = expect(p).rejects.toThrow(/Timed out waiting for account updates/);
    s.next(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

describe("getPortfolio", () => {
  const row = (symbol: string, conId: number, pos: number, marketValue: number, unrealizedPNL?: number) => ({
    contract: { symbol, conId, secType: "STK", currency: "USD" },
    pos,
    avgCost: 1,
    marketPrice: 2,
    marketValue,
    unrealizedPNL,
    realizedPNL: 0,
  });

  it("assembles balances and positions, largest first", async () => {
    ibMock.api.getManagedAccounts.mockResolvedValue(["U1"]);
    ibMock.api.getAccountUpdates.mockReturnValue(
      of({
        all: {
          value: new Map([
            [
              "U1",
              tags({
                NetLiquidation: { BASE: "10000" },
                CashBalance: { BASE: "2000" },
                GrossPositionValue: { BASE: "800" },
              }),
            ],
          ]),
          portfolio: new Map([
            ["U1", [row("MSFT", 2, 1, 300, 10), row("AAPL", 1, 5, 500, -4), row("OLD", 3, 0, 0)]],
          ]),
        },
      }),
    );
    ibMock.api.getPnL.mockReturnValue(of({ dailyPnL: 12 }));

    const p = await getPortfolio();
    expect(p.account).toBe("U1");
    expect(p.dailyPnL).toBe(12);
    expect(p.positions.map((x) => x.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(p.balances).toMatchObject({
      netLiquidation: 10000,
      totalCashValue: 2000,
      grossPositionValue: 800,
      // No account-level tag — summed from the position rows.
      unrealizedPnL: 6,
      realizedPnL: 0,
    });
  });
});
