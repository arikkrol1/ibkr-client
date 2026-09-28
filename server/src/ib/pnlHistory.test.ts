import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { baseCurrency: "USD" } }));
vi.mock("./flex.js", () => ({
  flexConfigured: vi.fn(() => true),
  getFlexTrades: vi.fn(async () => []),
  tradesAsOf: vi.fn(async () => 1_700_000_000_000),
  getAccountDays: vi.fn(async () => []),
  getCashTransactions: vi.fn(async () => []),
}));
vi.mock("./portfolio.js", () => ({
  getPortfolio: vi.fn(async () => ({ account: "U1", balances: {}, positions: [] })),
}));
vi.mock("./marketData.js", () => ({ getHistory: vi.fn(async () => []) }));
vi.mock("./fx.js", () => ({ getFxRates: vi.fn(async () => null) }));
vi.mock("./contracts.js", () => ({ resolveContract: vi.fn((p: unknown) => p) }));

import type { FlexTrade } from "./flex.js";
import * as flex from "./flex.js";
import { getPortfolio, type PortfolioPosition } from "./portfolio.js";
import { getHistory, type HistoryBar } from "./marketData.js";
import { getFxRates } from "./fx.js";
import {
  flatSeries,
  getPnlHistory,
  invalidatePnlCache,
  mapLimit,
  replaySeries,
  rescaleSplits,
  seedMissing,
  splitFactor,
  toBaseCurrency,
  toDuration,
} from "./pnlHistory.js";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 6) / 1000; // a Monday

function trade(p: Partial<FlexTrade> & { time: number; quantity: number; price: number }): FlexTrade {
  return { symbol: "AAPL", conId: 1, multiplier: 1, commission: 0, ...p };
}

function bars(...closes: number[]): HistoryBar[] {
  return closes.map((close, i) => ({
    time: T0 + i * DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }));
}

describe("toDuration", () => {
  it("uses days up to a year and whole years beyond", () => {
    expect(toDuration(0)).toBe("1 D");
    expect(toDuration(90)).toBe("90 D");
    expect(toDuration(365)).toBe("365 D");
    expect(toDuration(366)).toBe("2 Y");
    expect(toDuration(1825)).toBe("5 Y");
  });
});

describe("mapLimit", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });
});

describe("replaySeries", () => {
  it("marks open lots to each close and realizes FIFO on sells", () => {
    const r = replaySeries(
      [
        trade({ time: T0 + 3600, quantity: 10, price: 10, commission: -1 }),
        trade({ time: T0 + DAY + 3600, quantity: -5, price: 12, commission: -1 }),
      ],
      bars(10, 12, 11),
    );
    expect(r.points).toEqual([
      { time: T0, value: -1, mv: 100 },
      { time: T0 + DAY, value: 18, mv: 60 },
      { time: T0 + 2 * DAY, value: 13, mv: 55 },
    ]);
    expect(r.realized).toBe(8);
    expect(r.unrealized).toBe(5);
    expect(r.deployed).toBe(100);
  });

  it("closes against the oldest lot first", () => {
    const r = replaySeries(
      [
        trade({ time: T0, quantity: 5, price: 10 }),
        trade({ time: T0 + 1, quantity: 5, price: 20 }),
        trade({ time: T0 + 2, quantity: -5, price: 15 }),
      ],
      bars(15),
    );
    // Sold the 10-cost lot: +25 realized; the 20-cost lot is 25 under water.
    expect(r.realized).toBe(25);
    expect(r.unrealized).toBe(-25);
  });

  it("handles shorts and flips through zero", () => {
    const short = replaySeries(
      [trade({ time: T0, quantity: -10, price: 20 }), trade({ time: T0 + 1, quantity: 10, price: 15 })],
      bars(15),
    );
    expect(short.realized).toBe(50);
    expect(short.points[0].mv).toBe(0);

    const flip = replaySeries(
      [trade({ time: T0, quantity: 5, price: 10 }), trade({ time: T0 + 1, quantity: -8, price: 12 })],
      bars(11),
    );
    expect(flip.realized).toBe(10);
    expect(flip.unrealized).toBe(3); // short 3 @ 12, marked at 11
    expect(flip.points[0].mv).toBe(-33);
    expect(flip.deployed).toBe(86);
  });

  it("applies the contract multiplier", () => {
    const r = replaySeries(
      [trade({ time: T0, quantity: 1, price: 2, multiplier: 100, secType: "OPT" })],
      bars(3),
    );
    expect(r.unrealized).toBe(100);
    expect(r.points[0].mv).toBe(300);
  });

  it("folds trades newer than the last bar into the final point", () => {
    const r = replaySeries(
      [trade({ time: T0, quantity: 10, price: 10 }), trade({ time: T0 + 10 * DAY, quantity: -10, price: 15 })],
      bars(10, 12, 11),
    );
    expect(r.realized).toBe(50);
    expect(r.unrealized).toBe(0);
    expect(r.points.at(-1)).toEqual({ time: T0 + 2 * DAY, value: 50, mv: 0 });
  });
});

describe("flatSeries", () => {
  it("steps realized P&L at each closing trade and folds pre-window trades", () => {
    const start = T0 + DAY;
    const end = T0 + 10 * DAY;
    const r = flatSeries(
      [
        trade({ time: T0, quantity: 10, price: 10, commission: -1 }),
        trade({ time: T0 + 3 * DAY, quantity: -10, price: 12 }),
      ],
      start,
      end,
    );
    expect(r.points).toEqual([
      { time: start, value: -1, mv: 0 },
      { time: T0 + 3 * DAY, value: 19, mv: 0 },
      { time: end, value: 19, mv: 0 },
    ]);
    expect(r.realized).toBe(19);
    expect(r.unrealized).toBe(0);
  });

  it("clamps trades after the window end onto the last point", () => {
    const r = flatSeries(
      [trade({ time: T0, quantity: 1, price: 10 }), trade({ time: T0 + 99 * DAY, quantity: -1, price: 11 })],
      T0 - DAY,
      T0 + DAY,
    );
    expect(r.points.at(-1)).toEqual({ time: T0 + DAY, value: 1, mv: 0 });
  });
});

describe("splitFactor", () => {
  it("recognises forward and reverse splits within tolerance", () => {
    expect(splitFactor(10.2, 0.05)).toBe(10);
    expect(splitFactor(2, 0.01)).toBe(2);
    expect(splitFactor(0.1, 0.05)).toBe(0.1);
    expect(splitFactor(0.2502, 0.01)).toBe(0.25);
  });

  it("leaves non-split ratios alone", () => {
    expect(splitFactor(1.03, 0.05)).toBe(1);
    expect(splitFactor(1.5, 0.05)).toBe(1);
    expect(splitFactor(2.5, 0.05)).toBe(1);
    expect(splitFactor(100, 0.05)).toBe(1); // beyond MAX_SPLIT — likely bad data
    expect(splitFactor(0, 0.05)).toBe(1);
    expect(splitFactor(Number.NaN, 0.05)).toBe(1);
  });
});

describe("rescaleSplits", () => {
  it("rescales fills that sit a split factor off the day's adjusted close", () => {
    const ts = [
      trade({ time: T0 + 3600, quantity: 1, price: 1000 }), // pre-split fill
      trade({ time: T0 + DAY + 3600, quantity: 2, price: 101 }), // post-split fill
    ];
    rescaleSplits(ts, bars(100, 100), "NVDA");
    expect(ts[0]).toMatchObject({ quantity: 10, price: 100 });
    expect(ts[1]).toMatchObject({ quantity: 2, price: 101 });
  });

  it("skips trades with no bar for their day", () => {
    const ts = [trade({ time: T0 - 5 * DAY, quantity: 1, price: 1000 })];
    rescaleSplits(ts, bars(100), "X");
    expect(ts[0]).toMatchObject({ quantity: 1, price: 1000 });
    rescaleSplits(ts, [], "X");
    expect(ts[0]).toMatchObject({ quantity: 1, price: 1000 });
  });
});

describe("seedMissing", () => {
  const position = (p: Partial<PortfolioPosition>): PortfolioPosition => ({
    symbol: "AAPL",
    conId: 1,
    position: 0,
    ...p,
  });

  it("seeds a synthetic opening lot at avg cost for pre-window shares", () => {
    const group = [trade({ time: T0, quantity: 10, price: 50 })];
    seedMissing(
      group,
      position({ position: 15, avgCost: 40, marketPrice: 60, marketValue: 900 }),
      T0 + DAY,
      T0 + 5 * DAY,
    );
    expect(group).toHaveLength(2);
    expect(group[0]).toMatchObject({ quantity: 5, price: 40, multiplier: 1, time: T0 - DAY });
  });

  it("derives the multiplier from market value for derivatives", () => {
    const group: FlexTrade[] = [];
    seedMissing(
      group,
      position({ position: 2, avgCost: 250, marketPrice: 3, marketValue: 600, secType: "OPT" }),
      T0,
      T0,
    );
    expect(group[0]).toMatchObject({ quantity: 2, multiplier: 100, price: 2.5 });
  });

  it("treats an exact multiple of the replayed quantity as a split", () => {
    const group = [trade({ time: T0, quantity: 10, price: 1000 })];
    seedMissing(group, position({ position: 100, avgCost: 100 }), T0, T0);
    expect(group).toHaveLength(1);
    expect(group[0]).toMatchObject({ quantity: 100, price: 100 });
  });

  it("does nothing when the replay already matches", () => {
    const group = [trade({ time: T0, quantity: 10, price: 10 })];
    seedMissing(group, position({ position: 10 }), T0, T0);
    expect(group).toHaveLength(1);
  });
});

describe("toBaseCurrency", () => {
  it("converts prices, commissions and OHLC at each day's rate without mutating inputs", () => {
    const rates = { at: (t: number) => (t < T0 + DAY ? 2 : 3) };
    const ts = [trade({ time: T0, quantity: 1, price: 10, commission: -1 })];
    const bs = bars(10, 10);
    const out = toBaseCurrency(ts, bs, rates);
    expect(out.trades[0]).toMatchObject({ price: 20, commission: -2, quantity: 1 });
    expect(out.bars.map((b) => b.close)).toEqual([20, 30]);
    expect(out.bars[1]).toMatchObject({ open: 30, high: 30, low: 30, volume: 0 });
    expect(ts[0].price).toBe(10);
    expect(bs[0].close).toBe(10);
  });
});

describe("getPnlHistory", () => {
  const NOW = T0 + 5 * DAY;
  const DAYS = 30;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    invalidatePnlCache();
    vi.mocked(flex.flexConfigured).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  const aaplRoundTrip = () => [
    trade({ time: T0 + 3600, quantity: 10, price: 100 }),
    trade({ time: T0 + DAY + 3600, quantity: -10, price: 110 }),
    trade({ time: T0, quantity: 1000, price: 1, symbol: "USD.SEK", conId: 9, secType: "CASH" }),
  ];

  it("requires a Flex query (503)", async () => {
    vi.mocked(flex.flexConfigured).mockReturnValue(false);
    await expect(getPnlHistory(DAYS)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("replays trades per contract and skips forex conversions", async () => {
    vi.mocked(flex.getFlexTrades).mockImplementation(async () => aaplRoundTrip());
    vi.mocked(getHistory).mockResolvedValue(bars(100, 110, 105));
    vi.mocked(flex.getAccountDays).mockResolvedValue([{ date: T0, nav: 5000, twr: 0.5 }]);
    vi.mocked(flex.getCashTransactions).mockResolvedValue([
      { txKey: "d", time: T0, type: "Dividends", kind: "income", symbol: "AAPL", amount: 3 },
      { txKey: "w", time: T0, type: "Deposits", kind: "flow", amount: 1000 },
    ]);

    const h = await getPnlHistory(DAYS);
    expect(h.series).toHaveLength(1);
    expect(h.series[0]).toMatchObject({
      key: "c1",
      symbol: "AAPL",
      closed: true,
      realized: 100,
      unrealized: 0,
      total: 100,
      costBasis: 1000,
    });
    expect(h.accountDays).toEqual([
      { time: T0, nav: 5000, cash: undefined, stock: undefined, twr: 0.5 },
    ]);
    expect(h.income).toEqual([{ time: T0, type: "Dividends", symbol: "AAPL", amount: 3 }]);
    expect(h.errors).toEqual([]);
    expect(h.tradesAsOf).toBe(1_700_000_000_000);
    expect(vi.mocked(getHistory).mock.calls[0][0]).toMatchObject({
      barSize: "1 day",
      duration: "30 D",
      useRTH: true,
    });
  });

  it("falls back to a realized-only series and reports the error when bars fail", async () => {
    vi.mocked(flex.getFlexTrades).mockImplementation(async () => aaplRoundTrip());
    vi.mocked(getHistory).mockRejectedValue(new Error("no permissions"));
    const h = await getPnlHistory(DAYS);
    expect(h.errors).toEqual([{ symbol: "AAPL", message: "no permissions" }]);
    expect(h.series[0].realized).toBe(100);
    expect(h.series[0].points.at(-1)?.value).toBe(100);
  });

  it("includes open positions that have no trades in the window", async () => {
    vi.mocked(getPortfolio).mockResolvedValue({
      account: "U1",
      balances: {},
      positions: [
        { symbol: "MSFT", conId: 2, position: 10, avgCost: 90, marketPrice: 100, marketValue: 1000 },
      ],
    });
    vi.mocked(getHistory).mockResolvedValue(bars(100, 100));
    const h = await getPnlHistory(DAYS);
    expect(h.series).toHaveLength(1);
    expect(h.series[0]).toMatchObject({ symbol: "MSFT", closed: false, unrealized: 100 });
  });

  it("restates foreign-currency series in the base currency", async () => {
    vi.mocked(flex.getFlexTrades).mockImplementation(async () =>
      aaplRoundTrip().map((t) => ({ ...t, symbol: "VOLV", currency: "SEK" })),
    );
    vi.mocked(getHistory).mockResolvedValue(bars(100, 110, 105));
    vi.mocked(getFxRates).mockResolvedValue({ at: () => 0.1 });
    const h = await getPnlHistory(DAYS);
    expect(vi.mocked(getFxRates)).toHaveBeenCalledWith("SEK", "USD", "30 D");
    expect(h.series[0].realized).toBeCloseTo(10);
    expect(h.errors).toEqual([]);
  });

  it("flags a series it could not convert", async () => {
    vi.mocked(flex.getFlexTrades).mockImplementation(async () =>
      aaplRoundTrip().map((t) => ({ ...t, symbol: "VOLV", currency: "SEK" })),
    );
    vi.mocked(getHistory).mockResolvedValue(bars(100, 110, 105));
    vi.mocked(getFxRates).mockResolvedValue(null);
    const h = await getPnlHistory(DAYS);
    expect(h.series[0].realized).toBe(100);
    expect(h.errors[0].message).toMatch(/not comparable/);
  });

  it("serves repeat requests from the response cache", async () => {
    await getPnlHistory(DAYS);
    await getPnlHistory(DAYS);
    expect(vi.mocked(flex.getFlexTrades)).toHaveBeenCalledTimes(1);
    invalidatePnlCache();
    await getPnlHistory(DAYS);
    expect(vi.mocked(flex.getFlexTrades)).toHaveBeenCalledTimes(2);
  });
});
