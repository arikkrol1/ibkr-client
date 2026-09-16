import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { MiniAreaChart } from "../components/MiniAreaChart";
import { fmtMoney, fmtPct, pnlColor } from "../utils/format";

const RANGES = [
  { label: "1D", barSize: "5 mins", duration: "1 D" },
  { label: "1W", barSize: "30 mins", duration: "1 W" },
  { label: "1M", barSize: "1 day", duration: "1 M" },
  { label: "3M", barSize: "1 day", duration: "3 M" },
  { label: "6M", barSize: "1 day", duration: "6 M" },
  { label: "1Y", barSize: "1 day", duration: "1 Y" },
] as const;

type Range = (typeof RANGES)[number];

interface Instrument {
  symbol: string;
  name: string;
}

const INDEXES: Instrument[] = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "Nasdaq 100" },
  { symbol: "DIA", name: "Dow Jones" },
  { symbol: "IWM", name: "Russell 2000" },
];

const SECTORS: Instrument[] = [
  { symbol: "SMH", name: "Semiconductors" },
  { symbol: "ITA", name: "Aerospace & Defense" },
  { symbol: "ARKX", name: "Space Exploration" },
  { symbol: "QTUM", name: "Quantum Computing" },
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XBI", name: "Biotech" },
];

export function SectorsPage() {
  const [rangeIdx, setRangeIdx] = useState(4); // 6M
  const range = RANGES[rangeIdx];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          ETF proxies, daily closes over the selected range.
        </p>
        <div className="flex gap-1">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
              className={`rounded-md px-3 py-1 text-sm font-medium ${
                i === rangeIdx
                  ? "bg-emerald-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <Section title="Indexes" instruments={INDEXES} range={range} />
      <Section title="Sectors" instruments={SECTORS} range={range} />
    </div>
  );
}

function Section({
  title,
  instruments,
  range,
}: {
  title: string;
  instruments: Instrument[];
  range: Range;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {instruments.map((inst) => (
          <SectorCard key={inst.symbol} instrument={inst} range={range} />
        ))}
      </div>
    </section>
  );
}

function SectorCard({
  instrument,
  range,
}: {
  instrument: Instrument;
  range: Range;
}) {
  const history = useQuery({
    queryKey: ["sector-history", instrument.symbol, range.label],
    queryFn: () =>
      api.history({
        symbol: instrument.symbol,
        barSize: range.barSize,
        duration: range.duration,
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
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold">{instrument.symbol}</span>{" "}
          <span className="truncate text-xs text-gray-500">{instrument.name}</span>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {last != null ? fmtMoney(last) : "—"}
          </div>
          <div className={`text-xs font-medium tabular-nums ${pnlColor(change)}`}>
            {fmtPct(changePct)}
          </div>
        </div>
      </div>

      {history.isLoading && (
        <div className="flex h-[140px] items-center justify-center text-xs text-gray-600">
          Loading…
        </div>
      )}
      {history.isError && (
        <div className="flex h-[140px] items-center justify-center px-2 text-center text-xs text-red-400">
          {(history.error as Error).message}
        </div>
      )}
      {history.isSuccess && bars.length === 0 && (
        <div className="flex h-[140px] items-center justify-center text-xs text-gray-600">
          No data.
        </div>
      )}
      {bars.length > 0 && <MiniAreaChart bars={bars} up={up} />}
    </div>
  );
}
