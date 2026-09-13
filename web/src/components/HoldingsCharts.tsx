import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  AreaSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, type PortfolioPosition } from "../api";
import { fmtNum, fmtPct, pnlColor } from "../utils/format";

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

/**
 * Grid of per-holding price line charts with a shared timeframe selector.
 * Fetches one year of daily bars per holding and slices client-side, so
 * switching timeframes needs no extra requests.
 */
export function HoldingsCharts({ positions }: { positions: PortfolioPosition[] }) {
  const [tfKey, setTfKey] = useState("month");
  const tf = TIMEFRAMES.find((t) => t.key === tfKey) ?? TIMEFRAMES[1];
  const startSec = useMemo(() => Math.floor(tf.start(new Date()).getTime() / 1000), [tf]);

  const holdings = positions.filter((p) => p.symbol);
  if (holdings.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-300">
          Holdings ({holdings.length})
        </h2>
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {holdings.map((p) => (
          <HoldingChartCard
            key={`${p.conId ?? p.symbol}`}
            position={p}
            startSec={startSec}
          />
        ))}
      </div>
    </div>
  );
}

function HoldingChartCard({
  position,
  startSec,
}: {
  position: PortfolioPosition;
  startSec: number;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dailyBars", position.conId ?? position.symbol],
    queryFn: () =>
      api.history({
        symbol: position.symbol,
        conId: position.conId,
        barSize: "1 day",
        duration: "1 Y",
      }),
    staleTime: 5 * 60_000,
  });

  const { points, pct } = useMemo(() => {
    const bars = data?.bars ?? [];
    let idx = bars.findIndex((b) => b.time >= startSec);
    if (idx === -1) idx = bars.length;
    // Include the close before the window start so the line (and the % change)
    // is measured against the prior close, not the window's first close.
    const windowBars = bars.slice(Math.max(0, idx - 1));
    const points = windowBars.map((b) => ({ time: b.time, value: b.close }));
    const first = points[0]?.value;
    const last = points[points.length - 1]?.value;
    const pct =
      first != null && last != null && first !== 0
        ? ((last - first) / Math.abs(first)) * 100
        : undefined;
    return { points, pct };
  }, [data, startSec]);

  const last = points[points.length - 1]?.value ?? position.marketPrice;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-gray-100">{position.symbol}</span>
        <span className="text-xs tabular-nums text-gray-400">
          {fmtNum(last)}
          <span className={`ml-2 ${pnlColor(pct)}`}>{fmtPct(pct)}</span>
        </span>
      </div>
      {isLoading ? (
        <div className="h-32 animate-pulse rounded bg-gray-900" />
      ) : isError ? (
        <div className="flex h-32 items-center justify-center px-2 text-center text-xs text-gray-500">
          {(error as Error).message}
        </div>
      ) : points.length < 2 ? (
        <div className="flex h-32 items-center justify-center text-xs text-gray-500">
          Not enough data for this timeframe.
        </div>
      ) : (
        <MiniPriceChart points={points} up={(pct ?? 0) >= 0} />
      )}
    </div>
  );
}

function MiniPriceChart({
  points,
  up,
}: {
  points: { time: number; value: number }[];
  up: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#6b7280",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.12 },
      },
      timeScale: { borderVisible: false, timeVisible: false, secondsVisible: false },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 3,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push data whenever the points or direction change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.applyOptions({
      lineColor: up ? "#10b981" : "#ef4444",
      topColor: up ? "rgba(16, 185, 129, 0.25)" : "rgba(239, 68, 68, 0.25)",
      bottomColor: "rgba(0, 0, 0, 0)",
    });
    series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points, up]);

  return <div ref={containerRef} className="h-32 w-full" />;
}
