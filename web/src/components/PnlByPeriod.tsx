import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtPct, pnlColor } from "../utils/format";
import { aggregateByMonth } from "../utils/periodPnl";

// Widest span the /api/pnl endpoint accepts (5 years).
const HISTORY_DAYS = 1825;

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtMoney0(v: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

export function PnlByPeriod() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pnl", HISTORY_DAYS],
    queryFn: () => api.pnl(HISTORY_DAYS),
    refetchInterval: 60_000,
  });

  const periods = useMemo(
    () =>
      data
        ? aggregateByMonth(data.series, data.income ?? [], data.accountDays ?? [])
        : null,
    [data],
  );

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-300">Account P&L by month</h2>
      {isLoading ? (
        <p className="text-sm text-gray-500">Computing P&L history…</p>
      ) : isError ? (
        <p className="text-sm text-gray-500">
          P&L history unavailable: {(error as Error).message}
        </p>
      ) : !periods ? (
        <p className="text-sm text-gray-500">No trade history yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-left uppercase text-gray-500">
                <th className="sticky left-0 z-10 bg-[#0d121a] py-1.5 pr-3">Year</th>
                {MONTH_LABELS.map((label) => (
                  <th key={label} className="py-1.5 pr-2 text-right">
                    {label}
                  </th>
                ))}
                <th className="py-1.5 pl-2 text-right border-l border-gray-800">Total</th>
                <th className="py-1.5 pl-2 text-right">Total %</th>
                <th
                  className="py-1.5 pl-2 text-right"
                  title="IBKR's own time-weighted return — neutralises deposits and withdrawals"
                >
                  TWR
                </th>
              </tr>
            </thead>
            <tbody>
              {periods.years.map((year) => {
                const total = periods.byYear.get(year);
                const pct = periods.byYearPct.get(year);
                const twr = periods.byYearTwr.get(year);
                return (
                  <tr key={year} className="border-b border-gray-900 hover:bg-gray-900/60">
                    <td className="sticky left-0 z-10 bg-[#0d121a] py-1.5 pr-3 font-medium text-gray-100">{year}</td>
                    {MONTH_LABELS.map((_, month) => {
                      const pnl = periods.byMonth.get(`${year}-${month}`);
                      return (
                        <td
                          key={month}
                          className={`py-1.5 pr-2 text-right tabular-nums ${
                            pnl == null ? "text-gray-600" : pnlColor(pnl)
                          }`}
                        >
                          {pnl == null ? "—" : fmtMoney0(pnl)}
                        </td>
                      );
                    })}
                    <td
                      className={`py-1.5 pl-2 text-right font-semibold tabular-nums border-l border-gray-800 ${
                        total == null ? "text-gray-600" : pnlColor(total)
                      }`}
                    >
                      {total == null ? "—" : fmtMoney0(total)}
                    </td>
                    <td
                      className={`py-1.5 pl-2 text-right font-semibold tabular-nums ${
                        pct == null ? "text-gray-600" : pnlColor(pct)
                      }`}
                    >
                      {fmtPct(pct)}
                    </td>
                    <td
                      className={`py-1.5 pl-2 text-right tabular-nums ${
                        twr == null ? "text-gray-600" : pnlColor(twr)
                      }`}
                    >
                      {fmtPct(twr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
            {periods.hasIncome
              ? "Includes dividends, interest and fees."
              : "Trades only — dividends, interest and fees need Cash Transactions in the Flex query."}{" "}
            {periods.navBased.size > 0
              ? "Total % is this year\u2019s P&L over net liquidation value at the prior year-end."
              : "Total % is measured against position value at the prior year-end, which ignores cash \u2014 import NAV history for every year to measure against net liquidation value instead."}{" "}
            TWR is IBKR&rsquo;s own time-weighted return, which neutralises deposits and
            withdrawals; the two columns differ by design in a year with funding, and
            converge in one without.
          </p>
        </div>
      )}
    </div>
  );
}
