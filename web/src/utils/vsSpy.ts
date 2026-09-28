import type { HistoryBar, PnlSeries } from "../api";

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface SymbolPnl {
  symbol: string;
  /** P&L in dollars accrued this month. */
  pnl: number;
}

export interface MonthCompare {
  month: number;
  portfolio?: number;
  spy?: number;
  /** Symbols with nonzero P&L this month, winners first. */
  symbols?: SymbolPnl[];
}

export interface YearsVsSpy {
  /** Ascending. */
  years: number[];
  /** year -> 12 entries (months with no data have both values undefined). */
  byYear: Map<number, MonthCompare[]>;
}

/**
 * Monthly % returns for the whole account and for SPY, aligned on calendar
 * month boundaries. Portfolio return = P&L accrued that month over gross
 * market value at the prior month end (falling back to deployed cost when the
 * account had no prior market value, mirroring PnlByPeriod). SPY return uses
 * month-end closes.
 */
export function compareByMonth(series: PnlSeries[], bars: HistoryBar[]): YearsVsSpy | null {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of series) {
    if (s.points.length === 0) continue;
    minT = Math.min(minT, s.points[0].time);
    maxT = Math.max(maxT, s.points[s.points.length - 1].time);
  }
  if (!Number.isFinite(minT)) return null;

  // Month boundaries: each entry is a month plus the UNIX second it ends at.
  const first = new Date(minT * 1000);
  const last = new Date(maxT * 1000);
  const months: { y: number; m: number; endSec: number }[] = [];
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  while (y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth())) {
    months.push({ y, m, endSec: Date.UTC(y, m + 1, 1) / 1000 });
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }

  // Portfolio cumulative P&L (total and per symbol) and gross market value at
  // each month end.
  const cum = new Array<number>(months.length).fill(0);
  const mvAbs = new Array<number>(months.length).fill(0);
  const bySymbol = new Map<string, number[]>();
  for (const s of series) {
    let symCum = bySymbol.get(s.symbol);
    if (!symCum) bySymbol.set(s.symbol, (symCum = new Array<number>(months.length).fill(0)));
    let i = 0;
    let lastValue = 0;
    let lastMv = 0;
    for (let b = 0; b < months.length; b++) {
      while (i < s.points.length && s.points[i].time < months[b].endSec) {
        lastValue = s.points[i].value;
        lastMv = s.points[i].mv;
        i += 1;
      }
      cum[b] += lastValue;
      symCum[b] += lastValue;
      mvAbs[b] += Math.abs(lastMv);
    }
  }

  // SPY close at each month end (undefined before the first bar).
  const spyClose = new Array<number | undefined>(months.length).fill(undefined);
  {
    let i = 0;
    let lastClose: number | undefined;
    for (let b = 0; b < months.length; b++) {
      while (i < bars.length && bars[i].time < months[b].endSec) {
        lastClose = bars[i].close;
        i += 1;
      }
      spyClose[b] = lastClose;
    }
  }

  const firstActive = cum.findIndex((v, b) => Math.abs(v) > 0.005 || mvAbs[b] > 0.005);
  if (firstActive < 0) return null;

  const byYear = new Map<number, MonthCompare[]>();
  for (let b = firstActive; b < months.length; b++) {
    const mo = months[b];

    const pnl = cum[b] - (b > 0 ? cum[b - 1] : 0);
    let denom = b > 0 ? mvAbs[b - 1] : 0;
    if (denom < 1e-6) {
      // Account had no market value at the month start (first month, or fully
      // in cash): fall back to the deployed cost of series trading by month end.
      denom = series.reduce(
        (sum, s) =>
          s.points.length > 0 && s.points[0].time < mo.endSec
            ? sum + (s.costBasis ?? 0)
            : sum,
        0,
      );
    }
    const portfolio = denom > 1e-6 ? (pnl / denom) * 100 : undefined;

    const prevClose = b > 0 ? spyClose[b - 1] : undefined;
    const close = spyClose[b];
    const spy =
      prevClose != null && close != null && prevClose > 0
        ? (close / prevClose - 1) * 100
        : undefined;

    const symbols: SymbolPnl[] = [];
    for (const [symbol, symCum] of bySymbol) {
      const symPnl = symCum[b] - (b > 0 ? symCum[b - 1] : 0);
      if (Math.abs(symPnl) > 0.005) symbols.push({ symbol, pnl: symPnl });
    }
    symbols.sort((a, z) => z.pnl - a.pnl);

    let list = byYear.get(mo.y);
    if (!list) {
      byYear.set(mo.y, (list = MONTH_LABELS.map((_, month) => ({ month }))));
    }
    list[mo.m] = { month: mo.m, portfolio, spy, symbols };
  }

  return { years: [...byYear.keys()].sort((a, b) => a - b), byYear };
}

/** Compound monthly % returns into a full-period % (only months with a value). */
export function compound(values: (number | undefined)[]): number | undefined {
  let acc = 1;
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    acc *= 1 + v / 100;
    any = true;
  }
  return any ? (acc - 1) * 100 : undefined;
}

export interface CumPoint {
  month: number;
  /** Cumulative YTD % return through this month end. */
  portfolio: number;
  spy: number;
  /** This month's return (spy undefined when no price history yet). */
  monthPortfolio: number;
  monthSpy?: number;
  /** This month's per-symbol P&L in dollars, winners first. */
  symbols: SymbolPnl[];
}

/**
 * Compound monthly returns into cumulative YTD series. SPY compounds only
 * over months the portfolio was active (a missing SPY month counts as flat),
 * matching the header totals.
 */
export function cumulative(rows: MonthCompare[]): CumPoint[] {
  const points: CumPoint[] = [];
  let accP = 1;
  let accS = 1;
  for (const r of rows) {
    if (r.portfolio == null) continue;
    accP *= 1 + r.portfolio / 100;
    if (r.spy != null) accS *= 1 + r.spy / 100;
    points.push({
      month: r.month,
      portfolio: (accP - 1) * 100,
      spy: (accS - 1) * 100,
      monthPortfolio: r.portfolio,
      monthSpy: r.spy,
      symbols: r.symbols ?? [],
    });
  }
  return points;
}

/** Gridline positions: multiples of a 1/2/5 step spanning [min, max]. */
export function niceTicks(min: number, max: number): number[] {
  const raw = (max - min) / 4;
  if (!(raw > 0)) return [0];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) {
    const v = Math.round(t * 1e6) / 1e6;
    ticks.push(v === 0 ? 0 : v);
  }
  return ticks;
}
