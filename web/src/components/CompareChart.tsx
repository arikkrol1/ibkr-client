import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type MouseEventParams,
} from "lightweight-charts";
import { fmtNum, fmtPct } from "../utils/format";

export type CompareMode = "pct" | "price";

export interface CompareSeries {
  key: string;
  symbol: string;
  points: { time: number; value: number }[];
}

interface Props {
  series: CompareSeries[];
  mode: CompareMode;
  /** Series keys currently toggled off in the legend. */
  hidden: Set<string>;
  /** Stable per-series color, shared with the legend. */
  colorFor: (key: string) => string;
}

/** Multi-symbol price overlay line chart (lightweight-charts v5). */
export function CompareChart({ series, mode, hidden, colorFor }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, { api: ISeriesApi<"Line">; meta: CompareSeries }>>(
    new Map(),
  );
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Ref so the once-registered crosshair handler sees colors for symbols
  // added after mount.
  const colorForRef = useRef(colorFor);
  colorForRef.current = colorFor;

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#9ca3af",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      rightPriceScale: { borderColor: "#374151" },
      // minBarSpacing: the 0.5px default caps fitContent at ~2000 bars, which
      // silently clips the left of decade-deep windows (10Y/Max).
      timeScale: { borderColor: "#374151", timeVisible: false, minBarSpacing: 0.001 },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });
    chartRef.current = chart;

    // Crosshair tooltip: date + per-series values, largest first.
    const onCrosshair = (param: MouseEventParams) => {
      const tooltip = tooltipRef.current;
      const container = containerRef.current;
      if (!tooltip || !container) return;
      if (!param.time || !param.point) {
        tooltip.style.display = "none";
        return;
      }
      const rows: { symbol: string; color: string; value: number }[] = [];
      for (const [key, { api, meta }] of seriesMapRef.current) {
        if (hiddenRef.current.has(key)) continue;
        const data = param.seriesData.get(api) as { value?: number } | undefined;
        if (data?.value == null) continue;
        rows.push({ symbol: meta.symbol, color: colorForRef.current(key), value: data.value });
      }
      if (rows.length === 0) {
        tooltip.style.display = "none";
        return;
      }
      rows.sort((a, b) => b.value - a.value);
      const date = new Date((param.time as number) * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const isPct = modeRef.current === "pct";
      tooltip.innerHTML =
        `<div class="mb-1 text-gray-500">${date}</div>` +
        rows
          .map(
            (r) =>
              `<div class="flex items-center gap-2">` +
              `<span class="inline-block h-2 w-2 rounded-full" style="background:${r.color}"></span>` +
              `<span class="text-gray-300">${r.symbol}</span>` +
              `<span class="ml-auto pl-3 tabular-nums ${
                isPct
                  ? r.value >= 0
                    ? "text-emerald-400"
                    : "text-red-400"
                  : "text-gray-200"
              }">${isPct ? fmtPct(r.value) : fmtNum(r.value)}</span></div>`,
          )
          .join("");
      tooltip.style.display = "block";
      const pad = 12;
      const x = Math.min(param.point.x + pad, container.clientWidth - tooltip.offsetWidth - pad);
      const y = Math.min(param.point.y + pad, container.clientHeight - tooltip.offsetHeight - pad);
      tooltip.style.left = `${Math.max(x, pad)}px`;
      tooltip.style.top = `${Math.max(y, pad)}px`;
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      seriesMapRef.current = new Map();
    };
  }, []);

  // Rebuild series when data or mode changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const { api } of seriesMapRef.current.values()) chart.removeSeries(api);
    const map = new Map<string, { api: ISeriesApi<"Line">; meta: CompareSeries }>();

    series.forEach((s, i) => {
      const line = chart.addSeries(LineSeries, {
        color: colorFor(s.key),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: s.symbol,
        visible: !hiddenRef.current.has(s.key),
        crosshairMarkerRadius: 4,
        priceFormat:
          mode === "pct"
            ? { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.01 }
            : { type: "price", precision: 2, minMove: 0.01 },
      });
      line.setData(
        s.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
      );
      // Zero baseline in % mode so out/under-performance reads against a datum.
      if (mode === "pct" && i === 0) {
        line.createPriceLine({
          price: 0,
          color: "#4b5563",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        });
      }
      map.set(s.key, { api: line, meta: s });
    });

    seriesMapRef.current = map;
    chart.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, mode]);

  // Toggle visibility without rebuilding.
  useEffect(() => {
    for (const [key, { api }] of seriesMapRef.current) {
      api.applyOptions({ visible: !hidden.has(key) });
    }
  }, [hidden]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-[480px] w-full mobile:h-[300px]" />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute z-10 hidden min-w-40 rounded-lg border border-gray-700 bg-gray-950/95 p-2.5 text-xs shadow-xl"
        style={{ display: "none" }}
      />
    </div>
  );
}
