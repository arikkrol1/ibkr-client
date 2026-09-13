import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { config } from "../config.js";
import { getStorage, type StoredTrade } from "../storage/storage.js";

/**
 * IBKR Flex Web Service client. Flex Queries are the only IBKR API surface that
 * exposes full historical trade data (the TWS socket API only reports the
 * current day's executions), so this is what powers per-symbol P&L history for
 * closed positions.
 *
 * Trades are immutable, so everything fetched is persisted (raw XML + parsed
 * rows) and served from storage; IBKR is contacted at most once per
 * IB_FLEX_REFRESH_HOURS, behind a hard rate limiter — the service locks
 * accounts out ("too many failed attempts") when polled.
 *
 * Flow (v3 protocol):
 *   1. SendRequest?t=<token>&q=<queryId>&v=3  → <ReferenceCode> + <Url>
 *   2. GetStatement?q=<refCode>&t=<token>&v=3 → statement XML (poll until ready)
 */

const SEND_REQUEST_URL =
  "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest";

export interface FlexTrade {
  /** IBKR execution/trade id when the query includes it — used for de-dup. */
  tradeId?: string;
  symbol: string;
  conId?: number;
  secType?: string;
  currency?: string;
  /** Contract multiplier (1 for stocks). */
  multiplier: number;
  /** Execution time, UNIX seconds (UTC-ish; day resolution is what matters here). */
  time: number;
  /** Signed quantity: buys positive, sells negative. */
  quantity: number;
  /** Trade price per unit. */
  price: number;
  /** Commission — negative (a cost). */
  commission: number;
}

export function flexConfigured(): boolean {
  return Boolean(config.flex.token && config.flex.queryIds.length > 0);
}

// --- storage keys & pacing constants ---

const META_LAST_SUCCESS = "flex_last_success";
const META_COOLDOWN = "flex_cooldown";
const META_REQ_LAST = "flex_req_last_at";
const META_REQ_DAY = "flex_req_day";
const META_REQ_DAY_COUNT = "flex_req_day_count";

const FAILURE_COOLDOWN_MS = 10 * 60_000;
/**
 * IBKR's error-1025 lockout is account-scoped (a new token doesn't clear it)
 * and renews on every further attempt — go quiet for hours.
 */
const LOCKOUT_COOLDOWN_MS = 3 * 3600_000;
/** Hard limiter, independent of caches and callers: min gap between fetch cycles… */
const MIN_CYCLE_GAP_MS = 5 * 60_000;
/** …and max SendRequests per calendar day. */
const MAX_REQUESTS_PER_DAY = 20;

interface Cooldown {
  message: string;
  /** Epoch ms after which a retry is allowed. */
  until: number;
}

// One-time import of the pre-storage cooldown file into the meta table.
const LEGACY_COOLDOWN_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.flex-cooldown.json",
);
let migrated = false;
async function migrateLegacyCooldown(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    const raw = JSON.parse(readFileSync(LEGACY_COOLDOWN_FILE, "utf8")) as Cooldown;
    if (raw?.until > Date.now()) {
      await getStorage().setMeta(META_COOLDOWN, JSON.stringify(raw));
    }
    unlinkSync(LEGACY_COOLDOWN_FILE);
  } catch {
    // no legacy file
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "ibkr-client" } });
  if (!res.ok) throw new Error(`Flex service HTTP ${res.status}`);
  return res.text();
}

/** Parse Flex dateTime formats: "yyyyMMdd;HHmmss", "yyyy-MM-dd;HH:mm:ss", "yyyyMMdd". */
function parseFlexTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length < 8) return undefined;
  const y = Number(digits.slice(0, 4));
  const mo = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  const h = Number(digits.slice(8, 10) || 0);
  const mi = Number(digits.slice(10, 12) || 0);
  const s = Number(digits.slice(12, 14) || 0);
  const t = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  return Number.isFinite(t) ? t : undefined;
}

/** Collect every <Trade …/> element anywhere in the parsed statement tree. */
function collectTradeNodes(node: unknown, out: Record<string, string>[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectTradeNodes(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "Trade") {
      for (const t of Array.isArray(value) ? value : [value]) {
        if (t && typeof t === "object") out.push(t as Record<string, string>);
      }
    } else {
      collectTradeNodes(value, out);
    }
  }
}

function toTrade(a: Record<string, string>): (FlexTrade & { detail?: string }) | null {
  const symbol = a.symbol;
  const qtyRaw = Number(a.quantity);
  const price = Number(a.tradePrice);
  const time = parseFlexTime(a.dateTime ?? a.tradeDate);
  if (!symbol || !Number.isFinite(qtyRaw) || !Number.isFinite(price) || time == null) return null;

  // Flex usually signs quantity already (sells negative); buySell is the
  // authoritative direction when present.
  const quantity =
    a.buySell === "SELL" ? -Math.abs(qtyRaw) : a.buySell === "BUY" ? Math.abs(qtyRaw) : qtyRaw;
  if (quantity === 0) return null;

  const commission = Number(a.ibCommission);
  const multiplier = Number(a.multiplier);
  const conId = Number(a.conid);
  return {
    detail: a.levelOfDetail,
    tradeId: a.tradeID || a.transactionID || undefined,
    symbol,
    conId: Number.isFinite(conId) && conId > 0 ? conId : undefined,
    secType: a.assetCategory,
    currency: a.currency,
    multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
    time,
    quantity,
    price,
    commission: Number.isFinite(commission) ? commission : 0,
  };
}

function tradeKeyOf(t: FlexTrade): string {
  return t.tradeId ?? `${t.conId ?? t.symbol}|${t.time}|${t.quantity}|${t.price}`;
}

/**
 * Parse a Flex statement XML into trades. Returns null when the XML is a
 * "still generating" placeholder (error 1019); throws on other Flex errors.
 */
export function parseFlexStatementXml(xml: string): FlexTrade[] | null {
  const stmt = parser.parse(xml);
  const err = (stmt.FlexStatementResponse ?? {}) as Record<string, unknown>;
  if (err.ErrorCode != null) {
    if (String(err.ErrorCode) === "1019") return null; // still generating
    throw new Error(`Flex GetStatement failed: ${err.ErrorMessage ?? err.ErrorCode}`);
  }
  const nodes: Record<string, string>[] = [];
  collectTradeNodes(stmt, nodes);
  const all = nodes
    .map(toTrade)
    .filter((t): t is FlexTrade & { detail?: string } => t !== null);
  // A query can include both ORDER and EXECUTION detail for the same fills —
  // keep one level only (prefer executions) to avoid double counting.
  const executions = all.filter((t) => t.detail === "EXECUTION");
  const chosen = executions.length > 0 ? executions : all;
  return chosen.map(({ detail: _detail, ...t }) => t);
}

async function fetchQueryStatement(
  queryId: string,
): Promise<{ trades: FlexTrade[]; xml: string }> {
  const { token } = config.flex;

  const sendText = await fetchText(`${SEND_REQUEST_URL}?t=${token}&q=${queryId}&v=3`);
  const sendResp = (parser.parse(sendText).FlexStatementResponse ?? {}) as Record<string, unknown>;
  if (String(sendResp.Status) !== "Success") {
    throw new Error(
      `Flex SendRequest failed: ${sendResp.ErrorMessage ?? sendResp.ErrorCode ?? "unknown error"}`,
    );
  }
  const refCode = String(sendResp.ReferenceCode);
  const baseUrl = String(sendResp.Url);

  // Poll until the statement is generated (error 1019 = still in progress).
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await sleep(2000);
    const xml = await fetchText(`${baseUrl}?q=${refCode}&t=${token}&v=3`);
    const trades = parseFlexStatementXml(xml);
    if (trades == null) continue;
    return { trades, xml };
  }
  throw new Error("Flex statement generation timed out");
}

/**
 * Import a manually downloaded Flex statement XML (Client Portal → Flex
 * Queries → run with a custom date range — the only way past the web
 * service's 365-day lookback cap). Archives the raw XML and merges trades;
 * already-known tradeKeys are ignored, so overlapping statements are safe.
 */
export async function importFlexStatement(
  xml: string,
  label: string,
): Promise<{ parsed: number; inserted: number }> {
  const trades = parseFlexStatementXml(xml);
  if (trades == null) {
    throw new Error("XML is a pending-statement placeholder (Flex error 1019), not a statement");
  }
  const store = getStorage();
  await store.archiveFlexStatement(label, xml);
  const inserted = await store.upsertTrades(
    trades.map((t) => ({ ...t, tradeKey: tradeKeyOf(t) })),
  );
  return { parsed: trades.length, inserted };
}

async function activeCooldown(): Promise<Cooldown | null> {
  const raw = await getStorage().getMeta(META_COOLDOWN);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Cooldown;
    return c.until > Date.now() ? c : null;
  } catch {
    return null;
  }
}

/** Enforced before any IBKR contact, no matter who calls or what state was lost. */
async function reserveFetchCycle(requestCount: number): Promise<void> {
  const store = getStorage();
  const now = Date.now();
  const last = Number((await store.getMeta(META_REQ_LAST)) ?? 0);
  if (now - last < MIN_CYCLE_GAP_MS) {
    const at = new Date(last + MIN_CYCLE_GAP_MS).toLocaleTimeString();
    throw new Error(`Flex rate limit: next request allowed after ${at}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = (await store.getMeta(META_REQ_DAY)) === today;
  const used = sameDay ? Number((await store.getMeta(META_REQ_DAY_COUNT)) ?? 0) : 0;
  if (used + requestCount > MAX_REQUESTS_PER_DAY) {
    throw new Error("Flex rate limit: daily request budget exhausted — try again tomorrow");
  }
  await store.setMeta(META_REQ_LAST, String(now));
  await store.setMeta(META_REQ_DAY, today);
  await store.setMeta(META_REQ_DAY_COUNT, String(used + requestCount));
}

/**
 * One fetch cycle: every configured query (typically one per 365-day window —
 * the IBKR cap), archived raw and merged into the trades table.
 */
async function fetchAndStore(): Promise<void> {
  const store = getStorage();
  const cd = await activeCooldown();
  if (cd) {
    throw new Error(`${cd.message} (next retry after ${new Date(cd.until).toLocaleTimeString()})`);
  }
  await reserveFetchCycle(config.flex.queryIds.length);
  try {
    const statements: { queryId: string; xml: string }[] = [];
    const merged = new Map<string, StoredTrade>();
    for (const [i, queryId] of config.flex.queryIds.entries()) {
      if (i > 0) await sleep(2000); // be gentle between sequential queries
      const { trades, xml } = await fetchQueryStatement(queryId);
      statements.push({ queryId, xml });
      for (const t of trades) {
        const tradeKey = tradeKeyOf(t);
        merged.set(tradeKey, { ...t, tradeKey });
      }
    }
    for (const s of statements) await store.archiveFlexStatement(s.queryId, s.xml);
    await store.upsertTrades([...merged.values()]);
    await store.setMeta(META_LAST_SUCCESS, String(Date.now()));
    await store.deleteMeta(META_COOLDOWN);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = /too many failed attempts/i.test(message)
      ? LOCKOUT_COOLDOWN_MS
      : FAILURE_COOLDOWN_MS;
    await store.setMeta(META_COOLDOWN, JSON.stringify({ message, until: Date.now() + ms }));
    throw err;
  }
}

async function storedFlexTrades(): Promise<FlexTrade[]> {
  return (await getStorage().getAllTrades()).map(({ tradeKey: _k, ...t }) => t);
}

/** Epoch ms of the last successful Flex fetch, if any. */
export async function tradesAsOf(): Promise<number | undefined> {
  const v = await getStorage().getMeta(META_LAST_SUCCESS);
  return v ? Number(v) : undefined;
}

let inFlight: Promise<void> | null = null;

/**
 * Full trade history, served from storage. IBKR is contacted only when the
 * stored copy is older than IB_FLEX_REFRESH_HOURS (or `force`), and a failed
 * fetch falls back to the stored copy — stale real data beats an error.
 */
export async function getFlexTrades(opts?: { force?: boolean }): Promise<FlexTrade[]> {
  if (!flexConfigured()) throw new Error("Flex Query not configured");
  await migrateLegacyCooldown();
  const store = getStorage();

  const last = Number((await store.getMeta(META_LAST_SUCCESS)) ?? 0);
  const haveData = last > 0;
  const fresh = haveData && Date.now() - last < config.flex.refreshHours * 3600_000;
  if (fresh && !opts?.force) return storedFlexTrades();

  try {
    if (!inFlight) {
      inFlight = fetchAndStore().finally(() => {
        inFlight = null;
      });
    }
    await inFlight;
    return storedFlexTrades();
  } catch (err) {
    if (haveData && !opts?.force) return storedFlexTrades();
    throw err;
  }
}
