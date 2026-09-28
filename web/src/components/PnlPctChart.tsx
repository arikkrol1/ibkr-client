import { useMemo, useState } from "react";
import type { PnlSeries } from "../api";
import { fmtMoney, fmtPct, pnlColor } from "../utils/format";
import { rowsFor } from "../utils/pctRows";

interface Timeframe {
  key: string;
  label: string;
  start: (now: Date) => Date;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const TIMEFRAMES: Timeframe[] = [
  { key: "year", label: "Year", start: (n) => new Date(n.getFullYear() - 1, n.getMonth(), n.getDate()) },
  { key: "quarter", label: "3M", start: (n) => new Date(n.getFullYear(), n.getMonth() - 3, n.getDate()) },
  { key: "month", label: "Month", start: (n) => new Date(n.getFullYear(), n.getMonth() - 1, n.getDate()) },
  { key: "week", label: "Week", start: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7) },
  { key: "day", label: "Day", start: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1) },
  { key: "ytd", label: "YTD", start: (n) => new Date(n.getFullYear(), 0, 1) },
  { key: "mtd", label: "MTD", start: (n) => new Date(n.getFullYear(), n.getMonth(), 1) },
  {
    key: "wtd",
    label: "WTD",
    start: (n) => {
      const d = startOfDay(n);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
      return d;
    },
  },
];

/** Horizontal gain/loss bars: % P&L per symbol over a selectable timeframe. */
export function PnlPctChart({
  series,
  colorFor,
}: {
  series: PnlSeries[];
  colorFor: (key: string) => string;
}) {
  const [tfKey, setTfKey] = useState("month");
  const tf = TIMEFRAMES.find((t) => t.key === tfKey) ?? TIMEFRAMES[1];

  const rows = useMemo(
    () => rowsFor(series, tf.start(new Date()).getTime() / 1000),
    [series, tf],
  );
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pct ?? 0)), 0);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-300">P&L % by symbol</h2>
        <div className="flex gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTfKey(t.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                t.key === tfKey
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">
          No P&L activity in this timeframe.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const frac = r.pct != null && maxAbs > 0 ? Math.abs(r.pct) / maxAbs : 0;
            return (
              <div key={r.key} className="flex items-center gap-3">
                <span className="flex w-20 shrink-0 items-center gap-2 text-sm font-medium text-gray-100">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: colorFor(r.key) }}
                  />
                  {r.symbol}
                </span>
                <div className="relative h-5 flex-1">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-gray-700" />
                  {r.pct != null && frac > 0 && (
                    <div
                      className={`absolute top-1/2 h-3.5 -translate-y-1/2 ${
                        r.pct >= 0
                          ? "rounded-r bg-emerald-500/80"
                          : "rounded-l bg-red-500/80"
                      }`}
                      style={
                        r.pct >= 0
                          ? { left: "50%", width: `${frac * 50}%` }
                          : { right: "50%", width: `${frac * 50}%` }
                      }
                    />
                  )}
                </div>
                <div className="w-28 shrink-0 text-right leading-tight">
                  <span className={`text-sm tabular-nums ${pnlColor(r.pct)}`}>
                    {fmtPct(r.pct)}
                  </span>
                  <span className="block text-xs tabular-nums text-gray-500">
                    {fmtMoney(r.periodPnl, r.currency)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
