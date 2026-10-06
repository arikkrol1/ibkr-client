import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  AreaSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, type PortfolioPosition } from "../api";
import { fmtNum, fmtPct, pnlColor } from "../utils/format";
import { HOLDINGS_TIMEFRAMES as TIMEFRAMES, TF_MONTH } from "../utils/timeframes";


/**
 * Grid of per-holding price line charts with a shared timeframe selector.
 * Fetches one year of daily bars per holding and slices client-side, so
 * switching timeframes needs no extra requests.
 */
export function HoldingsCharts({ positions }: { positions: PortfolioPosition[] }) {
  const [tfKey, setTfKey] = useState("month");
  const tf = TIMEFRAMES.find((t) => t.key === tfKey) ?? TF_MONTH;
  const startSec = useMemo(() => Math.floor(tf.start(new Date()).getTime() / 1000), [tf]);
  const navigate = useNavigate();

  const holdings = positions.filter((p) => p.symbol);
  if (holdings.length === 0) return null;

  // Jump to the Charts tab with this holding pre-selected via URL params.
  const openInCharts = (p: PortfolioPosition) => {
    const qs = new URLSearchParams();
    if (p.symbol) qs.set("symbol", p.symbol);
    if (p.conId != null) qs.set("conId", String(p.conId));
    if (p.currency) qs.set("currency", p.currency);
    navigate(`/chart?${qs.toString()}`);
  };

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
            tfKey={tfKey}
            startSec={startSec}
            onOpen={() => openInCharts(p)}
          />
        ))}
      </div>
    </div>
  );
}

function HoldingChartCard({
  position,
  tfKey,
  startSec,
  onOpen,
}: {
  position: PortfolioPosition;
  tfKey: string;
  startSec: number;
  onOpen: () => void;
}) {
  // The Day view needs intraday bars; every other timeframe slices a shared
  // year of daily bars client-side. Two distinct queries, keyed apart so React
  // Query caches them independently.
  const isDay = tfKey === "day";
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["holdingBars", position.conId ?? position.symbol, isDay ? "1D" : "1Y"],
    queryFn: () =>
      api.history({
        symbol: position.symbol,
        conId: position.conId,
        barSize: isDay ? "5 mins" : "1 day",
        duration: isDay ? "1 D" : "1 Y",
      }),
    // Poll the intraday series so the Day view tracks the live price.
    staleTime: isDay ? 30_000 : 5 * 60_000,
    refetchInterval: isDay ? 30_000 : false,
  });

  const { points, pct } = useMemo(() => {
    const bars = data?.bars ?? [];
    // Day view: use the whole intraday series, measured from the session's
    // first bar (near the open) to the latest.
    const windowBars = isDay
      ? bars
      : (() => {
          let idx = bars.findIndex((b) => b.time >= startSec);
          if (idx === -1) idx = bars.length;
          // Include the close before the window start so the line (and the %
          // change) is measured against the prior close, not the window's first.
          return bars.slice(Math.max(0, idx - 1));
        })();
    const points = windowBars.map((b) => ({ time: b.time, value: b.close }));
    const first = points[0]?.value;
    const last = points[points.length - 1]?.value;
    const pct =
      first != null && last != null && first !== 0
        ? ((last - first) / Math.abs(first)) * 100
        : undefined;
    return { points, pct };
  }, [data, startSec, isDay]);

  const last = points[points.length - 1]?.value ?? position.marketPrice;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-gray-100">{position.symbol}</span>
          <button
            type="button"
            onClick={onOpen}
            title={`Open ${position.symbol} in Charts`}
            aria-label={`Open ${position.symbol} in Charts`}
            className="rounded p-0.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
          </button>
        </div>
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
          {isDay ? "No intraday data yet." : "Not enough data for this timeframe."}
        </div>
      ) : (
        <MiniPriceChart points={points} up={(pct ?? 0) >= 0} timeVisible={isDay} />
      )}
    </div>
  );
}

function MiniPriceChart({
  points,
  up,
  timeVisible = false,
}: {
  points: { time: number; value: number }[];
  up: boolean;
  timeVisible?: boolean;
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
        horzLines: { color: "#1f2937", style: LineStyle.Dotted },
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
    // Show intraday times on the axis for the Day view; dates otherwise.
    chartRef.current?.applyOptions({ timeScale: { timeVisible } });
    series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points, up, timeVisible]);

  return <div ref={containerRef} className="h-32 w-full" />;
}
