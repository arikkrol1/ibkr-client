import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type SymbolMatch } from "../api";
import { SymbolSearch } from "../components/SymbolSearch";
import { PriceChart } from "../components/PriceChart";
import { RecentCharts } from "../components/RecentCharts";
import { useQuote } from "../hooks/useQuote";
import { fmtMoney, fmtNum, fmtPct, pnlColor } from "../utils/format";
import { loadRecents, pushRecent, recentKey, saveRecents } from "../utils/recentCharts";

const PRESETS = [
  { label: "1D", barSize: "5 mins", duration: "1 D" },
  { label: "1W", barSize: "30 mins", duration: "1 W" },
  { label: "1M", barSize: "1 day", duration: "1 M" },
  { label: "6M", barSize: "1 day", duration: "6 M" },
  { label: "1Y", barSize: "1 day", duration: "1 Y" },
  { label: "5Y", barSize: "1 week", duration: "5 Y" },
  { label: "10Y", barSize: "1 week", duration: "10 Y" },
] as const;

export function ChartPage() {
  // Seed the selection from ?symbol=&conId= so other tabs (e.g. the Holdings
  // magnifier) can deep-link a ticker into the main chart.
  const [searchParams] = useSearchParams();
  const [selected, setSelected] = useState<SymbolMatch | null>(() => {
    const symbol = searchParams.get("symbol") ?? undefined;
    const conId = searchParams.get("conId");
    const currency = searchParams.get("currency") ?? undefined;
    if (!symbol && !conId) return null;
    return { symbol, conId: conId ? Number(conId) : undefined, currency };
  });
  const [presetIdx, setPresetIdx] = useState(3); // 6M
  const preset = PRESETS[presetIdx];

  // Keep the last N inspected symbols, newest first, deduped by identity, and
  // persist them in localStorage so they survive reloads.
  const [recents, setRecents] = useState<SymbolMatch[]>(() => loadRecents());
  useEffect(() => {
    if (!selected?.symbol) return;
    setRecents((prev) => pushRecent(prev, selected));
  }, [selected]);
  useEffect(() => saveRecents(recents), [recents]);

  const symbol = selected?.symbol ?? null;
  const quote = useQuote(symbol);

  const history = useQuery({
    queryKey: ["history", selected?.conId, symbol, preset.label],
    queryFn: () =>
      api.history({
        symbol: symbol ?? undefined,
        conId: selected?.conId,
        barSize: preset.barSize,
        duration: preset.duration,
      }),
    enabled: Boolean(symbol),
  });

  const prevClose = quote?.close;
  const last = quote?.last ?? prevClose;
  const change = last != null && prevClose != null ? last - prevClose : undefined;
  const changePct =
    change != null && prevClose ? (change / prevClose) * 100 : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SymbolSearch onSelect={setSelected} />

      {!symbol && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-10 text-center text-gray-500">
          Search for a ticker to view its chart.
        </div>
      )}

      {symbol && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          {/* Quote header */}
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-semibold">{selected?.symbol}</h2>
                {quote?.delayed && (
                  <span className="rounded bg-amber-900/60 px-2 py-0.5 text-xs font-semibold text-amber-300">
                    DELAYED
                  </span>
                )}
                <span className="text-sm text-gray-500">{selected?.name}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="text-3xl font-bold tabular-nums">
                  {last != null ? fmtMoney(last, selected?.currency) : "—"}
                </span>
                <span className={`text-sm font-medium tabular-nums ${pnlColor(change)}`}>
                  {change != null ? `${change > 0 ? "+" : ""}${fmtNum(change)}` : ""}{" "}
                  {changePct != null ? `(${fmtPct(changePct)})` : ""}
                </span>
              </div>
              <div className="mt-1 flex gap-4 text-xs text-gray-500">
                <span>Bid {fmtNum(quote?.bid)}</span>
                <span>Ask {fmtNum(quote?.ask)}</span>
                <span>H {fmtNum(quote?.high)}</span>
                <span>L {fmtNum(quote?.low)}</span>
              </div>
            </div>

            {/* Timeframe presets */}
            <div className="flex gap-1">
              {PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  onClick={() => setPresetIdx(i)}
                  className={`rounded-md px-3 py-1 text-sm font-medium ${
                    i === presetIdx
                      ? "bg-emerald-600 text-white"
                      : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Chart */}
          {history.isLoading && (
            <div className="flex h-[520px] items-center justify-center text-gray-500">
              Loading bars…
            </div>
          )}
          {history.isError && (
            <div className="flex h-[520px] items-center justify-center text-red-400">
              {(history.error as Error).message}
            </div>
          )}
          {history.data && history.data.bars.length === 0 && (
            <div className="flex h-[520px] items-center justify-center text-gray-500">
              No data for this range.
            </div>
          )}
          {history.data && history.data.bars.length > 0 && (
            <PriceChart bars={history.data.bars} />
          )}
        </div>
      )}

      <RecentCharts
        items={recents}
        activeKey={selected ? recentKey(selected) : undefined}
        onSelect={setSelected}
      />
    </div>
  );
}
