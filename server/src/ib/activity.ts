import { resolveContract } from "./contracts.js";
import { getFlexTrades, tradesAsOf, type FlexTrade } from "./flex.js";
import { getHistory, type HistoryBar } from "./marketData.js";
import { mapLimit, rescaleSplits, toDuration } from "./pnlHistory.js";
import { getPortfolio, type PortfolioPosition } from "./portfolio.js";

const DAY = 86_400;
/** Always fetch at least this much history so the 3Y view is filled. */
const MIN_HISTORY_DAYS = 3 * 365;
/** Lead-in before a symbol's first trade, so that trade isn't on the edge. */
const LEAD_IN_DAYS = 30;
const EPS = 1e-9;

export interface ActivityTrade {
  /** Execution time, UNIX seconds. */
  time: number;
  side: "buy" | "sell";
  /** Absolute share count (split-adjusted to match the bars). */
  quantity: number;
  /** Fill price (split-adjusted to match the bars). */
  price: number;
}

export interface SymbolActivity {
  symbol: string;
  conId?: number;
  currency?: string;
  /** Every buy/sell, oldest first. */
  trades: ActivityTrade[];
  /** The most recent fill — drives the horizontal line and the sort order. */
  last: ActivityTrade;
  /** Shares held now (signed; 0 when the position is closed). */
  position: number;
  /** True while a position is still held. */
  open: boolean;
  /** Daily bars covering at least the whole trade history. */
  bars: HistoryBar[];
  /** Set when the bars couldn't be fetched; trades are still returned. */
  error?: string;
}

export interface Activity {
  /** Newest last activity first. */
  symbols: SymbolActivity[];
  /** Epoch ms of the last successful Flex fetch, if any. */
  tradesAsOf?: number;
}

export interface TradeGroup {
  symbol: string;
  conId?: number;
  currency?: string;
  /** Oldest first. */
  trades: FlexTrade[];
}

/**
 * Stock trades grouped per contract, ordered by each group's last trade
 * (newest first, ties by symbol). Non-stock activity — FX conversions,
 * zero-quantity rows — is left out.
 */
export function groupActivity(trades: FlexTrade[]): TradeGroup[] {
  const groups = new Map<string, TradeGroup>();
  for (const t of trades) {
    if (t.secType !== "STK" || t.quantity === 0) continue;
    const key = t.conId != null ? `c${t.conId}` : `s${t.symbol}`;
    let g = groups.get(key);
    if (!g) {
      g = { symbol: t.symbol, conId: t.conId, currency: t.currency, trades: [] };
      groups.set(key, g);
    }
    g.trades.push({ ...t });
  }
  const lastTime = (g: TradeGroup) => g.trades[g.trades.length - 1].time;
  return [...groups.values()]
    .map((g) => ({ ...g, trades: g.trades.sort((a, b) => a.time - b.time) }))
    .sort((a, b) => lastTime(b) - lastTime(a) || a.symbol.localeCompare(b.symbol));
}

export function toActivityTrade(t: FlexTrade): ActivityTrade {
  return {
    time: t.time,
    side: t.quantity > 0 ? "buy" : "sell",
    quantity: Math.abs(t.quantity),
    price: t.price,
  };
}

/** Days of daily bars to fetch so the chart covers every trade of the group. */
export function historyDays(firstTradeTime: number, nowSec: number): number {
  const sinceFirst = Math.ceil((nowSec - firstTradeTime) / DAY) + LEAD_IN_DAYS;
  return Math.max(MIN_HISTORY_DAYS, sinceFirst);
}

/**
 * Shares currently held for a traded contract. IB's live positions are the
 * truth — they're matched by conId first, because tickers get renamed (e.g.
 * on a listing change). Without a portfolio, fall back to the net of the
 * split-adjusted trades.
 */
export function currentPosition(
  g: TradeGroup,
  positions: PortfolioPosition[] | null,
): number {
  if (positions) {
    const p =
      positions.find((p) => g.conId != null && p.conId === g.conId) ??
      positions.find((p) => p.conId == null && p.symbol === g.symbol);
    return p?.position ?? 0;
  }
  const net = g.trades.reduce((q, t) => q + t.quantity, 0);
  return Math.abs(net) <= EPS ? 0 : net;
}

/** Every symbol with buy/sell activity, its trades, and daily bars to chart them on. */
export async function getActivity(): Promise<Activity> {
  const groups = groupActivity(await getFlexTrades());
  const nowSec = Math.floor(Date.now() / 1000);
  let positions: PortfolioPosition[] | null = null;
  try {
    positions = (await getPortfolio()).positions;
  } catch {
    // Portfolio unavailable — open/closed falls back to the trade net.
  }

  const symbols = await mapLimit(groups, 3, async (g): Promise<SymbolActivity> => {
    let bars: HistoryBar[] = [];
    let error: string | undefined;
    try {
      bars = await getHistory({
        contract: resolveContract({ conId: g.conId, symbol: g.symbol, currency: g.currency }),
        barSize: "1 day",
        duration: toDuration(historyDays(g.trades[0].time, nowSec)),
        useRTH: true,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Fills are recorded as executed but bars are split-adjusted — bring the
    // fills onto the bars' scale so the line and markers sit on the price.
    rescaleSplits(g.trades, bars, g.symbol);
    const trades = g.trades.map(toActivityTrade);
    const position = currentPosition(g, positions);
    return {
      symbol: g.symbol,
      conId: g.conId,
      currency: g.currency,
      trades,
      last: trades[trades.length - 1],
      position,
      open: position !== 0,
      bars,
      ...(error ? { error } : {}),
    };
  });

  return { symbols, tradesAsOf: await tradesAsOf() };
}
