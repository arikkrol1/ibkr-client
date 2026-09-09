export function fmtMoney(v: number | undefined, currency = "USD"): string {
  if (v == null || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(v);
}

export function fmtNum(v: number | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);
}

export function fmtPct(v: number | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** Tailwind text color class for a signed value. */
export function pnlColor(v: number | undefined): string {
  if (v == null || v === 0) return "text-gray-300";
  return v > 0 ? "text-emerald-400" : "text-red-400";
}
