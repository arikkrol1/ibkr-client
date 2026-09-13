import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type SymbolMatch } from "../api";
import { CompareChart, type CompareMode } from "../components/CompareChart";
import { SymbolSearch } from "../components/SymbolSearch";
import { fmtPct, pnlColor } from "../utils/format";
import { PALETTE, OVERFLOW_COLOR } from "../utils/palette";

interface Timeframe {
  key: string;
  label: string;
  start: (now: Date) => Date;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const TIMEFRAMES: Timeframe[] = [
  { key: "week", label: "Week", start: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7) },
  { key: "month", label: "Month", start: (n) => new Date(n.getFullYear(), n.getMonth() - 1, n.getDate()) },
  { key: "year", label: "Year", start: (n) => new Date(n.getFullYear() - 1, n.getMonth(), n.getDate()) },
  {
    key: "wtd",
    label: "WTD",
    start: (n) => {
      const d = startOfDay(n);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
      return d;
    },
  },
  { key: "mtd", label: "MTD", start: (n) => new Date(n.getFullYear(), n.getMonth(), 1) },
  { key: "ytd", label: "YTD", start: (n) => new Date(n.getFullYear(), 0, 1) },
];

const MODES: { key: CompareMode; label: string }[] = [
  { key: "pct", label: "% Change" },
  { key: "price", label: "Price" },
];

interface CompareEntry {
  key: string;
  symbol: string;
  conId?: number;
  name?: string;
  /** Palette slot assigned when the symbol is added; stable across removals. */
  slot: number;
}

const DEFAULT_ENTRIES: CompareEntry[] = [{ key: "SPY", symbol: "SPY", slot: 0 }];

/**
 * Overlay chart comparing multiple symbols over a shared timeframe. Fetches
 * one year of daily bars per symbol and slices client-side, so switching
 * timeframes needs no extra requests. Defaults to % change (rebased to the
 * window start) with a toggle to raw prices.
 */
export function ComparePage() {
  const [entries, setEntries] = useState<CompareEntry[]>(DEFAULT_ENTRIES);
  const [tfKey, setTfKey] = useState("month");
  const [mode, setMode] = useState<CompareMode>("pct");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const tf = TIMEFRAMES.find((t) => t.key === tfKey) ?? TIMEFRAMES[1];
  const startSec = useMemo(() => Math.floor(tf.start(new Date()).getTime() / 1000), [tf]);

  const portfolio = useQuery({
    queryKey: ["portfolio"],
    queryFn: api.portfolio,
    staleTime: 60_000,
  });
  const holdings = (portfolio.data?.positions ?? []).filter((p) => p.symbol);

  const results = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["dailyBars", e.conId ?? e.symbol],
      queryFn: () =>
        api.history({ symbol: e.symbol, conId: e.conId, barSize: "1 day", duration: "1 Y" }),
      staleTime: 5 * 60_000,
    })),
  });

  const addSymbol = (m: SymbolMatch) => {
    if (!m.symbol && !m.conId) return;
    const key = m.conId ? `c${m.conId}` : m.symbol!;
    setEntries((prev) => {
      if (prev.some((e) => e.key === key || (m.symbol && e.symbol === m.symbol))) return prev;
      const used = new Set(prev.map((e) => e.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      return [...prev, { key, symbol: m.symbol ?? `#${m.conId}`, conId: m.conId, name: m.name, slot }];
    });
  };

  const removeSymbol = (key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
    setHidden((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const colorMap = useMemo(
    () => new Map(entries.map((e) => [e.key, PALETTE[e.slot] ?? OVERFLOW_COLOR])),
    [entries],
  );
  const colorFor = (key: string) => colorMap.get(key) ?? OVERFLOW_COLOR;

  // Per-symbol window slice: include the close before the window start so the
  // line (and the % rebase) is measured against the prior close.
  const rows = useMemo(
    () =>
      entries.map((e, i) => {
        const r = results[i];
        const bars = r?.data?.bars ?? [];
        let idx = bars.findIndex((b) => b.time >= startSec);
        if (idx === -1) idx = bars.length;
        const windowBars = bars.slice(Math.max(0, idx - 1));
        const base = windowBars[0]?.close;
        const points = windowBars.map((b) => ({
          time: b.time,
          value:
            mode === "pct" && base
              ? ((b.close - base) / Math.abs(base)) * 100
              : b.close,
        }));
        const last = windowBars[windowBars.length - 1]?.close;
        const pct =
          base != null && last != null && base !== 0
            ? ((last - base) / Math.abs(base)) * 100
            : undefined;
        return {
          entry: e,
          points,
          pct,
          isLoading: r?.isLoading ?? false,
          error: r?.isError ? ((r.error as Error)?.message ?? "Failed to load") : null,
        };
      }),
    [entries, results, startSec, mode],
  );

  const series = rows
    .filter((r) => r.points.length >= 2)
    .map((r) => ({ key: r.entry.key, symbol: r.entry.symbol, points: r.points }));
  const failed = rows.filter((r) => r.error);
  const loading = rows.some((r) => r.isLoading);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Compare</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-gray-800 p-0.5">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  m.key === mode
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
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
      </div>

      <SymbolSearch onSelect={addSymbol} />

      {holdings.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500">Holdings:</span>
          {holdings.map((p) => {
            const added = entries.some(
              (e) => (p.conId && e.conId === p.conId) || e.symbol === p.symbol,
            );
            return (
              <button
                key={p.conId ?? p.symbol}
                onClick={() => addSymbol({ symbol: p.symbol, conId: p.conId })}
                disabled={added}
                title={added ? "Already on the chart" : "Add to chart"}
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  added
                    ? "cursor-default border-gray-800 text-gray-600"
                    : "border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white"
                }`}
              >
                {p.symbol}
              </button>
            );
          })}
          <button
            onClick={() => holdings.forEach((p) => addSymbol({ symbol: p.symbol, conId: p.conId }))}
            className="rounded-md px-2 py-0.5 text-xs font-medium text-gray-400 hover:bg-gray-900 hover:text-gray-200"
          >
            Add all
          </button>
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
        {/* Legend: click a chip to toggle the series, × to remove it */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {rows.map(({ entry, pct, isLoading, error }) => {
            const off = hidden.has(entry.key);
            return (
              <span
                key={entry.key}
                title={error ?? entry.name}
                className={`flex items-center rounded-full border text-xs transition-colors ${
                  error
                    ? "border-red-900 text-red-400"
                    : off
                      ? "border-gray-800 text-gray-600"
                      : "border-gray-700 text-gray-200 hover:border-gray-500"
                }`}
              >
                <button
                  onClick={() => toggle(entry.key)}
                  title={off ? "Show series" : "Hide series"}
                  className="flex items-center gap-1.5 py-1 pl-2.5"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: off ? "#4b5563" : colorFor(entry.key) }}
                  />
                  <span className="font-medium">{entry.symbol}</span>
                  {isLoading ? (
                    <span className="text-gray-500">…</span>
                  ) : error ? (
                    <span>failed</span>
                  ) : (
                    <span className={`tabular-nums ${off ? "" : pnlColor(pct)}`}>
                      {fmtPct(pct)}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => removeSymbol(entry.key)}
                  title="Remove symbol"
                  className="px-1.5 py-1 text-gray-500 hover:text-gray-200"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>

        {entries.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-500">
            Search for a ticker above to add it to the chart.
          </p>
        ) : series.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-500">
            {loading
              ? "Loading price history…"
              : "No price history available for this timeframe."}
          </p>
        ) : (
          <CompareChart series={series} mode={mode} hidden={hidden} colorFor={colorFor} />
        )}
      </div>

      {failed.length > 0 && (
        <p className="text-xs text-gray-600">
          No price history for {failed.map((r) => r.entry.symbol).join(", ")} —{" "}
          {failed[0].error}
        </p>
      )}
    </div>
  );
}
