import type { ActivityTrade, HistoryBar, SymbolActivity } from "../api";

const DAY = 86_400;

export interface ActivityTimeframe {
  key: string;
  label: string;
  /** Window start over the daily bars, or null for every bar fetched. */
  start: (now: Date) => Date | null;
  /** Short windows fetch their own intraday bars instead of slicing daily ones. */
  intraday?: { barSize: string; duration: string; barSeconds: number };
}

const monthsBack = (n: Date, m: number) => new Date(n.getFullYear(), n.getMonth() - m, n.getDate());

export const ACTIVITY_TIMEFRAMES: ActivityTimeframe[] = [
  {
    key: "1d",
    label: "1D",
    start: () => null,
    intraday: { barSize: "5 mins", duration: "1 D", barSeconds: 300 },
  },
  {
    key: "1w",
    label: "1W",
    start: () => null,
    intraday: { barSize: "1 hour", duration: "1 W", barSeconds: 3600 },
  },
  { key: "1m", label: "1M", start: (n) => monthsBack(n, 1) },
  { key: "3m", label: "3M", start: (n) => monthsBack(n, 3) },
  { key: "6m", label: "6M", start: (n) => monthsBack(n, 6) },
  { key: "ytd", label: "YTD", start: (n) => new Date(n.getFullYear(), 0, 1) },
  { key: "1y", label: "1Y", start: (n) => monthsBack(n, 12) },
  { key: "3y", label: "3Y", start: (n) => monthsBack(n, 36) },
  { key: "all", label: "All", start: () => null },
];

export const DEFAULT_ACTIVITY_TIMEFRAME = "1y";

export const STATUS_FILTERS = ["All", "Open", "Closed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export function matchesStatus(s: Pick<SymbolActivity, "open">, filter: StatusFilter): boolean {
  return filter === "All" || (filter === "Open" ? s.open : !s.open);
}

/**
 * Bars from `startSec` onward, plus the close just before it so the line
 * starts at the window's left edge. `null` keeps every bar.
 */
export function windowBars(bars: HistoryBar[], startSec: number | null): HistoryBar[] {
  if (startSec == null) return bars;
  let idx = bars.findIndex((b) => b.time >= startSec);
  if (idx === -1) idx = bars.length;
  return bars.slice(Math.max(0, idx - 1));
}

export interface TradeMarker {
  /** Time of the bar the trade falls in. */
  time: number;
  side: ActivityTrade["side"];
  quantity: number;
  price: number;
}

/**
 * Snap each trade onto the bar covering it (`barSeconds` long: a day, or an
 * intraday interval), so chart markers line up with a data point. Trades
 * outside the bars' span (an older window, a gap with no bar) are dropped.
 * Both inputs must be time-ascending.
 */
export function tradeMarkers(
  trades: ActivityTrade[],
  bars: HistoryBar[],
  barSeconds = DAY,
): TradeMarker[] {
  const out: TradeMarker[] = [];
  if (bars.length === 0) return out;
  let b = 0;
  for (const t of trades) {
    while (b < bars.length && bars[b].time + barSeconds <= t.time) b += 1;
    const bar = bars[b];
    if (!bar || t.time < bar.time) continue;
    out.push({ time: bar.time, side: t.side, quantity: t.quantity, price: t.price });
  }
  return out;
}

/** % move from the last fill to the latest close. */
export function changeSince(lastPrice: number, bars: HistoryBar[]): number | undefined {
  const close = bars[bars.length - 1]?.close;
  if (close == null || !lastPrice) return undefined;
  return ((close - lastPrice) / lastPrice) * 100;
}

/** "Sep 22, 2026" for a UNIX-seconds timestamp. */
export function fmtTradeDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
