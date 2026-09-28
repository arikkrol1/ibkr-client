import type { HistoryBar } from "../api";

/** % change over the timeframe window, measured against the prior close. */
export function windowPct(bars: HistoryBar[], startSec: number): number | undefined {
  let idx = bars.findIndex((b) => b.time >= startSec);
  if (idx === -1) idx = bars.length;
  const w = bars.slice(Math.max(0, idx - 1));
  const base = w[0]?.close;
  const last = w[w.length - 1]?.close;
  return base != null && last != null && base !== 0
    ? ((last - base) / Math.abs(base)) * 100
    : undefined;
}
