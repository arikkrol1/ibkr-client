import { describe, expect, it } from "vitest";
import { describe as describeSymbol } from "./symbolDescription";

describe("describe (symbol tooltip line)", () => {
  it("labels common stock with its de-duplicated classification", () => {
    expect(
      describeSymbol({
        symbol: "AAPL",
        secType: "STK",
        stockType: "COMMON",
        industry: "Technology",
        category: "Computers",
        subcategory: "Computers",
      }),
    ).toBe("Stock · Technology · Computers");
  });

  it("uses the curated description for known funds", () => {
    expect(describeSymbol({ symbol: "SPY", secType: "STK", stockType: "ETF" })).toBe(
      "ETF · Tracks the S&P 500 index",
    );
    expect(describeSymbol({ symbol: "GLD", secType: "STK", stockType: "ETF", industry: "Funds" })).toBe(
      "ETF · Physical gold bullion",
    );
  });

  it("falls back to the bare asset type", () => {
    expect(describeSymbol({ symbol: "ZZZZ", secType: "STK", stockType: "ETF" })).toBe("ETF");
    expect(describeSymbol({ symbol: "X", secType: "OPT" })).toBe("OPT");
    expect(describeSymbol({})).toBe("");
  });
});
