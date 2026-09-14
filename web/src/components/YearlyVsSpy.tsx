import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type HistoryBar, type PnlSeries } from "../api";
import { fmtPct, pnlColor } from "../utils/format";
import { PALETTE } from "../utils/palette";

// Widest span the /api/pnl endpoint accepts (5 years).
const HISTORY_DAYS = 1825;
const SPY_DURATION = "5 Y";

const PORTFOLIO_COLOR = PALETTE[0]; // blue
const SPY_COLOR = PALETTE[2]; // yellow

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface MonthCompare {
  month: number;
  portfolio?: number;
  spy?: number;
}

interface YearsVsSpy {
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
function compareByMonth(series: PnlSeries[], bars: HistoryBar[]): YearsVsSpy | null {
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

  // Portfolio cumulative P&L and gross market value at each month end.
  const cum = new Array<number>(months.length).fill(0);
  const mvAbs = new Array<number>(months.length).fill(0);
  for (const s of series) {
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

    let list = byYear.get(mo.y);
    if (!list) {
      byYear.set(mo.y, (list = MONTH_LABELS.map((_, month) => ({ month }))));
    }
    list[mo.m] = { month: mo.m, portfolio, spy };
  }

  return { years: [...byYear.keys()].sort((a, b) => a - b), byYear };
}

/** Compound monthly % returns into a full-period % (only months with a value). */
function compound(values: (number | undefined)[]): number | undefined {
  let acc = 1;
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    acc *= 1 + v / 100;
    any = true;
  }
  return any ? (acc - 1) * 100 : undefined;
}

/** Monthly % return of the whole account vs SPY for a selectable year. */
export function YearlyVsSpy() {
  const pnlQuery = useQuery({
    queryKey: ["pnl", HISTORY_DAYS],
    queryFn: () => api.pnl(HISTORY_DAYS),
    refetchInterval: 60_000,
  });
  const spyQuery = useQuery({
    queryKey: ["dailyBars", "SPY", SPY_DURATION],
    queryFn: () => api.history({ symbol: "SPY", barSize: "1 day", duration: SPY_DURATION }),
    staleTime: 5 * 60_000,
  });

  const compared = useMemo(
    () =>
      pnlQuery.data && spyQuery.data
        ? compareByMonth(pnlQuery.data.series, spyQuery.data.bars)
        : null,
    [pnlQuery.data, spyQuery.data],
  );

  const [picked, setPicked] = useState<number | null>(null);
  const years = compared?.years ?? [];
  const year =
    picked != null && years.includes(picked) ? picked : years[years.length - 1];

  const rows = (year != null && compared?.byYear.get(year)) || [];
  const yearPortfolio = compound(rows.map((r) => r.portfolio));
  // Compound SPY only over the months the portfolio was active, so a mid-year
  // account start compares like-for-like.
  const yearSpy = compound(rows.map((r) => (r.portfolio != null ? r.spy : undefined)));

  // Diverging vertical bars share one scale: the plot spans maxPos above the
  // zero baseline and maxNeg below it.
  let maxPos = 0;
  let maxNeg = 0;
  for (const r of rows) {
    for (const v of [r.portfolio, r.spy]) {
      if (v == null) continue;
      maxPos = Math.max(maxPos, v);
      maxNeg = Math.max(maxNeg, -v);
    }
  }
  const span = maxPos + maxNeg;
  const posFrac = span > 0 ? maxPos / span : 1;

  const isLoading = pnlQuery.isLoading || spyQuery.isLoading;
  const queryError = pnlQuery.error ?? spyQuery.error;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="text-sm font-semibold text-gray-300">Yearly vs SPY</h2>
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: PORTFOLIO_COLOR }}
            />
            Portfolio
            <span className={`tabular-nums ${pnlColor(yearPortfolio)}`}>
              {fmtPct(yearPortfolio)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: SPY_COLOR }}
            />
            SPY
            <span className={`tabular-nums ${pnlColor(yearSpy)}`}>{fmtPct(yearSpy)}</span>
          </span>
        </div>
        {years.length > 0 && (
          <div className="flex gap-1">
            {years.map((yr) => (
              <button
                key={yr}
                onClick={() => setPicked(yr)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  yr === year
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                }`}
              >
                {yr}
              </button>
            ))}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-sm text-gray-500">Computing monthly returns…</p>
      ) : queryError ? (
        <p className="text-sm text-gray-500">
          Comparison unavailable: {(queryError as Error).message}
        </p>
      ) : !compared || rows.length === 0 ? (
        <p className="text-sm text-gray-500">No trade history yet.</p>
      ) : (
        <div className="relative mt-6">
          {/* Zero baseline across the whole plot. */}
          <div
            className="absolute inset-x-0 z-0 h-px bg-gray-700"
            style={{ top: `calc(${posFrac} * 11rem)` }}
          />
          <div className="flex items-start gap-1.5">
            {rows.map((r) => (
              <div key={r.month} className="group relative min-w-0 flex-1">
                <div className="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  <span className="font-medium text-gray-100">
                    {MONTH_LABELS[r.month]} {year}
                  </span>{" "}
                  <span className="text-gray-400">Portfolio</span>{" "}
                  <span className={`tabular-nums ${pnlColor(r.portfolio)}`}>
                    {fmtPct(r.portfolio)}
                  </span>{" "}
                  <span className="text-gray-400">SPY</span>{" "}
                  <span className={`tabular-nums ${pnlColor(r.spy)}`}>{fmtPct(r.spy)}</span>
                </div>
                <div className="relative h-44">
                  {[
                    { value: r.portfolio, color: PORTFOLIO_COLOR, left: "35%" },
                    { value: r.spy, color: SPY_COLOR, left: "65%" },
                  ].map(({ value, color, left }) =>
                    value == null ? null : (
                      <div
                        key={left}
                        className={`absolute -translate-x-1/2 ${
                          value >= 0 ? "rounded-t" : "rounded-b"
                        } opacity-80 transition-opacity group-hover:opacity-100`}
                        style={{
                          left,
                          width: "min(0.75rem, 40%)",
                          minHeight: 2,
                          height: `${span > 0 ? (Math.abs(value) / span) * 100 : 0}%`,
                          background: color,
                          ...(value >= 0
                            ? { bottom: `${(1 - posFrac) * 100}%` }
                            : { top: `${posFrac * 100}%` }),
                        }}
                      />
                    ),
                  )}
                </div>
                <div className="mt-1 truncate text-center text-[10px] text-gray-400">
                  {MONTH_LABELS[r.month]}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
