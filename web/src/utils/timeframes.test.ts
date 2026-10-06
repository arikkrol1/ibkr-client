import { describe, expect, it } from "vitest";
import {
  CHART_PRESETS,
  COMPARE_TIMEFRAMES,
  DEFAULT_CHART_PRESET_IDX,
  HOLDINGS_TIMEFRAMES,
  PNL_PCT_TIMEFRAMES,
  TF_3M,
  TF_6M,
  TF_WTD,
  type Timeframe,
} from "./timeframes";

const now = new Date(2026, 9, 6, 15, 30); // Tue Oct 6 2026, local time

describe("timeframe lists", () => {
  it.each([
    ["holdings", HOLDINGS_TIMEFRAMES],
    ["pnl %", PNL_PCT_TIMEFRAMES],
    ["compare", COMPARE_TIMEFRAMES],
  ] as [string, Timeframe[]][])("%s offers 3M and 6M with unique keys", (_, list) => {
    const labels = list.map((t) => t.label);
    expect(labels).toContain("3M");
    expect(labels).toContain("6M");
    expect(new Set(list.map((t) => t.key)).size).toBe(list.length);
  });

  it("chart presets offer 3M and 6M, with matching durations", () => {
    const byLabel = Object.fromEntries(CHART_PRESETS.map((p) => [p.label, p]));
    expect(byLabel["3M"]).toEqual({ label: "3M", barSize: "1 day", duration: "3 M" });
    expect(byLabel["6M"]).toEqual({ label: "6M", barSize: "1 day", duration: "6 M" });
  });

  it("chart default stays on 6M", () => {
    expect(CHART_PRESETS[DEFAULT_CHART_PRESET_IDX].label).toBe("6M");
  });
});

describe("timeframe starts", () => {
  it("3M and 6M go back calendar months", () => {
    expect(TF_3M.start(now)).toEqual(new Date(2026, 6, 6));
    expect(TF_6M.start(now)).toEqual(new Date(2026, 3, 6));
  });

  it("6M crosses a year boundary", () => {
    expect(TF_6M.start(new Date(2026, 1, 15))).toEqual(new Date(2025, 7, 15));
  });

  it("WTD starts on Monday", () => {
    expect(TF_WTD.start(now)).toEqual(new Date(2026, 9, 5));
  });
});
