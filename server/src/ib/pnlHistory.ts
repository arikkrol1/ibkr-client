import { resolveContract } from "./contracts.js";
import { getHistory, type HistoryBar } from "./marketData.js";
import { getPortfolio, type PortfolioPosition } from "./portfolio.js";
import { getFlexTrades, flexConfigured, tradesAsOf, type FlexTrade } from "./flex.js";
import { getFxRates, type FxRates } from "./fx.js";
import { config } from "../config.js";

export interface PnlPoint {
  /** UNIX seconds (UTC), daily resolution. */
  time: number;
  /** Cumulative P&L (realized + unrealized), in the account's base currency. */
  value: number;
  /** Market value of the open position that day (signed; 0 when flat/unknown). */
  mv: number;
}

export interface PnlSeries {
  key: string;
  symbol: string;
  secType?: string;
  /** The instrument's own quote currency (P&L below is in the account's base). */
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

/** Largest split ratio treated as real — beyond this it's more likely bad data. */
const MAX_SPLIT = 50;
/** A fill can sit a few % off its day's close; split ratios are ≥ 2 apart. */
const PRICE_SPLIT_TOL = 0.05;
/** Share counts are exact, so the quantity-based fallback can be strict. */
const QTY_SPLIT_TOL = 0.01;

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

/**
 * Flat fallback when price history is unavailable (e.g. delisted symbols, or a
 * contract this account has no market-data permission for). Without prices,
 * unrealized on any still-open lots is unknowable — realized only. The curve
 * steps at each closing trade rather than carrying the final total from the
 * first point, so a realized loss lands in the month it was actually taken.
 */
function flatSeries(trades: FlexTrade[], startTime: number, endTime: number): {
  points: PnlPoint[];
  realized: number;
  unrealized: number;
  deployed: number;
} {
  const state: ReplayState = { lots: [], realized: 0, deployed: 0 };
  const points: PnlPoint[] = [];
  let i = 0;
  // Fold anything before the window into the opening point.
  while (i < trades.length && trades[i].time < startTime) applyTrade(state, trades[i++]);
  points.push({ time: Math.min(startTime, endTime), value: state.realized, mv: 0 });
  for (; i < trades.length; i++) {
    applyTrade(state, trades[i]);
    const time = Math.min(trades[i].time, endTime);
    const last = points[points.length - 1];
    if (time <= last.time) last.value = state.realized;
    else points.push({ time, value: state.realized, mv: 0 });
  }
  if (points[points.length - 1].time < endTime) {
    points.push({ time: endTime, value: state.realized, mv: 0 });
  }
  return { points, realized: state.realized, unrealized: 0, deployed: state.deployed };
}

/**
 * Split factor implied by `ratio`, or 1 when it doesn't look like a split.
 * The convention is the same for both callers: multiply quantities by the
 * factor and divide prices by it. Forward splits give an integer ≥ 2, reverse
 * splits its reciprocal; anything else (a fill a few % off the day's close, an
 * odd 3-for-2 ratio) is left alone rather than guessed at.
 */
function splitFactor(ratio: number, tol: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const fwd = Math.round(ratio);
  if (fwd >= 2 && fwd <= MAX_SPLIT && Math.abs(ratio - fwd) <= tol * fwd) return fwd;
  const rev = Math.round(1 / ratio);
  if (rev >= 2 && rev <= MAX_SPLIT && Math.abs(1 / ratio - rev) <= tol * rev) return 1 / rev;
  return 1;
}

/**
 * Flex records fills as executed, while IB's daily bars are split-adjusted —
 * so every trade that predates a split is off by the split factor on both
 * quantity and price. Detect it per trade by comparing the fill against that
 * day's close and rescale in place.
 *
 * This runs off prices rather than the current position, so it also fixes
 * symbols that are now flat: a closed position has no quantity left to compare
 * against, and an unrescaled one nets to a phantom short that keeps marking
 * P&L forever. Realized $ amounts are unchanged (quantity × price is
 * invariant), only their timing and the share counts in between.
 */
function rescaleSplits(trades: FlexTrade[], bars: HistoryBar[], symbol: string): void {
  if (bars.length === 0) return;
  let b = 0;
  for (const t of trades) {
    // Both lists are time-ascending — walk to the bar covering the trade's day.
    while (b < bars.length && bars[b].time + DAY <= t.time) b += 1;
    const bar = bars[b];
    // No bar for that day (holiday, or the trade predates the window) — the
    // ratio would be meaningless, so leave the trade as it is.
    if (!bar || t.time < bar.time || bar.close <= 0 || t.price <= 0) continue;
    const factor = splitFactor(t.price / bar.close, PRICE_SPLIT_TOL);
    if (factor === 1) continue;
    console.log(
      `[pnl] ${symbol}: rescaling ${new Date(t.time * 1000).toISOString().slice(0, 10)} ` +
        `fill for a ${factor >= 1 ? `${factor}:1` : `1:${Math.round(1 / factor)}`} split`,
    );
    t.quantity *= factor;
    t.price /= factor;
  }
}

/**
 * Flex queries only cover their configured windows, so positions opened before
 * the earliest window are missing (or under-counted) in the replay. Seed the
 * unexplained quantity with a synthetic opening lot at IB's blended avg cost.
 */
function seedMissing(
  group: FlexTrade[],
  p: PortfolioPosition,
  startTime: number,
  nowSec: number,
): void {
  const replayedQty = group.reduce((q, t) => q + t.quantity, 0);
  const missing = p.position - replayedQty;
  if (Math.abs(missing) < EPS) return;
  // Fallback for when bars were unavailable and `rescaleSplits` couldn't run:
  // a position that is an exact integer multiple (or divisor) of the replayed
  // quantity is a split, not missing shares.
  if (Math.abs(replayedQty) > EPS && Math.sign(replayedQty) === Math.sign(p.position)) {
    const factor = splitFactor(p.position / replayedQty, QTY_SPLIT_TOL);
    if (factor !== 1) {
      for (const t of group) {
        t.quantity *= factor;
        t.price /= factor;
      }
      return;
    }
  }
  const multiplier =
    p.marketPrice && p.marketValue && p.position
      ? Math.round((p.marketValue / (p.marketPrice * p.position)) * 100) / 100 || 1
      : 1;
  const earliest = group[0]?.time ?? nowSec;
  group.unshift({
    symbol: p.symbol ?? "",
    conId: p.conId,
    secType: p.secType,
    currency: p.currency,
    multiplier,
    time: Math.min(startTime, earliest) - DAY,
    quantity: missing,
    price: (p.avgCost ?? 0) / multiplier,
    commission: 0,
  });
}

/**
 * Restate a foreign-currency instrument in the account's base currency, at the
 * rate on each day. Converting the inputs rather than the output means the FIFO
 * replay runs natively in base: a lot opened at one rate and closed at another
 * realizes the FX move too, which is what actually happened to the account.
 */
function toBaseCurrency(
  trades: FlexTrade[],
  bars: HistoryBar[],
  rates: FxRates,
): { trades: FlexTrade[]; bars: HistoryBar[] } {
  return {
    trades: trades.map((t) => {
      const r = rates.at(t.time);
      return { ...t, price: t.price * r, commission: t.commission * r };
    }),
    bars: bars.map((b) => {
      const r = rates.at(b.time);
      return { ...b, open: b.open * r, high: b.high * r, low: b.low * r, close: b.close * r };
    }),
  };
}

async function flexHistory(days: number): Promise<PnlHistory> {
  // Forex conversions (assetCategory CASH) are funding, not investments.
  const trades = (await getFlexTrades()).filter((t) => t.secType !== "CASH");
  const nowSec = Math.floor(Date.now() / 1000);
  const startTime = nowSec - days * DAY;

  interface ContractRef {
    symbol: string;
    conId?: number;
    secType?: string;
    currency?: string;
  }

  const groups = new Map<string, FlexTrade[]>();
  const contracts = new Map<string, ContractRef>();
  for (const t of trades) {
    const key = t.conId != null ? `c${t.conId}` : `s${t.symbol}`;
    const list = groups.get(key);
    if (list) {
      list.push(t);
    } else {
      groups.set(key, [t]);
      contracts.set(key, { symbol: t.symbol, conId: t.conId, secType: t.secType, currency: t.currency });
    }
  }

  // Current positions both seed pre-window history and tell us a symbol is
  // flat — which the trade replay on its own can't prove.
  const positionByKey = new Map<string, PortfolioPosition>();
  try {
    const { positions } = await getPortfolio();
    for (const p of positions) {
      if (!p.symbol) continue;
      const key = p.conId != null ? `c${p.conId}` : `s${p.symbol}`;
      positionByKey.set(key, p);
      if (!groups.has(key)) {
        groups.set(key, []);
        contracts.set(key, { symbol: p.symbol, conId: p.conId, secType: p.secType, currency: p.currency });
      }
    }
  } catch {
    // Portfolio unavailable — chart still covers flex-known symbols.
  }

  const errors: { symbol: string; message: string }[] = [];
  const series = await mapLimit([...groups.keys()], 3, async (key) => {
    const ts = groups.get(key) ?? [];
    const { symbol, conId, secType, currency } = contracts.get(key)!;
    let bars: HistoryBar[] = [];
    try {
      bars = await getHistory({
        contract: resolveContract({ conId, symbol, currency }),
        barSize: "1 day",
        duration: toDuration(days),
        useRTH: true,
      });
    } catch (err) {
      errors.push({ symbol, message: err instanceof Error ? err.message : String(err) });
    }

    // Both passes rewrite quantities, so they have to run before the replay —
    // and in this order: seeding measures the gap against the current position,
    // which is only comparable once the trades are split-adjusted.
    rescaleSplits(ts, bars, symbol);
    const position = positionByKey.get(key);
    if (position) seedMissing(ts, position, startTime, nowSec);

    const netQty = ts.reduce((q, t) => q + t.quantity, 0);
    if (!position && Math.abs(netQty) > EPS) {
      // Nothing left to reconcile against: the replay thinks it still holds
      // shares IB doesn't report, so the trade history has a gap and the
      // leftover lots will mark P&L forever. Surface it rather than silently
      // carrying a phantom position.
      console.warn(
        `[pnl] ${symbol}: ${netQty.toFixed(2)} unmatched shares with no open ` +
          `position — trade history looks incomplete`,
      );
    }

    // Restate in base currency before the replay, so every series the UI sums
    // together is denominated the same way.
    let priced = ts;
    let quotes = bars;
    if (currency && currency !== config.baseCurrency) {
      const rates = await getFxRates(currency, config.baseCurrency, toDuration(days));
      if (rates) {
        ({ trades: priced, bars: quotes } = toBaseCurrency(ts, bars, rates));
      } else {
        errors.push({
          symbol,
          message:
            `No ${currency}/${config.baseCurrency} rate available — P&L for ${symbol} ` +
            `is shown in ${currency} and is not comparable to the rest of the account`,
        });
      }
    }

    let replay = quotes.length > 0
      ? replaySeries(priced, quotes.filter((b) => b.time >= startTime))
      : flatSeries(priced, startTime, nowSec);
    if (replay.points.length === 0) replay = flatSeries(priced, startTime, nowSec);

    return {
      key,
      symbol,
      secType,
      currency,
      closed: Math.abs(netQty) <= EPS,
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
