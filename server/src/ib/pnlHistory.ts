import { resolveContract } from "./contracts.js";
import { getHistory, type HistoryBar } from "./marketData.js";
import { getPortfolio } from "./portfolio.js";
import { getFlexTrades, flexConfigured, tradesAsOf, type FlexTrade } from "./flex.js";

export interface PnlPoint {
  /** UNIX seconds (UTC), daily resolution. */
  time: number;
  /** Cumulative P&L (realized + unrealized) in the instrument's currency. */
  value: number;
  /** Market value of the open position that day (signed; 0 when flat/unknown). */
  mv: number;
}

export interface PnlSeries {
  key: string;
  symbol: string;
  secType?: string;
  currency?: string;
  /** True when the position is currently closed (flex mode only). */
  closed?: boolean;
  realized?: number;
  unrealized?: number;
  total: number;
  /** Total cost deployed opening lots (fallback %-denominator). */
  costBasis?: number;
  points: PnlPoint[];
}

export interface PnlHistory {
  series: PnlSeries[];
  errors: { symbol: string; message: string }[];
  /** Epoch ms of the last successful Flex fetch backing this data. */
  tradesAsOf?: number;
  /** True when this is a stale response and a recompute is running in the background. */
  refreshing?: boolean;
}

const DAY = 86_400;
const EPS = 1e-9;

/** Map a day span onto an IBKR duration string. */
function toDuration(days: number): string {
  if (days <= 365) return `${Math.max(days, 1)} D`;
  return `${Math.ceil(days / 365)} Y`;
}

/** Run tasks with bounded concurrency (IBKR historical-data pacing). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- FIFO trade replay (flex mode) ---

interface Lot {
  /** Signed quantity: positive = long lot, negative = short lot. */
  qty: number;
  /** Cost per unit at open. */
  cost: number;
}

interface ReplayState {
  lots: Lot[];
  realized: number;
  /** Cumulative |cost| of opened lots — the capital put at risk. */
  deployed: number;
}

function applyTrade(state: ReplayState, t: FlexTrade): void {
  state.realized += t.commission; // ibCommission is negative (a cost)
  let remaining = t.quantity;
  while (Math.abs(remaining) > EPS) {
    const lot = state.lots[0];
    if (!lot || Math.sign(lot.qty) === Math.sign(remaining)) {
      // Same direction (or flat) — opens a new lot.
      state.lots.push({ qty: remaining, cost: t.price });
      state.deployed += Math.abs(remaining) * t.price * t.multiplier;
      return;
    }
    // Opposite direction — closes against the oldest lot (FIFO).
    const closeQty = Math.min(Math.abs(remaining), Math.abs(lot.qty));
    state.realized +=
      closeQty * (lot.qty > 0 ? t.price - lot.cost : lot.cost - t.price) * t.multiplier;
    lot.qty -= Math.sign(lot.qty) * closeQty;
    remaining -= Math.sign(remaining) * closeQty;
    if (Math.abs(lot.qty) < EPS) state.lots.shift();
  }
}

function unrealizedAt(state: ReplayState, close: number, multiplier: number): number {
  let sum = 0;
  for (const lot of state.lots) sum += lot.qty * (close - lot.cost) * multiplier;
  return sum;
}

function marketValueAt(state: ReplayState, close: number, multiplier: number): number {
  let sum = 0;
  for (const lot of state.lots) sum += lot.qty * close * multiplier;
  return sum;
}

/**
 * Replay a symbol's trades against its daily closes, producing the cumulative
 * (realized + unrealized) P&L at the end of each day.
 */
function replaySeries(trades: FlexTrade[], bars: HistoryBar[]): {
  points: PnlPoint[];
  realized: number;
  unrealized: number;
  deployed: number;
} {
  const state: ReplayState = { lots: [], realized: 0, deployed: 0 };
  const multiplier = trades[0]?.multiplier ?? 1;
  const points: PnlPoint[] = [];
  let ti = 0;
  let lastClose = 0;

  for (const bar of bars) {
    // Apply every trade up to the end of this bar's calendar day.
    while (ti < trades.length && trades[ti].time < bar.time + DAY) {
      applyTrade(state, trades[ti]);
      ti++;
    }
    lastClose = bar.close;
    points.push({
      time: bar.time,
      value: state.realized + unrealizedAt(state, bar.close, multiplier),
      mv: marketValueAt(state, bar.close, multiplier),
    });
  }
  // Trades newer than the last bar (e.g. today's fills before the daily bar exists).
  while (ti < trades.length) {
    applyTrade(state, trades[ti]);
    ti++;
  }
  const unrealized = unrealizedAt(state, lastClose, multiplier);
  if (points.length > 0) {
    const last = points[points.length - 1];
    last.value = state.realized + unrealized;
    last.mv = marketValueAt(state, lastClose, multiplier);
  }
  return { points, realized: state.realized, unrealized, deployed: state.deployed };
}

/** Flat fallback when price history is unavailable (e.g. delisted symbols). */
function flatSeries(trades: FlexTrade[], startTime: number, endTime: number): {
  points: PnlPoint[];
  realized: number;
  unrealized: number;
  deployed: number;
} {
  const state: ReplayState = { lots: [], realized: 0, deployed: 0 };
  for (const t of trades) applyTrade(state, t);
  // Without prices, unrealized on any still-open lots is unknowable — realized only.
  const start = Math.max(startTime, trades[0]?.time ?? startTime);
  const points: PnlPoint[] =
    start < endTime
      ? [
          { time: start, value: state.realized, mv: 0 },
          { time: endTime, value: state.realized, mv: 0 },
        ]
      : [{ time: endTime, value: state.realized, mv: 0 }];
  return { points, realized: state.realized, unrealized: 0, deployed: state.deployed };
}

async function flexHistory(days: number): Promise<PnlHistory> {
  // Forex conversions (assetCategory CASH) are funding, not investments.
  const trades = (await getFlexTrades()).filter((t) => t.secType !== "CASH");
  const nowSec = Math.floor(Date.now() / 1000);
  const startTime = nowSec - days * DAY;

  const groups = new Map<string, FlexTrade[]>();
  for (const t of trades) {
    const key = t.conId != null ? `c${t.conId}` : `s${t.symbol}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  // Flex queries only cover their configured windows, so positions opened
  // before the earliest window are missing (or under-counted) in the replay.
  // Seed each current position whose quantity isn't explained by flex trades
  // with a synthetic opening lot at IB's blended avg cost.
  try {
    const { positions } = await getPortfolio();
    for (const p of positions) {
      if (!p.symbol) continue;
      const key = p.conId != null ? `c${p.conId}` : `s${p.symbol}`;
      const group = groups.get(key) ?? [];
      const replayedQty = group.reduce((q, t) => q + t.quantity, 0);
      const missing = p.position - replayedQty;
      if (Math.abs(missing) < EPS) continue;
      // Flex trades record pre-split quantities/prices while IB's bars and the
      // current position are split-adjusted. A position that is an exact
      // integer multiple (or divisor, for reverse splits) of the replayed
      // quantity is a split, not missing shares — rescale the trades instead
      // of seeding phantom ones. Realized $ amounts are unchanged by this.
      if (Math.abs(replayedQty) > EPS && Math.sign(replayedQty) === Math.sign(p.position)) {
        const ratio = p.position / replayedQty;
        const fwd = Math.round(ratio);
        const rev = Math.round(1 / ratio);
        if (fwd >= 2 && Math.abs(ratio - fwd) < 0.01 * fwd) {
          for (const t of group) {
            t.quantity *= fwd;
            t.price /= fwd;
          }
          continue;
        }
        if (rev >= 2 && Math.abs(1 / ratio - rev) < 0.01 * rev) {
          for (const t of group) {
            t.quantity /= rev;
            t.price *= rev;
          }
          continue;
        }
      }
      const multiplier =
        p.marketPrice && p.marketValue && p.position
          ? Math.round((p.marketValue / (p.marketPrice * p.position)) * 100) / 100 || 1
          : 1;
      const earliest = group[0]?.time ?? nowSec;
      group.unshift({
        symbol: p.symbol,
        conId: p.conId,
        secType: p.secType,
        currency: p.currency,
        multiplier,
        time: Math.min(startTime, earliest) - DAY,
        quantity: missing,
        price: (p.avgCost ?? 0) / multiplier,
        commission: 0,
      });
      groups.set(key, group);
    }
  } catch {
    // Portfolio unavailable — chart still covers flex-known symbols.
  }

  const errors: { symbol: string; message: string }[] = [];
  const series = await mapLimit([...groups.entries()], 3, async ([key, ts]) => {
    const { symbol, conId, secType, currency } = ts[0];
    let replay: ReturnType<typeof flatSeries>;
    try {
      const bars = await getHistory({
        contract: resolveContract({ conId, symbol, currency }),
        barSize: "1 day",
        duration: toDuration(days),
        useRTH: true,
      });
      replay = replaySeries(ts, bars.filter((b) => b.time >= startTime));
      if (replay.points.length === 0) replay = flatSeries(ts, startTime, nowSec);
    } catch (err) {
      errors.push({ symbol, message: err instanceof Error ? err.message : String(err) });
      replay = flatSeries(ts, startTime, nowSec);
    }
    const open = Math.abs(
      ts.reduce((q, t) => q + t.quantity, 0),
    ) > EPS;
    return {
      key,
      symbol,
      secType,
      currency,
      closed: !open,
      realized: replay.realized,
      unrealized: replay.unrealized,
      total: replay.realized + replay.unrealized,
      costBasis: replay.deployed,
      points: replay.points,
    } satisfies PnlSeries;
  });

  return { series: sortSeries(series), errors, tradesAsOf: await tradesAsOf() };
}

function sortSeries(series: PnlSeries[]): PnlSeries[] {
  return series.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// --- entry point with a short response cache (the UI polls) ---

const PNL_TTL_MS = 60_000;
const responseCache = new Map<number, { data: PnlHistory; fetchedAt: number }>();

/** Drop cached responses (after a forced trade refresh). */
export function invalidatePnlCache(): void {
  responseCache.clear();
}

/**
 * Per-symbol P&L history from real trade data only. Throws when the Flex
 * Query isn't configured or its fetch fails — no synthetic fallback.
 */
export async function getPnlHistory(days: number): Promise<PnlHistory> {
  if (!flexConfigured()) {
    const err = new Error(
      "Trade history requires an IBKR Flex Query — set IB_FLEX_TOKEN and IB_FLEX_QUERY_ID on the server",
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
  const cached = responseCache.get(days);
  if (cached && performance.now() - cached.fetchedAt < PNL_TTL_MS) return cached.data;
  if (cached) {
    // Stale-while-revalidate: serve the previous result immediately and
    // recompute in the background so the P&L tab never blocks on IB.
    computeAndCache(days).catch((err) =>
      console.warn(
        `[pnl] background refresh failed days=${days}: ` +
          `${err instanceof Error ? err.message : err}`,
      ),
    );
    return { ...cached.data, refreshing: true };
  }
  // Nothing to serve yet (first request after startup) — must compute inline.
  return computeAndCache(days);
}

const inFlightCompute = new Map<number, Promise<PnlHistory>>();

function computeAndCache(days: number): Promise<PnlHistory> {
  const existing = inFlightCompute.get(days);
  if (existing) return existing;
  const promise = (async () => {
    const started = performance.now();
    console.log(`[pnl] computing history days=${days}`);
    const data = await flexHistory(days);
    console.log(
      `[pnl] history ready days=${days}: ${data.series.length} series, ` +
        `${data.errors.length} errors (${Math.round(performance.now() - started)}ms)`,
    );
    responseCache.set(days, { data, fetchedAt: performance.now() });
    return data;
  })().finally(() => inFlightCompute.delete(days));
  inFlightCompute.set(days, promise);
  return promise;
}
