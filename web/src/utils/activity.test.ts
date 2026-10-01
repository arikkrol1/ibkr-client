import { describe, expect, it } from "vitest";
import type { ActivityTrade, HistoryBar } from "../api";
import {
  ACTIVITY_TIMEFRAMES,
  changeSince,
  matchesStatus,
  tradeMarkers,
  windowBars,
} from "./activity";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 6) / 1000;

const bar = (time: number, close: number): HistoryBar => ({
  time, open: close, high: close, low: close, close, volume: 0,
});
const trade = (time: number, side: ActivityTrade["side"], price = 10): ActivityTrade => ({
  time, side, quantity: 1, price,
});

const bars = [bar(T0, 10), bar(T0 + DAY, 11), bar(T0 + 2 * DAY, 12), bar(T0 + 3 * DAY, 13)];

describe("windowBars", () => {
  it("keeps the close before the window start", () => {
    expect(windowBars(bars, T0 + 2 * DAY).map((b) => b.close)).toEqual([11, 12, 13]);
  });

  it("returns everything for the All window", () => {
    expect(windowBars(bars, null)).toBe(bars);
  });

  it("keeps only the latest close when the window starts after the last bar", () => {
    expect(windowBars(bars, T0 + 10 * DAY).map((b) => b.close)).toEqual([13]);
  });
});

describe("tradeMarkers", () => {
  it("snaps intraday fills onto their day's bar", () => {
    const markers = tradeMarkers(
      [trade(T0 + 15 * 3600, "buy"), trade(T0 + 2 * DAY + 3600, "sell", 12.5)],
      bars,
    );
    expect(markers).toEqual([
      { time: T0, side: "buy", quantity: 1, price: 10 },
      { time: T0 + 2 * DAY, side: "sell", quantity: 1, price: 12.5 },
    ]);
  });

  it("drops trades before the first bar or past the last bar's day", () => {
    const markers = tradeMarkers(
      [trade(T0 - DAY, "buy"), trade(T0 + 3600, "buy"), trade(T0 + 5 * DAY, "sell")],
      bars,
    );
    expect(markers.map((m) => m.time)).toEqual([T0]);
  });

  it("keeps several fills on the same day", () => {
    expect(tradeMarkers([trade(T0 + 60, "buy"), trade(T0 + 120, "sell")], bars)).toHaveLength(2);
  });

  it("handles missing bars", () => {
    expect(tradeMarkers([trade(T0, "buy")], [])).toEqual([]);
  });
});

describe("tradeMarkers with intraday bars", () => {
  const hourly = [bar(T0, 10), bar(T0 + 3600, 11), bar(T0 + 7200, 12)];

  it("snaps fills onto the bar covering them", () => {
    const markers = tradeMarkers([trade(T0 + 3700, "buy"), trade(T0 + 7300, "sell")], hourly, 3600);
    expect(markers.map((m) => m.time)).toEqual([T0 + 3600, T0 + 7200]);
  });

  it("drops fills after the last bar closes", () => {
    expect(tradeMarkers([trade(T0 + 3 * 3600, "buy")], hourly, 3600)).toEqual([]);
  });
});

describe("matchesStatus", () => {
  it.each([
    ["All", true, true],
    ["All", false, true],
    ["Open", true, true],
    ["Open", false, false],
    ["Closed", true, false],
    ["Closed", false, true],
  ] as const)("%s, open=%s → %s", (filter, open, expected) => {
    expect(matchesStatus({ open }, filter)).toBe(expected);
  });
});

describe("changeSince", () => {
  it("measures the latest close against the last fill", () => {
    expect(changeSince(10, bars)).toBeCloseTo(30);
  });

  it("is undefined without bars or a price", () => {
    expect(changeSince(10, [])).toBeUndefined();
    expect(changeSince(0, bars)).toBeUndefined();
  });
});

describe("ACTIVITY_TIMEFRAMES", () => {
  it("goes back the advertised number of months", () => {
    const now = new Date(2026, 9, 1);
    const start = (key: string) => ACTIVITY_TIMEFRAMES.find((t) => t.key === key)!.start(now);
    expect(start("1m")).toEqual(new Date(2026, 8, 1));
    expect(start("3m")).toEqual(new Date(2026, 6, 1));
    expect(start("ytd")).toEqual(new Date(2026, 0, 1));
    expect(start("1y")).toEqual(new Date(2025, 9, 1));
    expect(start("3y")).toEqual(new Date(2023, 9, 1));
    expect(start("all")).toBeNull();
  });

  it("fetches intraday bars for the short windows only", () => {
    const intraday = ACTIVITY_TIMEFRAMES.filter((t) => t.intraday).map((t) => t.key);
    expect(intraday).toEqual(["1d", "1w"]);
  });
});
