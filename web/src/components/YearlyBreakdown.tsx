import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtMoney, pnlColor } from "../utils/format";
import { aggregateByYear } from "../utils/yearlyPnl";

// Widest span the /api/pnl endpoint accepts (5 years).
const HISTORY_DAYS = 1825;

export function YearlyBreakdown() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pnl", HISTORY_DAYS],
    queryFn: () => api.pnl(HISTORY_DAYS),
    refetchInterval: 60_000,
  });

  const yearly = useMemo(() => (data ? aggregateByYear(data.series) : null), [data]);

  const [picked, setPicked] = useState<number | null>(null);
  const years = yearly?.years ?? [];
  const year =
    picked != null && years.includes(picked) ? picked : years[years.length - 1];

  const rows = (year != null && yearly?.rows.get(year)) || [];
  const total = year != null ? (yearly?.totals.get(year) ?? 0) : 0;

  // Diverging vertical bars share one scale: the plot spans maxPos above the
  // zero baseline and maxNeg below it.
  const maxPos = rows.reduce((m, r) => Math.max(m, r.pnl), 0);
  const maxNeg = rows.reduce((m, r) => Math.max(m, -r.pnl), 0);
  const span = maxPos + maxNeg;
  const posFrac = span > 0 ? maxPos / span : 1;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-300">Yearly Breakdown</h2>
        {yearly && (
          <div className="flex flex-wrap items-center gap-3">
            <span className={`text-sm font-semibold tabular-nums ${pnlColor(total)}`}>
              {fmtMoney(total)}
            </span>
            <div className="flex gap-1">
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setPicked(y)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    y === year
                      ? "bg-gray-800 text-white"
                      : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-sm text-gray-500">Computing P&L history…</p>
      ) : isError ? (
        <p className="text-sm text-gray-500">
          P&L history unavailable: {(error as Error).message}
        </p>
      ) : !yearly || rows.length === 0 ? (
        <p className="text-sm text-gray-500">No trade history yet.</p>
      ) : (
        <div className="relative mt-6">
          {/* Zero baseline across the whole plot. */}
          <div
            className="absolute inset-x-0 z-0 h-px bg-gray-700"
            style={{ top: `calc(${posFrac} * 11rem)` }}
          />
          <div className="flex items-start gap-1.5">
            {rows.map((r) => {
              const up = r.pnl >= 0;
              const frac = span > 0 ? Math.abs(r.pnl) / span : 0;
              return (
                <div key={r.key} tabIndex={0} className="group relative min-w-0 flex-1 outline-none">
                  <div className="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100">
                    <span className="font-medium text-gray-100">{r.symbol}</span>{" "}
                    <span className={`tabular-nums ${pnlColor(r.pnl)}`}>
                      {fmtMoney(r.pnl)}
                    </span>
                  </div>
                  <div className="relative h-44">
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 ${
                        up
                          ? "rounded-t bg-emerald-500/80 group-hover:bg-emerald-400 group-focus:bg-emerald-400"
                          : "rounded-b bg-red-500/80 group-hover:bg-red-400 group-focus:bg-red-400"
                      }`}
                      style={{
                        width: "min(1.25rem, 75%)",
                        minHeight: 2,
                        height: `${frac * 100}%`,
                        ...(up
                          ? { bottom: `${(1 - posFrac) * 100}%` }
                          : { top: `${posFrac * 100}%` }),
                      }}
                    />
                  </div>
                  <div className="mt-1 truncate text-center text-[10px] text-gray-400">
                    {r.symbol}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
