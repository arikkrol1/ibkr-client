import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PnlSeries } from "../api";
import { PnlChart } from "../components/PnlChart";
import { PnlPctChart } from "../components/PnlPctChart";
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const refreshTrades = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await api.pnlRefresh();
      await queryClient.invalidateQueries({ queryKey: ["pnl"] });
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  // Always fetch ≥370 days so the %-by-timeframe panel (trailing year / YTD)
  // has data regardless of the line chart's selected range; the line chart
  // slices client-side, which also makes range switching instant.
  const fetchDays = Math.max(days, 370);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pnl", fetchDays],
    queryFn: () => api.pnl(fetchDays),
    refetchInterval: 60_000,
  });

  // Stable color per series key (server returns series alphabetically).
  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    data?.series.forEach((s, i) => map.set(s.key, PALETTE[i] ?? OVERFLOW_COLOR));
    return map;
  }, [data]);
  const colorFor = (key: string) => colorMap.get(key) ?? OVERFLOW_COLOR;

  // Line-chart view of the selected range.
  const chartSeries = useMemo(() => {
    if (!data) return [];
    const cutoff = Date.now() / 1000 - days * 86_400;
    return data.series.map((s) => ({
      ...s,
      points: s.points.filter((p) => p.time >= cutoff),
    }));
  }, [data, days]);

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
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-gray-500">
            {data.tradesAsOf
              ? `Trades as of ${new Date(data.tradesAsOf).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "No trade data yet"}
          </span>
          <button
            onClick={refreshTrades}
            disabled={refreshing}
            className="rounded-md border border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
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
      </div>

      {refreshError && (
        <p className="text-xs text-red-400">Refresh failed: {refreshError}</p>
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
            <PnlChart series={chartSeries} hidden={hidden} colorFor={colorFor} />
          </>
        )}
      </div>

      {data.series.length > 0 && <PnlPctChart series={data.series} colorFor={colorFor} />}

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
