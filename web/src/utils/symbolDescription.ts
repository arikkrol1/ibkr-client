import type { SymbolInfo } from "../api";

/**
 * What well-known ETFs/ETNs hold, in a few words. IBKR's contract details
 * leave the industry classification blank for funds, so this fills the gap
 * for the curated Compare universe and common holdings; unknown funds fall
 * back to the bare asset type.
 */
export const ETF_DESCRIPTIONS: Record<string, string> = {
  SPY: "Tracks the S&P 500 index",
  VOO: "Tracks the S&P 500 index",
  IVV: "Tracks the S&P 500 index",
  QQQ: "Tracks the Nasdaq-100 index",
  DIA: "Tracks the Dow Jones Industrial Average",
  IWM: "Russell 2000 small-cap index",
  VTI: "Total US stock market",
  EFA: "Developed-market equities ex-US",
  EEM: "Emerging-market equities",
  XLK: "S&P 500 technology sector",
  XLE: "S&P 500 energy sector",
  XLF: "S&P 500 financials sector",
  XLV: "S&P 500 health care sector",
  XLI: "S&P 500 industrials sector",
  SMH: "Semiconductor stocks",
  GLD: "Physical gold bullion",
  SLV: "Physical silver bullion",
  USO: "WTI crude oil futures",
  TLT: "20+ year US Treasury bonds",
  ITA: "US aerospace & defense stocks",
  IBIT: "Spot Bitcoin",
  QTUM: "Quantum computing & machine learning stocks",
};

/** "ETF · Physical gold bullion" / "Stock · Technology · Computers" style line. */
export function describe(info: SymbolInfo): string {
  const type =
    info.stockType && info.stockType !== "COMMON"
      ? info.stockType
      : info.secType === "STK"
        ? "Stock"
        : (info.secType ?? "");
  const etfDescription =
    (type === "ETF" || type === "ETN") && info.symbol
      ? ETF_DESCRIPTIONS[info.symbol]
      : undefined;
  const classification = etfDescription
    ? [etfDescription]
    : [...new Set([info.industry, info.category, info.subcategory])].filter(Boolean);
  return [type, ...classification].filter(Boolean).join(" · ");
}
