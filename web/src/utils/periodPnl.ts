import type { AccountDay, IncomeEntry, PnlSeries } from "../api";

export interface PeriodPnl {
  /** Descending. */
  years: number[];
  /** `${year}-${month0}` -> P&L accrued that month. */
  byMonth: Map<string, number>;
  byYear: Map<number, number>;
  /** Year P&L as % of the account's value at the start of that year. */
  byYearPct: Map<number, number | undefined>;
  /** Years whose % is measured against NAV rather than position value. */
  navBased: Set<number>;
  /** IBKR's own time-weighted return per year, in percent, where known. */
  byYearTwr: Map<number, number | undefined>;
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
export function aggregateByMonth(
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

  // IBKR's own time-weighted return, chained from its daily values. Unlike
  // Total % this neutralises deposits and withdrawals, so it's the figure that
  // matches TWS — and the two legitimately differ in a year with funding.
  // Chaining a year we only partly cover would understate it, so require
  // account-day coverage from before the year's first month in the grid.
  const byYearTwr = new Map<number, number | undefined>();
  for (const year of byYear.keys()) {
    const firstMonth = active.find((mo) => mo.y === year);
    const days = accountDays.filter(
      (d) => d.twr != null && new Date(d.time * 1000).getUTCFullYear() === year,
    );
    const covered =
      days.length > 0 &&
      firstMonth != null &&
      days[0].time <= Date.UTC(year, firstMonth.m, 1) / 1000;
    byYearTwr.set(
      year,
      covered ? (days.reduce((acc, d) => acc * (1 + (d.twr ?? 0) / 100), 1) - 1) * 100 : undefined,
    );
  }

  return {
    years: [...byYear.keys()].sort((a, b) => b - a),
    byMonth,
    byYear,
    byYearPct,
    navBased,
    byYearTwr,
    hasIncome: income.length > 0,
  };
}
