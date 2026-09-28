import type { PnlSeries } from "../api";

export interface PctRow {
  key: string;
  symbol: string;
  pct?: number;
  periodPnl: number;
  currency?: string;
}

/**
 * Percentage P&L for the timeframe: P&L accrued since the window start divided
 * by the position's market value at the window start (positions opened inside
 * the window fall back to their deployed cost).
 */
export function rowsFor(series: PnlSeries[], startSec: number): PctRow[] {
  const rows: PctRow[] = [];
  for (const s of series) {
    const pts = s.points;
    if (pts.length === 0) continue;
    let base;
    for (const p of pts) {
      if (p.time > startSec) break;
      base = p;
    }
    const last = pts[pts.length - 1];
    const periodPnl = last.value - (base?.value ?? 0);
    const openNow = Math.abs(last.mv ?? 0) > 0.01;
    if (!openNow && Math.abs(periodPnl) < 0.005) continue; // no activity in window
    let denom = Math.abs(base?.mv ?? 0);
    if (denom < 1e-6) denom = s.costBasis ?? 0;
    if (denom < 1e-6) denom = Math.abs(pts.find((p) => Math.abs(p.mv) > 0.01)?.mv ?? 0);
    rows.push({
      key: s.key,
      symbol: s.symbol,
      pct: denom > 0 ? (periodPnl / denom) * 100 : undefined,
      periodPnl,
      currency: s.currency,
    });
  }
  return rows.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
}
