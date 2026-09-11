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
import type { PnlSeries } from "../api";
import { fmtMoney } from "../utils/format";

interface Props {
  series: PnlSeries[];
  /** Series keys currently toggled off in the legend. */
  hidden: Set<string>;
  /** Stable per-series color, shared with the legend. */
  colorFor: (key: string) => string;
}

/** Multi-series cumulative P&L line chart (lightweight-charts v5). */
export function PnlChart({ series, hidden, colorFor }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, { api: ISeriesApi<"Line">; meta: PnlSeries }>>(
    new Map(),
  );
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

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
      timeScale: { borderColor: "#374151", timeVisible: false },
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
        rows.push({ symbol: meta.symbol, color: colorFor(key), value: data.value });
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
      tooltip.innerHTML =
        `<div class="mb-1 text-gray-500">${date}</div>` +
        rows
          .map(
            (r) =>
              `<div class="flex items-center gap-2">` +
              `<span class="inline-block h-2 w-2 rounded-full" style="background:${r.color}"></span>` +
              `<span class="text-gray-300">${r.symbol}</span>` +
              `<span class="ml-auto pl-3 tabular-nums ${
                r.value >= 0 ? "text-emerald-400" : "text-red-400"
              }">${fmtMoney(r.value)}</span></div>`,
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
    // colorFor is stable per parent render cycle; tooltip colors refresh with data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild series when data changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const { api } of seriesMapRef.current.values()) chart.removeSeries(api);
    const map = new Map<string, { api: ISeriesApi<"Line">; meta: PnlSeries }>();

    series.forEach((s, i) => {
      const line = chart.addSeries(LineSeries, {
        color: colorFor(s.key),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: s.symbol,
        visible: !hiddenRef.current.has(s.key),
        crosshairMarkerRadius: 4,
        priceFormat: { type: "price", precision: 0, minMove: 1 },
      });
      line.setData(
        s.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
      );
      // Zero baseline on the first series so gains/losses read against a datum.
      if (i === 0) {
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
  }, [series]);

  // Toggle visibility without rebuilding.
  useEffect(() => {
    for (const [key, { api }] of seriesMapRef.current) {
      api.applyOptions({ visible: !hidden.has(key) });
    }
  }, [hidden]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-[480px] w-full" />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute z-10 hidden min-w-40 rounded-lg border border-gray-700 bg-gray-950/95 p-2.5 text-xs shadow-xl"
        style={{ display: "none" }}
      />
    </div>
  );
}
