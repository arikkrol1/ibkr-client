import {
  BarSizeSetting,
  WhatToShow,
  MarketDataType,
  type Contract,
  type Bar,
} from "@stoqey/ib";
import { Observable } from "rxjs";
import { ib } from "./connection.js";

/**
 * Stable IBKR tick-type protocol constants. The package's `TickType` is only a
 * type alias at the root (the enum value isn't re-exported), so we pin the few
 * numeric codes we consume. Delayed codes (66+) arrive when marketDataType=DELAYED.
 */
const Tick = {
  BID: 1,
  ASK: 2,
  LAST: 4,
  HIGH: 6,
  LOW: 7,
  VOLUME: 8,
  CLOSE: 9,
  DELAYED_BID: 66,
  DELAYED_ASK: 67,
  DELAYED_LAST: 68,
  DELAYED_HIGH: 72,
  DELAYED_LOW: 73,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
} as const;

export interface HistoryBar {
  /** UNIX seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoryParams {
  contract: Contract;
  /** e.g. "1 day", "1 hour", "5 mins" */
  barSize: string;
  /** e.g. "6 M", "1 Y", "5 D" */
  duration: string;
  useRTH: boolean;
}

// --- historical bars: cache + in-flight de-dupe to respect IBKR pacing ---

interface CacheEntry {
  bars: HistoryBar[];
  fetchedAt: number;
}
const HISTORY_TTL_MS = 30_000;
const historyCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<HistoryBar[]>>();

function cacheKey(p: HistoryParams): string {
  const c = p.contract;
  const id = c.conId ?? `${c.symbol}:${c.currency}:${c.exchange}`;
  return `${id}|${p.barSize}|${p.duration}|${p.useRTH}`;
}

// Cheap monotonic-ish clock without Date.now (fine for TTL comparisons).
function now(): number {
  return performance.now();
}

/**
 * IB ignores formatDate=2 for daily-and-larger bars and returns "yyyymmdd"
 * strings; intraday bars come back as epoch seconds. Normalize to epoch.
 */
function barTime(raw: string | number): number {
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) {
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))) / 1000;
  }
  return Number(raw);
}

export async function getHistory(p: HistoryParams): Promise<HistoryBar[]> {
  const key = cacheKey(p);

  const cached = historyCache.get(key);
  if (cached && now() - cached.fetchedAt < HISTORY_TTL_MS) {
    return cached.bars;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const raw: Bar[] = await ib.api.getHistoricalData(
      p.contract,
      "", // endDateTime "" = now
      p.duration,
      p.barSize as BarSizeSetting,
      WhatToShow.TRADES,
      p.useRTH ? 1 : 0,
      2, // formatDate=2 → epoch seconds
    );
    const bars = raw
      .filter((b) => b.time != null && b.close != null)
      .map<HistoryBar>((b) => ({
        time: barTime(b.time as string | number),
        open: b.open ?? b.close ?? 0,
        high: b.high ?? b.close ?? 0,
        low: b.low ?? b.close ?? 0,
        close: b.close ?? 0,
        volume: b.volume ?? 0,
      }))
      .sort((a, b) => a.time - b.time);
    historyCache.set(key, { bars, fetchedAt: now() });
    return bars;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

// --- streaming quotes: normalize realtime + delayed tick types into one shape ---

export interface Quote {
  last?: number;
  bid?: number;
  ask?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  /** true when values are sourced from delayed tick types. */
  delayed: boolean;
}

/** Fold a MarketDataTicks map (realtime OR delayed tick types) into a Quote. */
export function ticksToQuote(ticks: ReadonlyMap<number, { value?: number }>): Quote {
  const q: Quote = { delayed: false };
  const valid = (v?: number): v is number => v != null && v !== -1;
  for (const [type, tick] of ticks) {
    const v = tick.value;
    if (!valid(v)) continue;
    switch (type) {
      case Tick.LAST:
        q.last = v;
        break;
      case Tick.DELAYED_LAST:
        q.last = v;
        q.delayed = true;
        break;
      case Tick.BID:
        q.bid = v;
        break;
      case Tick.DELAYED_BID:
        q.bid = v;
        q.delayed = true;
        break;
      case Tick.ASK:
        q.ask = v;
        break;
      case Tick.DELAYED_ASK:
        q.ask = v;
        q.delayed = true;
        break;
      case Tick.HIGH:
      case Tick.DELAYED_HIGH:
        q.high = v;
        break;
      case Tick.LOW:
      case Tick.DELAYED_LOW:
        q.low = v;
        break;
      case Tick.CLOSE:
      case Tick.DELAYED_CLOSE:
        q.close = v;
        break;
      case Tick.VOLUME:
      case Tick.DELAYED_VOLUME:
        q.volume = v;
        break;
      default:
        break;
    }
  }
  return q;
}

/** Observable of streaming market data for a contract. */
export function streamQuote(contract: Contract): Observable<Quote> {
  const wantsDelayed =
    ib.marketDataType === MarketDataType.DELAYED ||
    ib.marketDataType === MarketDataType.DELAYED_FROZEN;
  return new Observable<Quote>((subscriber) => {
    const sub = ib.api.getMarketData(contract, "", false, false).subscribe({
      next: (update) => {
        const q = ticksToQuote(update.all);
        if (wantsDelayed) q.delayed = true;
        subscriber.next(q);
      },
      error: (err) => subscriber.error(err),
    });
    return () => sub.unsubscribe();
  });
}
