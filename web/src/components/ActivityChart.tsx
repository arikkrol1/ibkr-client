import { useEffect, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type AreaData,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ActivityTrade, HistoryBar } from "../api";
import type { TradeMarker } from "../utils/activity";
import { fmtNum } from "../utils/format";

const BUY = "#10b981";
const SELL = "#ef4444";
const PRICE = { line: "#94a3b8", top: "#94a3b822", bottom: "#94a3b803" };

interface Props {
  bars: HistoryBar[];
  markers: TradeMarker[];
  /** The most recent fill — drawn as a horizontal line in its side's color. */
  last: ActivityTrade;
  height?: number;
  /** Intraday bars: show times on the axis and in the tooltip. */
  intraday?: boolean;
}

/**
 * Daily price line for one symbol with ▲/▼ markers at every buy/sell fill and
 * a horizontal line at the last fill's price (green buy, red sell). The price
 * scale always stretches to include that line, even when the fill is outside
 * the visible window's range.
 */
export function ActivityChart({ bars, markers, last, height = 180, intraday = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lineRef = useRef<IPriceLine | null>(null);
  const lastPriceRef = useRef(last.price);
  const intradayRef = useRef(intraday);
  const markersByTimeRef = useRef(new Map<number, TradeMarker[]>());
  const [tip, setTip] = useState<{
    x: number;
    date: string;
    price: number;
    trades: TradeMarker[];
  } | null>(null);

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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false },
      crosshair: {
        mode: CrosshairMode.Magnet,
        horzLine: { visible: false, labelVisible: false },
        vertLine: { color: "#6b7280", width: 1, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      lineColor: PRICE.line,
      topColor: PRICE.top,
      bottomColor: PRICE.bottom,
      crosshairMarkerBorderColor: PRICE.line,
      crosshairMarkerBackgroundColor: PRICE.line,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
      // Keep the last-activity line on screen whatever the window shows.
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = base();
        const p = lastPriceRef.current;
        if (!info?.priceRange) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, p),
            maxValue: Math.max(info.priceRange.maxValue, p),
          },
        };
      },
    });

    chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(series) as AreaData | undefined;
      if (!param.point || !param.time || data?.value == null) {
        setTip(null);
        return;
      }
      const time = param.time as number;
      setTip({
        x: param.point.x,
        date: intradayRef.current
          ? new Date(time * 1000).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : new Date(time * 1000).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            }),
        price: data.value,
        trades: markersByTimeRef.current.get(time) ?? [],
      });
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      lineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    intradayRef.current = intraday;
    chartRef.current?.applyOptions({ timeScale: { timeVisible: intraday } });
    series.setData(bars.map<AreaData>((b) => ({ time: b.time as UTCTimestamp, value: b.close })));

    const byTime = new Map<number, TradeMarker[]>();
    for (const m of markers) byTime.set(m.time, [...(byTime.get(m.time) ?? []), m]);
    markersByTimeRef.current = byTime;
    markersRef.current?.setMarkers(
      markers.map((m) => ({
        time: m.time as UTCTimestamp,
        position: m.side === "buy" ? "atPriceBottom" : "atPriceTop",
        price: m.price,
        shape: m.side === "buy" ? "arrowUp" : "arrowDown",
        color: m.side === "buy" ? BUY : SELL,
        size: 1,
      })),
    );

    lastPriceRef.current = last.price;
    if (lineRef.current) series.removePriceLine(lineRef.current);
    lineRef.current = series.createPriceLine({
      price: last.price,
      color: last.side === "buy" ? BUY : SELL,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: last.side === "buy" ? "BUY" : "SELL",
    });

    chartRef.current?.timeScale().fitContent();
  }, [bars, markers, last, intraday]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {tip && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-gray-700 bg-gray-900/95 px-2 py-1 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(tip.x, 72), (containerRef.current?.clientWidth ?? 200) - 72) }}
        >
          <div>
            <span className="text-gray-400">{tip.date}</span>{" "}
            <span className="font-medium tabular-nums text-gray-100">{fmtNum(tip.price)}</span>
          </div>
          {tip.trades.map((t, i) => (
            <div
              key={i}
              className={`tabular-nums ${t.side === "buy" ? "text-emerald-400" : "text-red-400"}`}
            >
              {t.side === "buy" ? "Buy" : "Sell"} {fmtNum(t.quantity, 4)} @ {fmtNum(t.price)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
