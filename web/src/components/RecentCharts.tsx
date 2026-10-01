import { useQuery } from "@tanstack/react-query";
import { api, type SymbolMatch } from "../api";
import { MiniAreaChart } from "./MiniAreaChart";
import { fmtNum, fmtPct, pnlColor } from "../utils/format";
import { recentKey } from "../utils/recentCharts";

/**
 * Strip of the most-recently-inspected symbols, newest first, as compact 6-month
 * sparkline thumbnails. Clicking one re-opens it in the main chart above. The
 * thumbnails use a fixed 6M/daily range so they stay stable and cheap regardless
 * of the main chart's selected timeframe.
 */
export function RecentCharts({
  items,
  activeKey,
  onSelect,
}: {
  items: SymbolMatch[];
  activeKey?: string;
  onSelect: (m: SymbolMatch) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
        Recently viewed
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((m) => (
          <RecentCard
            key={recentKey(m)}
            match={m}
            active={recentKey(m) === activeKey}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function RecentCard({
  match,
  active,
  onSelect,
}: {
  match: SymbolMatch;
  active: boolean;
  onSelect: (m: SymbolMatch) => void;
}) {
  const history = useQuery({
    queryKey: ["recentBars", recentKey(match)],
    queryFn: () =>
      api.history({
        symbol: match.symbol,
        conId: match.conId,
        barSize: "1 day",
        duration: "6 M",
      }),
    staleTime: 5 * 60_000,
  });

  const bars = history.data?.bars ?? [];
  const first = bars[0]?.close;
  const last = bars[bars.length - 1]?.close;
  const change = first != null && last != null ? last - first : undefined;
  const changePct = change != null && first ? (change / first) * 100 : undefined;
  const up = (change ?? 0) >= 0;

  return (
    <button
      onClick={() => onSelect(match)}
      title={match.name}
      className={`cursor-pointer rounded-xl border bg-gray-900/40 p-3 text-left transition-colors [&_canvas]:cursor-pointer! ${
        active
          ? "border-emerald-600/70 bg-emerald-950/20"
          : "border-gray-800 hover:border-gray-600"
      }`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-gray-100">{match.symbol}</span>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-gray-200">
            {last != null ? fmtNum(last) : "—"}
          </div>
          <div className={`text-xs font-medium tabular-nums ${pnlColor(change)}`}>
            {fmtPct(changePct)}
          </div>
        </div>
      </div>

      {history.isLoading ? (
        <div className="flex h-[100px] items-center justify-center text-xs text-gray-600">
          Loading…
        </div>
      ) : history.isError ? (
        <div className="flex h-[100px] items-center justify-center px-2 text-center text-xs text-gray-500">
          No data
        </div>
      ) : bars.length < 2 ? (
        <div className="flex h-[100px] items-center justify-center text-xs text-gray-600">
          Not enough data.
        </div>
      ) : (
        <MiniAreaChart bars={bars} up={up} height={100} />
      )}
    </button>
  );
}
