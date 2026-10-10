import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtMoney, fmtPct, pnlColor } from "../utils/format";
import { PALETTE } from "../utils/palette";
import {
  MONTH_LABELS,
  compareByMonth,
  compound,
  cumulative,
  niceTicks,
  type CumPoint,
} from "../utils/vsSpy";

// Widest span the /api/pnl endpoint accepts (5 years).
const HISTORY_DAYS = 1825;
const SPY_DURATION = "5 Y";

const PORTFOLIO_COLOR = PALETTE[0]; // blue
const SPY_COLOR = PALETTE[2]; // yellow

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

  const points = cumulative(rows);

  // Both lines share one y-scale that always includes the zero baseline.
  let minV = 0;
  let maxV = 0;
  for (const p of points) {
    minV = Math.min(minV, p.portfolio, p.spy);
    maxV = Math.max(maxV, p.portfolio, p.spy);
  }
  if (maxV - minV < 1e-6) {
    minV -= 1;
    maxV += 1;
  }
  const pad = (maxV - minV) * 0.08;
  const lo = minV - pad;
  const hi = maxV + pad;
  const ticks = niceTicks(lo, hi);
  const yPct = (v: number) => ((hi - v) / (hi - lo)) * 100;
  const xPct = (month: number) => ((month + 0.5) / 12) * 100;

  // Each line starts at 0% on the left edge of the first active month.
  const linePoints = (pick: (p: CumPoint) => number) =>
    points.length === 0
      ? ""
      : [
          `${(points[0].month / 12) * 100},${yPct(0)}`,
          ...points.map((p) => `${xPct(p.month)},${yPct(pick(p))}`),
        ].join(" ");

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
          <div className="relative h-44">
            {/* Horizontal gridlines with % labels; zero baseline emphasized. */}
            {ticks.map((t) => (
              <div key={t}>
                <div
                  className={`absolute inset-x-0 h-px ${
                    t === 0 ? "bg-gray-700" : "bg-gray-800/70"
                  }`}
                  style={{ top: `${yPct(t)}%` }}
                />
                <span
                  className="absolute left-0 -translate-y-full pb-0.5 text-[10px] tabular-nums text-gray-500"
                  style={{ top: `${yPct(t)}%` }}
                >
                  {t > 0 ? `+${t}%` : `${t}%`}
                </span>
              </div>
            ))}
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              {[
                { pts: linePoints((p) => p.spy), color: SPY_COLOR },
                { pts: linePoints((p) => p.portfolio), color: PORTFOLIO_COLOR },
              ].map(({ pts, color }) => (
                <polyline
                  key={color}
                  points={pts}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {/* Hover layer: one hit column per month with crosshair + markers (tap focuses it on touch). */}
            <div className="absolute inset-0 flex">
              {rows.map((r) => {
                const p = points.find((c) => c.month === r.month);
                return (
                  <div key={r.month} tabIndex={0} className="group relative min-w-0 flex-1 outline-none">
                    {p && (
                      <>
                        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-700 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
                        {[
                          { value: p.spy, color: SPY_COLOR },
                          { value: p.portfolio, color: PORTFOLIO_COLOR },
                        ].map(({ value, color }) => (
                          <div
                            key={color}
                            className="absolute left-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
                            style={{
                              top: `${yPct(value)}%`,
                              background: color,
                              boxShadow: "0 0 0 2px #0b0e11",
                            }}
                          />
                        ))}
                        <div
                          className={`pointer-events-none absolute -top-1.5 z-20 -translate-y-full whitespace-nowrap rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100 ${
                            r.month < 2
                              ? "left-0"
                              : r.month > 9
                                ? "right-0"
                                : "left-1/2 -translate-x-1/2"
                          }`}
                        >
                          <div className="font-medium text-gray-100">
                            {MONTH_LABELS[p.month]} {year}
                          </div>
                          {[
                            {
                              name: "Portfolio",
                              color: PORTFOLIO_COLOR,
                              ytd: p.portfolio,
                              mo: p.monthPortfolio,
                            },
                            { name: "SPY", color: SPY_COLOR, ytd: p.spy, mo: p.monthSpy },
                          ].map((s) => (
                            <div key={s.name} className="mt-0.5 flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ background: s.color }}
                              />
                              <span className="text-gray-400">{s.name}</span>
                              <span className={`tabular-nums ${pnlColor(s.ytd)}`}>
                                {fmtPct(s.ytd)} <span className="text-gray-500">ysf</span>
                              </span>
                              <span className="tabular-nums text-gray-500">
                                ({fmtPct(s.mo)} mo)
                              </span>
                            </div>
                          ))}
                          {p.symbols.length > 0 && (
                            <div
                              className="mt-1.5 grid gap-x-4 gap-y-0.5 border-t border-gray-800 pt-1.5"
                              style={{
                                gridAutoFlow: "column",
                                gridTemplateRows: `repeat(${Math.min(6, p.symbols.length)}, auto)`,
                              }}
                            >
                              {p.symbols.map((s) => (
                                <div
                                  key={s.symbol}
                                  className="flex items-center justify-between gap-3"
                                >
                                  <span className="text-gray-400">{s.symbol}</span>
                                  <span className={`tabular-nums ${pnlColor(s.pnl)}`}>
                                    {fmtMoney(s.pnl)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1 flex">
            {rows.map((r) => (
              <div
                key={r.month}
                className="min-w-0 flex-1 truncate text-center text-[10px] text-gray-400"
              >
                {MONTH_LABELS[r.month]}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
