import { describe, expect, it } from "vitest";
import type { HistoryBar, PnlSeries } from "../api";
import { compareByMonth, compound, cumulative, niceTicks } from "./vsSpy";

const t = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;
const bars = (...pts: [number, number][]): HistoryBar[] =>
  pts.map(([time, close]) => ({ time, open: close, high: close, low: close, close, volume: 0 }));

describe("compareByMonth", () => {
  const aapl: PnlSeries = {
    key: "c1",
    symbol: "AAPL",
    total: 210,
    costBasis: 1000,
    points: [
      { time: t(2024, 0, 15), value: 0, mv: 1000 },
      { time: t(2024, 0, 31), value: 100, mv: 1100 },
      { time: t(2024, 1, 20), value: 210, mv: 1210 },
    ],
  };
  const spy = bars([t(2023, 11, 29), 100], [t(2024, 0, 31), 110], [t(2024, 1, 28), 99]);

  it("aligns monthly portfolio and SPY returns", () => {
    const c = compareByMonth([aapl], spy)!;
    expect(c.years).toEqual([2024]);
    const months = c.byYear.get(2024)!;
    expect(months).toHaveLength(12);
    // First month: over deployed cost; SPY has no prior month in range.
    expect(months[0]).toEqual({
      month: 0,
      portfolio: 10,
      spy: undefined,
      symbols: [{ symbol: "AAPL", pnl: 100 }],
    });
    // Then over the prior month-end market value, and SPY month-end closes.
    expect(months[1].portfolio).toBeCloseTo(10);
    expect(months[1].spy).toBeCloseTo(-10);
    expect(months[1].symbols).toEqual([{ symbol: "AAPL", pnl: 110 }]);
    expect(months[2]).toEqual({ month: 2 });
  });

  it("returns null without activity", () => {
    expect(compareByMonth([], spy)).toBeNull();
  });
});

describe("compound", () => {
  it("compounds only months with a value", () => {
    expect(compound([10, undefined, 10])).toBeCloseTo(21);
    expect(compound([undefined])).toBeUndefined();
    expect(compound([])).toBeUndefined();
  });
});

describe("cumulative", () => {
  it("builds YTD series over active months, treating missing SPY as flat", () => {
    const pts = cumulative([
      { month: 0, portfolio: 10, spy: undefined, symbols: [] },
      { month: 1 },
      { month: 2, portfolio: 10, spy: -10 },
    ]);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ month: 0, spy: 0, monthPortfolio: 10 });
    expect(pts[0].portfolio).toBeCloseTo(10);
    expect(pts[1].portfolio).toBeCloseTo(21);
    expect(pts[1].spy).toBeCloseTo(-10);
    expect(pts[1].symbols).toEqual([]);
  });
});

describe("niceTicks", () => {
  it("picks 1/2/5 steps spanning the range", () => {
    expect(niceTicks(0, 10)).toEqual([0, 5, 10]);
    expect(niceTicks(-10, 10)).toEqual([-10, -5, 0, 5, 10]);
    expect(niceTicks(0, 0.4)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });

  it("degenerates to a zero line for an empty range", () => {
    expect(niceTicks(1, 1)).toEqual([0]);
  });
});
