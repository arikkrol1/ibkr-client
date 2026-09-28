import { describe, expect, it } from "vitest";
import type { PnlSeries } from "../api";
import { aggregateByYear } from "./yearlyPnl";

const t = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;
const series = (key: string, points: [number, number][]): PnlSeries => ({
  key,
  symbol: key,
  total: 0,
  points: points.map(([time, value]) => ({ time, value, mv: 0 })),
});

describe("aggregateByYear", () => {
  it("diffs each symbol's cumulative curve at year ends", () => {
    const y = aggregateByYear([
      series("A", [[t(2023, 5, 1), 0], [t(2023, 11, 29), 100], [t(2024, 2, 1), 50]]),
      // Closed mid-2024: keeps its realized P&L in 2024 only.
      series("B", [[t(2024, 1, 1), 30], [t(2024, 4, 1), 80]]),
      series("Flat", [[t(2023, 1, 1), 0], [t(2024, 1, 1), 0]]),
    ])!;
    expect(y.years).toEqual([2023, 2024]);
    expect(y.rows.get(2023)).toEqual([{ key: "A", symbol: "A", pnl: 100 }]);
    expect(y.rows.get(2024)).toEqual([
      { key: "B", symbol: "B", pnl: 80 },
      { key: "A", symbol: "A", pnl: -50 },
    ]);
    expect(y.totals.get(2024)).toBe(30);
  });

  it("returns null without any P&L", () => {
    expect(aggregateByYear([])).toBeNull();
    expect(aggregateByYear([series("A", [])])).toBeNull();
    expect(aggregateByYear([series("A", [[t(2024, 0, 1), 0]])])).toBeNull();
  });
});
