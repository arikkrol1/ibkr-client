import {
  BarSizeSetting,
  WhatToShow,
  MarketDataType,
  type Contract,
  type Bar,
} from "@stoqey/ib";
import { Observable } from "rxjs";
import { ib } from "./connection.js";
import { getStorage } from "../storage/storage.js";

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

async function requestBars(p: HistoryParams): Promise<HistoryBar[]> {
  const raw: Bar[] = await ib.api.getHistoricalData(
    p.contract,
    "", // endDateTime "" = now
    p.duration,
    p.barSize as BarSizeSetting,
    WhatToShow.TRADES,
    p.useRTH ? 1 : 0,
    2, // formatDate=2 → epoch seconds
  );
  return raw
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
}

// --- head-timestamp fallback: IB rejects durations reaching past a contract's ---
// --- first bar (162 "failed to compute time length"), e.g. "50 Y" for a      ---
// --- recently listed stock. Clamp to the available span and retry once.      ---

const headTimeCache = new Map<string, number>();

/** Parse IB's head-timestamp string: epoch seconds or "yyyymmdd[-hh:mm:ss]". */
function parseIbTime(raw: string): number | undefined {
  const s = String(raw).trim();
  if (/^\d{9,}$/.test(s)) return Number(s);
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  return undefined;
}

/** Earliest available bar time (epoch seconds) for a contract, cached forever. */
async function getHeadTime(contract: Contract, useRTH: boolean): Promise<number | undefined> {
  const key = contractKeyOf(contract);
  const cached = headTimeCache.get(key);
  if (cached != null) return cached;
  try {
    const raw = await ib.api.getHeadTimestamp(contract, WhatToShow.TRADES, useRTH, 2);
    const t = parseIbTime(raw);
    if (t != null) headTimeCache.set(key, t);
    return t;
  } catch {
    return undefined;
  }
}

/**
 * Duration covering exactly the contract's available history, or undefined
 * when the requested duration already fits (no clamp needed).
 */
function clampedDuration(requested: string, headTime: number): string | undefined {
  const availableSec = Math.floor(Date.now() / 1000) - headTime;
  if (availableSec <= 0 || durationSeconds(requested) <= availableSec) return undefined;
  const days = Math.max(1, Math.ceil(availableSec / 86_400));
  // IB caps day-unit durations around a year; switch to years beyond that.
  return days <= 365 ? `${days} D` : `${Math.ceil(days / 365)} Y`;
}

async function fetchFromIb(p: HistoryParams): Promise<HistoryBar[]> {
  try {
    return await requestBars(p);
  } catch (err) {
    if (!/failed to compute time length/i.test(String((err as Error)?.message ?? err))) {
      throw err;
    }
    const headTime = await getHeadTime(p.contract, p.useRTH);
    const duration = headTime != null ? clampedDuration(p.duration, headTime) : undefined;
    if (duration == null) throw err;
    return requestBars({ ...p, duration });
  }
}

// --- daily-bar persistence: past prices are immutable, so store them and ---
// --- refetch from IB at most every few hours per contract               ---

const BARS_REFETCH_MS = 6 * 3600_000;

function contractKeyOf(c: Contract): string {
  return c.conId != null ? String(c.conId) : `${c.symbol}:${c.currency}:${c.exchange}`;
}

/** Approximate seconds covered by an IBKR duration string ("90 D", "2 Y", …). */
function durationSeconds(duration: string): number {
  const m = /^(\d+)\s*([SDWMY])/i.exec(duration.trim());
  if (!m) return 0;
  const mult: Record<string, number> = {
    S: 1,
    D: 86_400,
    W: 7 * 86_400,
    M: 31 * 86_400,
    Y: 366 * 86_400,
  };
  return Number(m[1]) * (mult[m[2].toUpperCase()] ?? 86_400);
}

async function getDailyHistory(p: HistoryParams): Promise<HistoryBar[]> {
  const store = getStorage();
  const key = contractKeyOf(p.contract);
  const fromTime = Math.floor(Date.now() / 1000) - durationSeconds(p.duration);

  // Serve from storage when we've already fetched at least this span recently.
  const coveredFrom = Number(
    (await store.getMeta(`bars_span:${key}`)) ?? Number.POSITIVE_INFINITY,
  );
  const fetchedAt = Number((await store.getMeta(`bars_fetched_at:${key}`)) ?? 0);
  if (coveredFrom <= fromTime && Date.now() - fetchedAt < BARS_REFETCH_MS) {
    return store.getDailyBars(key, fromTime);
  }

  const bars = await fetchFromIb(p);
  if (bars.length > 0) {
    // Split-safety: IB rewrites history on stock splits. If the fresh fetch
    // disagrees with stored closes on overlapping days, rebuild the contract.
    const stored = await store.getDailyBars(key, fromTime);
    const freshByTime = new Map(bars.map((b) => [b.time, b]));
    const mismatch = stored.some((s) => {
      const f = freshByTime.get(s.time);
      return f != null && s.close > 0 && Math.abs(f.close - s.close) / s.close > 0.005;
    });
    if (mismatch) {
      await store.replaceDailyBars(key, bars);
      await store.setMeta(`bars_span:${key}`, String(fromTime));
    } else {
      await store.upsertDailyBars(key, bars);
      await store.setMeta(`bars_span:${key}`, String(Math.min(coveredFrom, fromTime)));
    }
    await store.setMeta(`bars_fetched_at:${key}`, String(Date.now()));
    // Serve from storage: it may hold a wider span than this fetch returned.
    const merged = await store.getDailyBars(key, fromTime);
    if (merged.length > 0) return merged;
  }
  return bars;
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
    // Daily bars are persisted (immutable history); intraday stays fetch-through.
    const bars =
      p.barSize === "1 day" ? await getDailyHistory(p) : await fetchFromIb(p);
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
