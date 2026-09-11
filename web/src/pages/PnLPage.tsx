import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PnlSeries } from "../api";
import { PnlChart } from "../components/PnlChart";
import { fmtMoney, pnlColor } from "../utils/format";

const RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1825 },
] as const;

/**
 * Categorical palette (validated for CVD separation + contrast on #0b0e11).
 * Slots are assigned to symbols in fixed alphabetical order, never cycled;
 * symbols beyond the 8 slots fall back to a muted slate and rely on the
 * legend + tooltip for identity.
 */
const PALETTE = [
  "#3987e5", // blue
  "#199e70", // aqua
  "#c98500", // yellow
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
  "#d55181", // magenta
  "#d95926", // orange
];
const OVERFLOW_COLOR = "#64748b";

export function PnLPage() {
  const [days, setDays] = useState<number>(90);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pnl", days],
    queryFn: () => api.pnl(days),
    refetchInterval: 60_000,
  });

  // Stable color per series key (server returns series alphabetically).
  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    data?.series.forEach((s, i) => map.set(s.key, PALETTE[i] ?? OVERFLOW_COLOR));
    return map;
  }, [data]);
  const colorFor = (key: string) => colorMap.get(key) ?? OVERFLOW_COLOR;

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (isLoading) return <Centered>Computing P&L history…</Centered>;
  if (isError) return <Centered tone="error">{(error as Error).message}</Centered>;
  if (!data) return null;

  const visibleTotal = data.series
    .filter((s) => !hidden.has(s.key))
    .reduce((sum, s) => sum + s.total, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">P&L</h1>
          <span className={`text-lg font-semibold tabular-nums ${pnlColor(visibleTotal)}`}>
            {fmtMoney(visibleTotal)}
          </span>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setDays(r.days)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                days === r.days
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {data.source === "approx" && (
        <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200/90">
          Approximated from current positions × historical prices — closed (past)
          positions aren't included, and position-size changes within the range are
          ignored. For exact history including past symbols, set{" "}
          <code className="rounded bg-black/30 px-1">IB_FLEX_TOKEN</code> and{" "}
          <code className="rounded bg-black/30 px-1">IB_FLEX_QUERY_ID</code> on the
          server (IBKR Account Management → Reports → Flex Queries).
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
        {data.series.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-500">
            No positions or trade history found for this range.
          </p>
        ) : (
          <>
            {/* Legend: click a chip to toggle the series */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {data.series.map((s) => {
                const off = hidden.has(s.key);
                return (
                  <button
                    key={s.key}
                    onClick={() => toggle(s.key)}
                    title={off ? "Show series" : "Hide series"}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      off
                        ? "border-gray-800 text-gray-600"
                        : "border-gray-700 text-gray-200 hover:border-gray-500"
                    }`}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: off ? "#4b5563" : colorFor(s.key) }}
                    />
                    <span className="font-medium">{s.symbol}</span>
                    {s.closed && <span className="text-gray-500">closed</span>}
                    <span className={`tabular-nums ${off ? "" : pnlColor(s.total)}`}>
                      {fmtMoney(s.total)}
                    </span>
                  </button>
                );
              })}
            </div>
            <PnlChart series={data.series} hidden={hidden} colorFor={colorFor} />
          </>
        )}
      </div>

      {data.series.length > 0 && <BreakdownTable series={data.series} colorFor={colorFor} />}

      {data.errors.length > 0 && (
        <p className="text-xs text-gray-600">
          No price history for {data.errors.map((e) => e.symbol).join(", ")} — realized
          P&L shown flat for those symbols.
        </p>
      )}
    </div>
  );
}

function BreakdownTable({
  series,
  colorFor,
}: {
  series: PnlSeries[];
  colorFor: (key: string) => string;
}) {
  const rows = [...series].sort((a, b) => b.total - a.total);
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-300">Per-symbol breakdown</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase text-gray-500">
              <th className="py-2 pr-3">Symbol</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3 text-right">Realized P&L</th>
              <th className="py-2 pr-3 text-right">Unrealized P&L</th>
              <th className="py-2 pr-3 text-right">Total P&L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.key} className="border-b border-gray-900 hover:bg-gray-900/60">
                <td className="py-2 pr-3 font-medium text-gray-100">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: colorFor(s.key) }}
                    />
                    {s.symbol}
                  </span>
                </td>
                <td className="py-2 pr-3 text-gray-400">{s.closed ? "Closed" : "Open"}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${pnlColor(s.realized)}`}>
                  {fmtMoney(s.realized, s.currency)}
                </td>
                <td className={`py-2 pr-3 text-right tabular-nums ${pnlColor(s.unrealized)}`}>
                  {fmtMoney(s.unrealized, s.currency)}
                </td>
                <td className={`py-2 pr-3 text-right tabular-nums ${pnlColor(s.total)}`}>
                  {fmtMoney(s.total, s.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={`mx-auto mt-10 max-w-md rounded-xl border p-8 text-center ${
        tone === "error"
          ? "border-red-800 bg-red-950/40 text-red-300"
          : "border-gray-800 bg-gray-900/40 text-gray-400"
      }`}
    >
      {children}
    </div>
  );
}
