import { describe, expect, it } from "vitest";
import type { AccountDay, PnlSeries } from "../api";
import { aggregateByMonth } from "./periodPnl";

const t = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;
const series = (key: string, points: [number, number, number][], costBasis?: number): PnlSeries => ({
  key,
  symbol: key,
  total: 0,
  costBasis,
  points: points.map(([time, value, mv]) => ({ time, value, mv })),
});

describe("aggregateByMonth", () => {
  const q1 = series(
    "A",
    [
      [t(2024, 0, 15), 0, 1000],
      [t(2024, 0, 31), 100, 1100],
      [t(2024, 1, 15), 50, 1050],
      [t(2024, 2, 10), 200, 1200],
    ],
    1000,
  );

  it("diffs cumulative P&L at month ends", () => {
    const p = aggregateByMonth([q1], [], [])!;
    expect(p.years).toEqual([2024]);
    expect([...p.byMonth]).toEqual([
      ["2024-0", 100],
      ["2024-1", -50],
      ["2024-2", 150],
    ]);
    expect(p.byYear.get(2024)).toBe(200);
    // First year: no prior year-end, so % is over deployed cost.
    expect(p.byYearPct.get(2024)).toBe(20);
    expect(p.navBased.size).toBe(0);
    expect(p.byYearTwr.get(2024)).toBeUndefined();
    expect(p.hasIncome).toBe(false);
  });

  it("adds income into the month it was paid", () => {
    const p = aggregateByMonth([q1], [{ time: t(2024, 1, 20), type: "Dividends", amount: 25 }], [])!;
    expect(p.byMonth.get("2024-1")).toBe(-25);
    expect(p.byYear.get(2024)).toBe(225);
    expect(p.hasIncome).toBe(true);
  });

  it("drops leading months with no position", () => {
    const early = series("A", [
      [t(2023, 10, 1), 0, 0],
      [t(2024, 0, 15), 10, 500],
    ]);
    const p = aggregateByMonth([early], [], [])!;
    expect(p.years).toEqual([2024]);
    expect([...p.byMonth.keys()]).toEqual(["2024-0"]);
  });

  describe("multi-year %", () => {
    const twoYears = series(
      "A",
      [
        [t(2023, 5, 15), 0, 1000],
        [t(2023, 11, 29), 100, 1100],
        [t(2024, 5, 14), 300, 1300],
      ],
      1000,
    );

    it("measures against prior year-end position value without NAV data", () => {
      const p = aggregateByMonth([twoYears], [], [])!;
      expect(p.years).toEqual([2024, 2023]);
      expect(p.byYear.get(2023)).toBe(100);
      expect(p.byYear.get(2024)).toBe(200);
      expect(p.byYearPct.get(2023)).toBe(10);
      expect(p.byYearPct.get(2024)).toBeCloseTo((200 / 1100) * 100);
    });

    it("upgrades to the prior year-end NAV when every year has one", () => {
      const nav: AccountDay[] = [
        { time: t(2023, 11, 15), nav: 1900 },
        { time: t(2023, 11, 29), nav: 2000 },
      ];
      const p = aggregateByMonth([twoYears], [], nav)!;
      expect(p.byYearPct.get(2024)).toBe(10);
      expect([...p.navBased]).toEqual([2024]);
      expect(p.byYearPct.get(2023)).toBe(10); // first year: cost fallback
    });
  });

  it("chains IBKR's daily TWR only for fully covered years", () => {
    const covered: AccountDay[] = [
      { time: t(2024, 0, 1), twr: 1 },
      { time: t(2024, 0, 2), twr: 2 },
    ];
    expect(aggregateByMonth([q1], [], covered)!.byYearTwr.get(2024)).toBeCloseTo(3.02);

    const partial: AccountDay[] = [{ time: t(2024, 0, 5), twr: 1 }];
    expect(aggregateByMonth([q1], [], partial)!.byYearTwr.get(2024)).toBeUndefined();
  });

  it("returns null without activity", () => {
    expect(aggregateByMonth([], [], [])).toBeNull();
    expect(aggregateByMonth([series("A", [[t(2024, 0, 1), 0, 0]])], [], [])).toBeNull();
  });
});
