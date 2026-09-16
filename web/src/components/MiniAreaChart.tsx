import { useEffect, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { HistoryBar } from "../api";
import { fmtNum } from "../utils/format";

interface Props {
  bars: HistoryBar[];
  /** Direction of the overall move — picks the emerald/red styling. */
  up: boolean;
  height?: number;
}

const UP = { line: "#10b981", top: "#10b98133", bottom: "#10b98105" };
const DOWN = { line: "#ef4444", top: "#ef444433", bottom: "#ef444405" };

/** Compact axis-less area chart for grid cards, with a crosshair tooltip. */
export function MiniAreaChart({ bars, up, height = 140 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const intradayRef = useRef(false);
  const [tip, setTip] = useState<{ x: number; date: string; price: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
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
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
    });

    chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(series) as AreaData | undefined;
      if (!param.point || !param.time || data?.value == null) {
        setTip(null);
        return;
      }
      const t = new Date((param.time as number) * 1000);
      const date = intradayRef.current
        ? t.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      setTip({ x: param.point.x, date, price: data.value });
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const colors = up ? UP : DOWN;
    series.applyOptions({
      lineColor: colors.line,
      topColor: colors.top,
      bottomColor: colors.bottom,
      crosshairMarkerBorderColor: colors.line,
      crosshairMarkerBackgroundColor: colors.line,
    });
    intradayRef.current = bars.length > 1 && bars[1].time - bars[0].time < 86_400;
    series.setData(
      bars.map<AreaData>((b) => ({ time: b.time as UTCTimestamp, value: b.close })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [bars, up]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {tip && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-gray-700 bg-gray-900/95 px-2 py-1 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(tip.x, 56), (containerRef.current?.clientWidth ?? 200) - 56) }}
        >
          <span className="text-gray-400">{tip.date}</span>{" "}
          <span className="font-medium tabular-nums text-gray-100">{fmtNum(tip.price)}</span>
        </div>
      )}
    </div>
  );
}
