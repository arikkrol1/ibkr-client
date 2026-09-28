import { describe, expect, it } from "vitest";
import { fmtMoney, fmtNum, fmtPct, pnlColor } from "./format";

describe("fmtMoney", () => {
  it("formats currency with two decimals", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(-12)).toBe("-$12.00");
    expect(fmtMoney(1234.5, "EUR")).toBe("€1,234.50");
  });
  it("renders missing values as an em dash", () => {
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(Number.NaN)).toBe("—");
  });
});

describe("fmtNum", () => {
  it("groups thousands and caps decimals", () => {
    expect(fmtNum(1234.5678)).toBe("1,234.57");
    expect(fmtNum(1234.5678, 0)).toBe("1,235");
    expect(fmtNum(2)).toBe("2");
    expect(fmtNum(undefined)).toBe("—");
  });
});

describe("fmtPct", () => {
  it("signs positive values and fixes two decimals", () => {
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-1)).toBe("-1.00%");
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtPct(undefined)).toBe("—");
    expect(fmtPct(Number.NaN)).toBe("—");
  });
});

describe("pnlColor", () => {
  it("colours gains, losses and flat values", () => {
    expect(pnlColor(1)).toBe("text-emerald-400");
    expect(pnlColor(-1)).toBe("text-red-400");
    expect(pnlColor(0)).toBe("text-gray-300");
    expect(pnlColor(undefined)).toBe("text-gray-300");
  });
});
