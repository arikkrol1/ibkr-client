import type { PnlSeries } from "../api";

export interface YearRow {
  key: string;
  symbol: string;
  pnl: number;
}

export interface YearlyPnl {
  /** Ascending. */
  years: number[];
  /** year -> per-symbol P&L accrued that year, sorted descending. */
  rows: Map<number, YearRow[]>;
  totals: Map<number, number>;
}

/**
 * Per-symbol P&L accrued in each calendar year: diff every symbol's cumulative
 * curve at consecutive year-end boundaries. A symbol contributes 0 before its
 * first point and holds its final value after its last, so closed positions
 * keep their realized P&L in the year it accrued.
 */
export function aggregateByYear(series: PnlSeries[]): YearlyPnl | null {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of series) {
    if (s.points.length === 0) continue;
    minT = Math.min(minT, s.points[0].time);
    maxT = Math.max(maxT, s.points[s.points.length - 1].time);
  }
  if (!Number.isFinite(minT)) return null;

  const firstYear = new Date(minT * 1000).getUTCFullYear();
  const lastYear = new Date(maxT * 1000).getUTCFullYear();

  const rows = new Map<number, YearRow[]>();
  const totals = new Map<number, number>();
  for (const s of series) {
    let i = 0;
    let cum = 0;
    let prev = 0;
    for (let year = firstYear; year <= lastYear; year++) {
      const endSec = Date.UTC(year + 1, 0, 1) / 1000;
      while (i < s.points.length && s.points[i].time < endSec) {
        cum = s.points[i].value;
        i += 1;
      }
      const pnl = cum - prev;
      prev = cum;
      if (Math.abs(pnl) < 0.005) continue;
      let list = rows.get(year);
      if (!list) rows.set(year, (list = []));
      list.push({ key: s.key, symbol: s.symbol, pnl });
      totals.set(year, (totals.get(year) ?? 0) + pnl);
    }
  }
  if (rows.size === 0) return null;
  for (const list of rows.values()) list.sort((a, b) => b.pnl - a.pnl);
  return { years: [...rows.keys()].sort((a, b) => a - b), rows, totals };
}
