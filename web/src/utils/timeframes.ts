/** A selectable chart window, resolved to its start instant relative to `now`. */
export interface Timeframe {
  key: string;
  label: string;
  start: (now: Date) => Date;
  /**
   * IBKR duration to fetch (default "1 Y"). Daily bars are served back to
   * the instrument's inception when the ask exceeds available history.
   */
  duration?: string;
}

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const monthsBack = (n: Date, months: number) =>
  new Date(n.getFullYear(), n.getMonth() - months, n.getDate());

export const TF_DAY: Timeframe = { key: "day", label: "Day", start: (n) => startOfDay(n) };
/** Trailing 24h (rather than since midnight) — used by the P&L % chart. */
export const TF_LAST_DAY: Timeframe = {
  key: "day",
  label: "Day",
  start: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1),
};
export const TF_WEEK: Timeframe = {
  key: "week",
  label: "Week",
  start: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7),
};
export const TF_MONTH: Timeframe = { key: "month", label: "Month", start: (n) => monthsBack(n, 1) };
export const TF_3M: Timeframe = { key: "3m", label: "3M", start: (n) => monthsBack(n, 3) };
export const TF_6M: Timeframe = { key: "6m", label: "6M", start: (n) => monthsBack(n, 6) };
export const TF_YEAR: Timeframe = { key: "year", label: "Year", start: (n) => monthsBack(n, 12) };
export const TF_WTD: Timeframe = {
  key: "wtd",
  label: "WTD",
  start: (n) => {
    const d = startOfDay(n);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    return d;
  },
};
export const TF_MTD: Timeframe = {
  key: "mtd",
  label: "MTD",
  start: (n) => new Date(n.getFullYear(), n.getMonth(), 1),
};
export const TF_YTD: Timeframe = {
  key: "ytd",
  label: "YTD",
  start: (n) => new Date(n.getFullYear(), 0, 1),
};

/** Portfolio → per-holding charts (sliced from a year of daily bars). */
export const HOLDINGS_TIMEFRAMES: Timeframe[] = [
  TF_DAY, TF_WEEK, TF_MONTH, TF_3M, TF_6M, TF_YEAR, TF_WTD, TF_MTD, TF_YTD,
];

/** P&L → "P&L % by symbol" bars, longest window first. */
export const PNL_PCT_TIMEFRAMES: Timeframe[] = [
  TF_YEAR, TF_6M, TF_3M, TF_MONTH, TF_WEEK, TF_LAST_DAY, TF_YTD, TF_MTD, TF_WTD,
];

/** Compare tab overlay; longer windows fetch deeper daily history. */
export const COMPARE_TIMEFRAMES: Timeframe[] = [
  TF_WEEK,
  TF_MONTH,
  TF_3M,
  TF_6M,
  TF_YEAR,
  { key: "5y", label: "5Y", start: (n) => monthsBack(n, 60), duration: "5 Y" },
  { key: "10y", label: "10Y", start: (n) => monthsBack(n, 120), duration: "10 Y" },
  { key: "max", label: "Max", start: () => new Date(0), duration: "50 Y" },
  TF_WTD,
  TF_MTD,
  TF_YTD,
];

/** Charts tab presets: each fetches its own range at a matching bar size. */
export const CHART_PRESETS = [
  { label: "1D", barSize: "5 mins", duration: "1 D" },
  { label: "1W", barSize: "30 mins", duration: "1 W" },
  { label: "1M", barSize: "1 day", duration: "1 M" },
  { label: "3M", barSize: "1 day", duration: "3 M" },
  { label: "6M", barSize: "1 day", duration: "6 M" },
  { label: "1Y", barSize: "1 day", duration: "1 Y" },
  { label: "5Y", barSize: "1 week", duration: "5 Y" },
  { label: "10Y", barSize: "1 week", duration: "10 Y" },
] as const;

export const DEFAULT_CHART_PRESET_IDX = CHART_PRESETS.findIndex((p) => p.label === "6M");
