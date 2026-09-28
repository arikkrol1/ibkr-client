import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";
import { MarketDataType, Stock } from "@stoqey/ib";

const ibMock = vi.hoisted(() => ({
  marketDataType: 1,
  api: {
    getHistoricalData: vi.fn(),
    getHeadTimestamp: vi.fn(),
    getMarketData: vi.fn(),
  },
}));
vi.mock("./connection.js", () => ({ ib: ibMock }));
vi.mock("../storage/storage.js", () => ({ getStorage: vi.fn() }));

import { getStorage } from "../storage/storage.js";
import { SqliteStorage } from "../storage/sqlite.js";
import {
  barTime,
  clampedDuration,
  contractKeyOf,
  durationSeconds,
  getHistory,
  parseIbTime,
  streamQuote,
  ticksToQuote,
  type Quote,
} from "./marketData.js";

const DAY = 86_400;
const D = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;

describe("ticksToQuote", () => {
  const ticks = (entries: [number, number | undefined][]) =>
    new Map(entries.map(([k, value]) => [k, { value }]));

  it("maps realtime tick types", () => {
    expect(
      ticksToQuote(ticks([[1, 99], [2, 101], [4, 100], [6, 105], [7, 95], [8, 1000], [9, 98]])),
    ).toEqual({ delayed: false, bid: 99, ask: 101, last: 100, high: 105, low: 95, volume: 1000, close: 98 });
  });

  it("maps delayed tick types and flags the quote as delayed", () => {
    expect(
      ticksToQuote(ticks([[66, 99], [67, 101], [68, 100], [72, 105], [73, 95], [74, 5], [75, 98]])),
    ).toEqual({ delayed: true, bid: 99, ask: 101, last: 100, high: 105, low: 95, volume: 5, close: 98 });
  });

  it("ignores unset (-1 / missing) values and unknown tick types", () => {
    expect(ticksToQuote(ticks([[4, -1], [1, undefined], [999, 5]]))).toEqual({ delayed: false });
  });
});

describe("time/duration helpers", () => {
  it("barTime normalises yyyymmdd strings and epoch seconds", () => {
    expect(barTime("20250106")).toBe(D(2025, 0, 6));
    expect(barTime(1736121600)).toBe(1736121600);
    expect(barTime("1736121600")).toBe(1736121600);
  });

  it("parseIbTime handles epoch and dated head timestamps", () => {
    expect(parseIbTime("1736121600")).toBe(1736121600);
    expect(parseIbTime("20250106-09:30:00")).toBe(D(2025, 0, 6));
    expect(parseIbTime("20250106  09:30:00")).toBe(D(2025, 0, 6));
    expect(parseIbTime("garbage")).toBeUndefined();
  });

  it("durationSeconds approximates IBKR duration strings generously", () => {
    expect(durationSeconds("30 S")).toBe(30);
    expect(durationSeconds("90 D")).toBe(90 * DAY);
    expect(durationSeconds("1 W")).toBe(7 * DAY);
    expect(durationSeconds("6 M")).toBe(6 * 31 * DAY);
    expect(durationSeconds("2 Y")).toBe(2 * 366 * DAY);
    expect(durationSeconds("5 y")).toBe(5 * 366 * DAY);
    expect(durationSeconds("bad")).toBe(0);
  });

  describe("clampedDuration", () => {
    const NOW = D(2025, 5, 1);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
    });
    afterEach(() => vi.useRealTimers());

    it("clamps a request that reaches past the first bar", () => {
      expect(clampedDuration("1 Y", NOW - 100 * DAY)).toBe("100 D");
      expect(clampedDuration("50 Y", NOW - 800 * DAY)).toBe("3 Y");
    });

    it("returns undefined when no clamp is needed", () => {
      expect(clampedDuration("30 D", NOW - 100 * DAY)).toBeUndefined();
      expect(clampedDuration("1 Y", NOW + DAY)).toBeUndefined();
    });
  });

  it("contractKeyOf prefers the conId", () => {
    expect(contractKeyOf({ conId: 123, exchange: "SMART" })).toBe("123");
    expect(contractKeyOf(new Stock("AAPL", "SMART", "USD"))).toBe("AAPL:USD:SMART");
  });
});

describe("getHistory", () => {
  let store: SqliteStorage;
  // Each test uses its own conId so the in-memory TTL cache never crosses tests.
  let conId = 1000;
  const contract = () => ({ conId, exchange: "SMART" });

  beforeEach(() => {
    store = new SqliteStorage(":memory:");
    vi.mocked(getStorage).mockReturnValue(store);
    ibMock.api.getHistoricalData.mockReset();
    ibMock.api.getHeadTimestamp.mockReset();
    conId += 1;
  });

  const now = () => Math.floor(Date.now() / 1000);
  const dayStart = (t: number) => t - (t % DAY);

  it("normalises and sorts intraday bars, and caches by request", async () => {
    ibMock.api.getHistoricalData.mockResolvedValue([
      { time: "200", close: 11, volume: 5 },
      { time: "100", open: 9, high: 12, low: 8, close: 10 },
      { time: "300" }, // no close — dropped
    ]);
    const p = { contract: contract(), barSize: "5 mins", duration: "1 D", useRTH: false };
    const bars = await getHistory(p);
    expect(bars).toEqual([
      { time: 100, open: 9, high: 12, low: 8, close: 10, volume: 0 },
      { time: 200, open: 11, high: 11, low: 11, close: 11, volume: 5 },
    ]);
    const args = ibMock.api.getHistoricalData.mock.calls[0];
    expect(args.slice(1)).toEqual(["", "1 D", "5 mins", "TRADES", 0, 2]);

    await getHistory(p);
    expect(ibMock.api.getHistoricalData).toHaveBeenCalledTimes(1);
  });

  it("persists daily bars and serves narrower spans from storage", async () => {
    const t = dayStart(now());
    ibMock.api.getHistoricalData.mockResolvedValue([
      { time: String(t - 2 * DAY), close: 10 },
      { time: String(t - DAY), close: 11 },
    ]);
    const first = await getHistory({ contract: contract(), barSize: "1 day", duration: "1 M", useRTH: true });
    expect(first.map((b) => b.close)).toEqual([10, 11]);
    expect(await store.getDailyBars(String(conId), 0)).toHaveLength(2);

    const second = await getHistory({ contract: contract(), barSize: "1 day", duration: "10 D", useRTH: true });
    expect(second.map((b) => b.close)).toEqual([10, 11]);
    expect(ibMock.api.getHistoricalData).toHaveBeenCalledTimes(1);
  });

  it("serves stored daily bars when IB fails", async () => {
    const t = dayStart(now());
    await store.upsertDailyBars(String(conId), [
      { time: t - DAY, open: 5, high: 5, low: 5, close: 5, volume: 0 },
    ]);
    ibMock.api.getHistoricalData.mockRejectedValue(new Error("farm down"));
    const bars = await getHistory({ contract: contract(), barSize: "1 day", duration: "1 M", useRTH: true });
    expect(bars.map((b) => b.close)).toEqual([5]);
  });

  it("rebuilds stored bars when a split rewrites history", async () => {
    const t = dayStart(now());
    const key = String(conId);
    await store.upsertDailyBars(key, [
      { time: t - 3 * DAY, open: 1000, high: 1000, low: 1000, close: 1000, volume: 0 },
      { time: t - 2 * DAY, open: 1000, high: 1000, low: 1000, close: 1000, volume: 0 },
    ]);
    ibMock.api.getHistoricalData.mockResolvedValue([
      { time: String(t - 2 * DAY), close: 100 },
      { time: String(t - DAY), close: 101 },
    ]);
    const bars = await getHistory({ contract: contract(), barSize: "1 day", duration: "1 M", useRTH: true });
    expect(bars.map((b) => b.close)).toEqual([100, 101]);
  });

  it("clamps the duration to the head timestamp on IB error 162", async () => {
    const head = now() - 10 * DAY;
    ibMock.api.getHistoricalData
      .mockRejectedValueOnce(new Error("Historical Market Data Service error message: failed to compute time length"))
      .mockResolvedValueOnce([{ time: "100", close: 1 }]);
    ibMock.api.getHeadTimestamp.mockResolvedValue(String(head));
    const bars = await getHistory({ contract: contract(), barSize: "1 hour", duration: "1 Y", useRTH: true });
    expect(bars).toHaveLength(1);
    expect(ibMock.api.getHistoricalData.mock.calls[1][2]).toBe("10 D");
  });

  it("rethrows unrelated errors", async () => {
    ibMock.api.getHistoricalData.mockRejectedValue(new Error("No security definition"));
    await expect(
      getHistory({ contract: contract(), barSize: "1 hour", duration: "1 D", useRTH: true }),
    ).rejects.toThrow(/No security definition/);
    expect(ibMock.api.getHeadTimestamp).not.toHaveBeenCalled();
  });
});

describe("streamQuote", () => {
  afterEach(() => {
    ibMock.marketDataType = MarketDataType.REALTIME;
  });

  it("emits normalised quotes and unsubscribes upstream", () => {
    const upstream = new Subject<{ all: Map<number, { value?: number }> }>();
    ibMock.api.getMarketData.mockReturnValue(upstream);
    const seen: Quote[] = [];
    const sub = streamQuote({ conId: 1 }).subscribe((q) => seen.push(q));
    upstream.next({ all: new Map([[4, { value: 100 }]]) });
    expect(seen).toEqual([{ delayed: false, last: 100 }]);
    sub.unsubscribe();
    expect(upstream.observed).toBe(false);
  });

  it("marks every quote delayed when the session is on delayed data", () => {
    ibMock.marketDataType = MarketDataType.DELAYED;
    const upstream = new Subject<{ all: Map<number, { value?: number }> }>();
    ibMock.api.getMarketData.mockReturnValue(upstream);
    const seen: Quote[] = [];
    streamQuote({ conId: 1 }).subscribe((q) => seen.push(q));
    upstream.next({ all: new Map([[4, { value: 100 }]]) });
    expect(seen[0].delayed).toBe(true);
  });
});
