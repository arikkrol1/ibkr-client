import { describe, expect, it } from "vitest";
import type { PnlPoint, PnlSeries } from "../api";
import { rowsFor } from "./pctRows";

const series = (key: string, points: [number, number, number][], costBasis?: number): PnlSeries => ({
  key,
  symbol: key,
  total: points.at(-1)?.[1] ?? 0,
  costBasis,
  points: points.map(([time, value, mv]): PnlPoint => ({ time, value, mv })),
});

describe("rowsFor", () => {
  const all = [
    // Held throughout: base is the point at the window start.
    series("A", [[100, 0, 1000], [200, 50, 1050], [300, 100, 1100]], 1000),
    // Opened inside the window: falls back to deployed cost.
    series("B", [[250, 0, 500], [300, 20, 520]], 500),
    // Closed before the window, no P&L since: hidden.
    series("C", [[50, 30, 0], [300, 30, 0]]),
    // Closed inside the window: measured against its value at the start.
    series("D", [[100, 0, 200], [250, 20, 0]]),
    // No denominator at all.
    series("E", [[250, 5, 0]]),
    series("F", []),
  ];

  it("computes P&L since the window start over the starting value, best first", () => {
    const rows = rowsFor(all, 200);
    expect(rows.map((r) => r.key)).toEqual(["D", "A", "B", "E"]);
    expect(rows[0]).toMatchObject({ periodPnl: 20, pct: 10 });
    expect(rows[1].pct).toBeCloseTo((50 / 1050) * 100);
    expect(rows[2]).toMatchObject({ periodPnl: 20, pct: 4 });
    expect(rows[3]).toMatchObject({ periodPnl: 5, pct: undefined });
  });

  it("keeps open positions even when flat over the window", () => {
    const rows = rowsFor([series("G", [[100, 10, 500], [300, 10, 500]])], 200);
    expect(rows).toEqual([{ key: "G", symbol: "G", pct: 0, periodPnl: 0, currency: undefined }]);
  });
});
