import { useQuery } from "@tanstack/react-query";
import { api, type PortfolioPosition } from "../api";
import { AllocationChart } from "../components/AllocationChart";
import { HoldingsCharts } from "../components/HoldingsCharts";
import { fmtMoney, fmtNum, fmtPct, pnlColor } from "../utils/format";

export function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["portfolio"],
    queryFn: api.portfolio,
    refetchInterval: 10_000,
  });

  if (isLoading) {
    return <Centered>Loading portfolio…</Centered>;
  }
  if (isError) {
    return <Centered tone="error">{(error as Error).message}</Centered>;
  }
  if (!data) return null;

  const b = data.balances;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Portfolio</h1>
        {data.account && (
          <span className="text-sm text-gray-500">Account {data.account}</span>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Net Liquidation" value={fmtMoney(b.netLiquidation)} />
        <Card label="Cash" value={fmtMoney(b.totalCashValue)} />
        <Card label="Buying Power" value={fmtMoney(b.buyingPower)} />
        <Card label="Positions Value" value={fmtMoney(b.grossPositionValue)} />
        <Card
          label="Day P&L"
          value={fmtMoney(data.dailyPnL)}
          tone={pnlColor(data.dailyPnL)}
        />
        <Card
          label="Unrealized P&L"
          value={fmtMoney(b.unrealizedPnL)}
          tone={pnlColor(b.unrealizedPnL)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Positions table */}
        <div className="lg:col-span-2 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-300">
            Positions ({data.positions.length})
          </h2>
          {data.positions.length === 0 ? (
            <p className="text-sm text-gray-500">No open positions.</p>
          ) : (
            <PositionsTable positions={data.positions} />
          )}
        </div>

        {/* Allocation */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-300">Allocation</h2>
          <AllocationChart positions={data.positions} />
        </div>
      </div>

      {/* Per-holding price charts */}
      <HoldingsCharts positions={data.positions} />
    </div>
  );
}

function PositionsTable({ positions }: { positions: PortfolioPosition[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-left text-xs uppercase text-gray-500">
            <th className="py-2 pr-3">Symbol</th>
            <th className="py-2 pr-3 text-right">Qty</th>
            <th className="py-2 pr-3 text-right">Avg Cost</th>
            <th className="py-2 pr-3 text-right">Last</th>
            <th className="py-2 pr-3 text-right">Mkt Value</th>
            <th className="py-2 pr-3 text-right">Unreal. P&L</th>
            <th className="py-2 pr-3 text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const cost = (p.avgCost ?? 0) * p.position;
            const pct =
              cost !== 0 && p.unrealizedPnL != null
                ? (p.unrealizedPnL / Math.abs(cost)) * 100
                : undefined;
            return (
              <tr
                key={`${p.conId ?? p.symbol}`}
                className="border-b border-gray-900 hover:bg-gray-900/60"
              >
                <td className="py-2 pr-3 font-medium text-gray-100">{p.symbol}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.position, 0)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.avgCost)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.marketPrice)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(p.marketValue, p.currency)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${pnlColor(p.unrealizedPnL)}`}>
                  {fmtMoney(p.unrealizedPnL, p.currency)}
                </td>
                <td className={`py-2 pr-3 text-right tabular-nums ${pnlColor(pct)}`}>
                  {fmtPct(pct)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone ?? "text-gray-100"}`}>
        {value}
      </div>
    </div>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={`mx-auto mt-10 max-w-md rounded-xl border p-8 text-center ${
        tone === "error"
          ? "border-red-800 bg-red-950/40 text-red-300"
          : "border-gray-800 bg-gray-900/40 text-gray-400"
      }`}
    >
      {children}
    </div>
  );
}
