import { describe, expect, it } from "vitest";
import type { HistoryBar } from "../api";
import { windowPct } from "./returns";

const bars = (...pts: [number, number][]): HistoryBar[] =>
  pts.map(([time, close]) => ({ time, open: close, high: close, low: close, close, volume: 0 }));

describe("windowPct", () => {
  const series = bars([100, 10], [200, 11], [300, 12], [400, 15]);

  it("measures from the close before the window start", () => {
    expect(windowPct(series, 250)).toBeCloseTo((15 / 11 - 1) * 100);
    expect(windowPct(series, 300)).toBeCloseTo((15 / 11 - 1) * 100);
  });

  it("uses the first bar when the window predates the series", () => {
    expect(windowPct(series, 0)).toBeCloseTo(50);
  });

  it("is flat when the window starts after the last bar", () => {
    expect(windowPct(series, 1000)).toBe(0);
  });

  it("is undefined without a usable base", () => {
    expect(windowPct([], 0)).toBeUndefined();
    expect(windowPct(bars([100, 0], [200, 5]), 0)).toBeUndefined();
  });

  it("divides by |base| so negative prices keep the right sign", () => {
    expect(windowPct(bars([100, -10], [200, -5]), 0)).toBeCloseTo(50);
  });
});
