import type { PortfolioPosition } from "../api";
import { fmtMoney } from "../utils/format";

const COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
];

/** Donut chart of position market value with a legend. */
export function AllocationChart({ positions }: { positions: PortfolioPosition[] }) {
  const sized = positions
    .map((p) => ({ symbol: p.symbol ?? "?", value: Math.abs(p.marketValue ?? 0) }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = sized.reduce((s, p) => s + p.value, 0);
  if (total === 0) {
    return <div className="text-sm text-gray-500">No position values available.</div>;
  }

  const radius = 70;
  const stroke = 28;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg width="180" height="180" viewBox="0 0 180 180">
        <g transform="translate(90,90) rotate(-90)">
          {sized.map((p, i) => {
            const frac = p.value / total;
            const dash = frac * circumference;
            const seg = (
              <circle
                key={p.symbol}
                r={radius}
                cx="0"
                cy="0"
                fill="none"
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return seg;
          })}
        </g>
        <text
          x="90"
          y="86"
          textAnchor="middle"
          className="fill-gray-400 text-[11px]"
        >
          Total
        </text>
        <text
          x="90"
          y="102"
          textAnchor="middle"
          className="fill-gray-100 text-[13px] font-semibold"
        >
          {fmtMoney(total)}
        </text>
      </svg>

      <ul className="flex-1 space-y-1 text-sm">
        {sized.slice(0, 10).map((p, i) => (
          <li key={p.symbol} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            <span className="w-16 font-medium text-gray-200">{p.symbol}</span>
            <span className="text-gray-400">{fmtMoney(p.value)}</span>
            <span className="ml-auto text-gray-500">
              {((p.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
