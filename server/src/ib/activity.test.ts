import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./flex.js", () => ({
  getFlexTrades: vi.fn(async () => []),
  tradesAsOf: vi.fn(async () => 1_700_000_000_000),
}));
vi.mock("./marketData.js", () => ({ getHistory: vi.fn(async () => []) }));
vi.mock("./portfolio.js", () => ({
  getPortfolio: vi.fn(async () => ({ account: "U1", balances: {}, positions: [] })),
}));
vi.mock("./contracts.js", () => ({ resolveContract: vi.fn((p: unknown) => p) }));

import type { FlexTrade } from "./flex.js";
import { getFlexTrades } from "./flex.js";
import { getHistory, type HistoryBar } from "./marketData.js";
import { getPortfolio } from "./portfolio.js";
import {
  currentPosition,
  getActivity,
  groupActivity,
  historyDays,
  toActivityTrade,
} from "./activity.js";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 6) / 1000;

function trade(p: Partial<FlexTrade> & { time: number; quantity: number; price: number }): FlexTrade {
  return { symbol: "AAPL", conId: 1, secType: "STK", multiplier: 1, commission: 0, ...p };
}

function bar(time: number, close: number): HistoryBar {
  return { time, open: close, high: close, low: close, close, volume: 0 };
}

afterEach(() => vi.clearAllMocks());

describe("groupActivity", () => {
  it("groups by contract and orders by last trade, newest first", () => {
    const groups = groupActivity([
      trade({ symbol: "AAPL", conId: 1, time: T0, quantity: 10, price: 100 }),
      trade({ symbol: "MSFT", conId: 2, time: T0 + DAY, quantity: 5, price: 400 }),
      trade({ symbol: "AAPL", conId: 1, time: T0 + 2 * DAY, quantity: -4, price: 110 }),
      trade({ symbol: "NVDA", conId: 3, time: T0 - DAY, quantity: 1, price: 50 }),
    ]);
    expect(groups.map((g) => g.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(groups[0].trades.map((t) => t.time)).toEqual([T0, T0 + 2 * DAY]);
  });

  it("breaks last-trade ties by symbol", () => {
    const groups = groupActivity([
      trade({ symbol: "ZZZ", conId: 9, time: T0, quantity: 1, price: 1 }),
      trade({ symbol: "AAA", conId: 8, time: T0, quantity: 1, price: 1 }),
    ]);
    expect(groups.map((g) => g.symbol)).toEqual(["AAA", "ZZZ"]);
  });

  it("drops FX conversions and zero-quantity rows", () => {
    const groups = groupActivity([
      trade({ symbol: "EUR.USD", conId: 5, secType: "CASH", time: T0, quantity: 100, price: 1.1 }),
      trade({ symbol: "AAPL", time: T0, quantity: 0, price: 100 }),
    ]);
    expect(groups).toEqual([]);
  });

  it("falls back to the symbol when there's no conId, and sorts unsorted input", () => {
    const groups = groupActivity([
      trade({ symbol: "XYZ", conId: undefined, time: T0 + DAY, quantity: -1, price: 2 }),
      trade({ symbol: "XYZ", conId: undefined, time: T0, quantity: 1, price: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].trades.map((t) => t.price)).toEqual([1, 2]);
  });

  it("doesn't mutate the input trades", () => {
    const input = [trade({ time: T0, quantity: 10, price: 100 })];
    groupActivity(input)[0].trades[0].price = 1;
    expect(input[0].price).toBe(100);
  });
});

describe("toActivityTrade", () => {
  it("maps the sign onto a side and keeps the size positive", () => {
    expect(toActivityTrade(trade({ time: T0, quantity: 3, price: 10 }))).toEqual({
      time: T0, side: "buy", quantity: 3, price: 10,
    });
    expect(toActivityTrade(trade({ time: T0, quantity: -3, price: 10 }))).toEqual({
      time: T0, side: "sell", quantity: 3, price: 10,
    });
  });
});

describe("historyDays", () => {
  it("fetches at least three years", () => {
    expect(historyDays(T0 - 10 * DAY, T0)).toBe(3 * 365);
  });

  it("reaches back past the first trade when it's older", () => {
    expect(historyDays(T0 - 2000 * DAY, T0)).toBe(2030);
  });
});

describe("currentPosition", () => {
  const group = groupActivity([
    trade({ symbol: "SLNA", conId: 7, time: T0, quantity: 100, price: 1 }),
  ])[0];

  it("matches live positions by conId, even after a ticker rename", () => {
    expect(currentPosition(group, [{ symbol: "SLNAF", conId: 7, position: 100 }])).toBe(100);
  });

  it("is 0 when IB reports no position", () => {
    expect(currentPosition(group, [{ symbol: "AAPL", conId: 1, position: 5 }])).toBe(0);
  });

  it("falls back to the symbol for positions without a conId", () => {
    expect(currentPosition(group, [{ symbol: "SLNA", position: 3 }])).toBe(3);
  });

  it("nets the trades when the portfolio is unavailable", () => {
    expect(currentPosition(group, null)).toBe(100);
    const flat = groupActivity([
      trade({ time: T0, quantity: 10, price: 1 }),
      trade({ time: T0 + DAY, quantity: -10, price: 2 }),
    ])[0];
    expect(currentPosition(flat, null)).toBe(0);
  });
});

describe("getActivity", () => {
  it("returns the last fill, split-adjusted onto the bars' scale", async () => {
    vi.mocked(getFlexTrades).mockResolvedValue([
      trade({ symbol: "NVDA", conId: 3, time: T0 + 3600, quantity: 2, price: 1000 }),
      trade({ symbol: "NVDA", conId: 3, time: T0 + DAY + 3600, quantity: -5, price: 102 }),
      trade({ symbol: "AAPL", conId: 1, time: T0 + 3600, quantity: 1, price: 200 }),
    ]);
    // 10:1 split between the two NVDA fills.
    vi.mocked(getHistory).mockImplementation(async (p) =>
      (p.contract as { symbol: string }).symbol === "NVDA"
        ? [bar(T0, 99), bar(T0 + DAY, 101)]
        : [bar(T0, 200)],
    );

    const { symbols, tradesAsOf } = await getActivity();
    expect(tradesAsOf).toBe(1_700_000_000_000);
    expect(symbols.map((s) => s.symbol)).toEqual(["NVDA", "AAPL"]);
    expect(symbols[0].trades[0]).toEqual({ time: T0 + 3600, side: "buy", quantity: 20, price: 100 });
    expect(symbols[0].last).toEqual({ time: T0 + DAY + 3600, side: "sell", quantity: 5, price: 102 });
    expect(symbols[0].bars).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ position: 0, open: false });
    expect(getHistory).toHaveBeenCalledWith(
      expect.objectContaining({ barSize: "1 day", duration: expect.stringMatching(/ Y$/) }),
    );
  });

  it("marks symbols open from the live portfolio", async () => {
    vi.mocked(getFlexTrades).mockResolvedValue([trade({ time: T0, quantity: 10, price: 200 })]);
    vi.mocked(getPortfolio).mockResolvedValueOnce({
      account: "U1",
      balances: {},
      positions: [{ symbol: "AAPL", conId: 1, position: 10 }],
    } as Awaited<ReturnType<typeof getPortfolio>>);
    const { symbols } = await getActivity();
    expect(symbols[0]).toMatchObject({ position: 10, open: true });
  });

  it("falls back to the trade net when the portfolio fails", async () => {
    vi.mocked(getFlexTrades).mockResolvedValue([trade({ time: T0, quantity: 10, price: 200 })]);
    vi.mocked(getPortfolio).mockRejectedValueOnce(new Error("not connected"));
    const { symbols } = await getActivity();
    expect(symbols[0]).toMatchObject({ position: 10, open: true });
  });

  it("still returns the trades when the bars can't be fetched", async () => {
    vi.mocked(getFlexTrades).mockResolvedValue([trade({ time: T0, quantity: 1, price: 200 })]);
    vi.mocked(getHistory).mockRejectedValue(new Error("pacing violation"));

    const { symbols } = await getActivity();
    expect(symbols[0]).toMatchObject({
      symbol: "AAPL",
      bars: [],
      error: "pacing violation",
      last: { side: "buy", price: 200 },
    });
  });
});
