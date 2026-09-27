import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AccountDay, type IncomeEntry, type PnlSeries } from "../api";
import { fmtPct, pnlColor } from "../utils/format";

// Widest span the /api/pnl endpoint accepts (5 years).
const HISTORY_DAYS = 1825;

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface PeriodPnl {
  /** Descending. */
  years: number[];
  /** `${year}-${month0}` -> P&L accrued that month. */
  byMonth: Map<string, number>;
  byYear: Map<number, number>;
  /** Year P&L as % of the account's value at the start of that year. */
  byYearPct: Map<number, number | undefined>;
  /** Years whose % is measured against NAV rather than position value. */
  navBased: Set<number>;
  /** True once any income (dividends, interest, fees) is included. */
  hasIncome: boolean;
}

/**
 * Collapse per-symbol cumulative daily P&L curves into per-month account P&L:
 * sum every symbol's cumulative value at each month boundary, then diff
 * consecutive boundaries. A symbol contributes 0 before its first point and
 * holds its final value after its last (closed positions keep their realized
 * P&L). Positions opened before the Flex window are seeded server-side at
 * avg cost, so their pre-window gains land in the earliest month shown.
 */
function aggregateByMonth(
  series: PnlSeries[],
  income: IncomeEntry[],
  accountDays: AccountDay[],
): PeriodPnl | null {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of series) {
    if (s.points.length === 0) continue;
    minT = Math.min(minT, s.points[0].time);
    maxT = Math.max(maxT, s.points[s.points.length - 1].time);
  }
  if (!Number.isFinite(minT)) return null;

  // Month boundaries: each entry is a month plus the UNIX second it ends at.
  const first = new Date(minT * 1000);
  const last = new Date(maxT * 1000);
  const months: { y: number; m: number; endSec: number }[] = [];
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  while (y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth())) {
    months.push({ y, m, endSec: Date.UTC(y, m + 1, 1) / 1000 });
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }

  // Portfolio cumulative P&L and gross market value at each month end.
  let cum = new Array<number>(months.length).fill(0);
  let mvAbs = new Array<number>(months.length).fill(0);
  for (const s of series) {
    let i = 0;
    let lastValue = 0;
    let lastMv = 0;
    for (let b = 0; b < months.length; b++) {
      while (i < s.points.length && s.points[i].time < months[b].endSec) {
        lastValue = s.points[i].value;
        lastMv = s.points[i].mv;
        i += 1;
      }
      cum[b] += lastValue;
      mvAbs[b] += Math.abs(lastMv);
    }
  }

  // Price bars can predate the first trade — drop leading months with no
  // activity so the table starts at the account's first real position.
  const firstActive = cum.findIndex((v, b) => Math.abs(v) > 0.005 || mvAbs[b] > 0.005);
  if (firstActive < 0) return null;
  const active = months.slice(firstActive);
  cum = cum.slice(firstActive);
  mvAbs = mvAbs.slice(firstActive);

  // Income is a flow, not a running total — bucket each entry into its month.
  const incomeByMonth = new Map<string, number>();
  for (const entry of income) {
    const d = new Date(entry.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    incomeByMonth.set(key, (incomeByMonth.get(key) ?? 0) + entry.amount);
  }

  const byMonth = new Map<string, number>();
  const byYear = new Map<number, number>();
  active.forEach((mo, b) => {
    const key = `${mo.y}-${mo.m}`;
    const pnl = cum[b] - (b > 0 ? cum[b - 1] : 0) + (incomeByMonth.get(key) ?? 0);
    byMonth.set(key, pnl);
    byYear.set(mo.y, (byYear.get(mo.y) ?? 0) + pnl);
  });

  // % denominator per year, best source first:
  //   1. the account's NAV at the prior year-end — what the money was actually
  //      measured against, cash included;
  //   2. gross position market value at the prior year-end, which ignores cash
  //      and so overstates the return on a part-invested account;
  //   3. the deployed cost of everything trading by that year's end, for years
  //      that start mid-stream — mirrors PnlPctChart's fallback.
  const navByYearEnd = new Map<number, number>();
  for (const d of accountDays) {
    if (d.nav == null) continue;
    const date = new Date(d.time * 1000);
    // The last report date of the year is that year's closing NAV.
    const year = date.getUTCFullYear();
    const prev = navByYearEnd.get(year);
    if (prev == null || d.time > prev) navByYearEnd.set(year, d.time);
  }
  const navAt = new Map<number, number>();
  for (const [year, time] of navByYearEnd) {
    const day = accountDays.find((d) => d.time === time);
    if (day?.nav != null) navAt.set(year, day.nav);
  }

  // All-or-nothing: a column where one row is measured against NAV and the
  // next against position value invites comparisons that don't hold. NAV data
  // only reaches back as far as the Flex statements that carried a NAV section,
  // so use it only once every year can. The account's first year never has a
  // prior year-end at all, so it can't block the upgrade.
  const ordered = [...byYear.keys()].sort((a, b) => a - b);
  const needNav = ordered.slice(1);
  const useNav =
    needNav.length > 0 && needNav.every((year) => (navAt.get(year - 1) ?? 0) > 1e-6);

  const byYearPct = new Map<number, number | undefined>();
  const navBased = new Set<number>();
  for (const [year, pnl] of byYear) {
    let denom = useNav ? (navAt.get(year - 1) ?? 0) : 0;
    if (denom > 1e-6) {
      navBased.add(year);
    } else {
      const prior = active.findIndex((mo) => mo.y === year - 1 && mo.m === 11);
      denom = prior >= 0 ? mvAbs[prior] : 0;
    }
    if (denom < 1e-6) {
      const yearEndSec = Date.UTC(year + 1, 0, 1) / 1000;
      denom = series.reduce(
        (sum, s) =>
          s.points.length > 0 && s.points[0].time < yearEndSec
            ? sum + (s.costBasis ?? 0)
            : sum,
        0,
      );
    }
    byYearPct.set(year, denom > 1e-6 ? (pnl / denom) * 100 : undefined);
  }

  return {
    years: [...byYear.keys()].sort((a, b) => b - a),
    byMonth,
    byYear,
    byYearPct,
    navBased,
    hasIncome: income.length > 0,
  };
}

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
                <th className="py-1.5 pr-3">Year</th>
                {MONTH_LABELS.map((label) => (
                  <th key={label} className="py-1.5 pr-2 text-right">
                    {label}
                  </th>
                ))}
                <th className="py-1.5 pl-2 text-right border-l border-gray-800">Total</th>
                <th className="py-1.5 pl-2 text-right">Total %</th>
              </tr>
            </thead>
            <tbody>
              {periods.years.map((year) => {
                const total = periods.byYear.get(year);
                const pct = periods.byYearPct.get(year);
                return (
                  <tr key={year} className="border-b border-gray-900 hover:bg-gray-900/60">
                    <td className="py-1.5 pr-3 font-medium text-gray-100">{year}</td>
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
              ? "Total % is measured against net liquidation value at the prior year-end."
              : "Total % is measured against position value at the prior year-end, which ignores cash — import NAV history for every year to measure against net liquidation value instead."}{" "}
            Not time-weighted, so it won&rsquo;t match TWS&rsquo;s return in a year with deposits.
          </p>
        </div>
      )}
    </div>
  );
}
