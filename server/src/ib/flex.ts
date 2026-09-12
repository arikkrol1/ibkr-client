import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { config } from "../config.js";

/**
 * IBKR Flex Web Service client. Flex Queries are the only IBKR API surface that
 * exposes full historical trade data (the TWS socket API only reports the
 * current day's executions), so this is what powers per-symbol P&L history for
 * closed positions.
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

// Flex statement generation is slow and IBKR throttles requests, so cache the
// parsed trades for a while. After a failure, back off before retrying — the
// UI polls every minute, and hammering a throttled service escalates IBKR's
// throttle into a temporary "too many failed attempts" lockout.
const FLEX_TTL_MS = 15 * 60_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;
/**
 * IBKR's error-1025 lockout is account-scoped (a new token doesn't clear it)
 * and appears to renew on every further attempt — go quiet for hours.
 */
const LOCKOUT_COOLDOWN_MS = 3 * 3600_000;

/**
 * The cooldown must survive process restarts: tsx watch restarts the server on
 * every code save, and an in-memory cooldown would fire a fresh (lockout-
 * renewing) attempt each time. Persisted beside server/ (gitignored).
 */
const COOLDOWN_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../.flex-cooldown.json");

interface Cooldown {
  message: string;
  /** Epoch ms after which a retry is allowed. */
  until: number;
}

function loadCooldown(): Cooldown | null {
  try {
    const c = JSON.parse(readFileSync(COOLDOWN_FILE, "utf8")) as Cooldown;
    return typeof c.until === "number" && c.until > Date.now() ? c : null;
  } catch {
    return null;
  }
}

let cache: { trades: FlexTrade[]; fetchedAt: number } | null = null;
let cooldown: Cooldown | null = loadCooldown();
let inFlight: Promise<FlexTrade[]> | null = null;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchXml(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { "User-Agent": "ibkr-client" } });
  if (!res.ok) throw new Error(`Flex service HTTP ${res.status}`);
  return parser.parse(await res.text());
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

async function fetchQueryTrades(queryId: string): Promise<FlexTrade[]> {
  const { token } = config.flex;

  const send = await fetchXml(`${SEND_REQUEST_URL}?t=${token}&q=${queryId}&v=3`);
  const sendResp = (send.FlexStatementResponse ?? {}) as Record<string, unknown>;
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
    const stmt = await fetchXml(`${baseUrl}?q=${refCode}&t=${token}&v=3`);
    const err = (stmt.FlexStatementResponse ?? {}) as Record<string, unknown>;
    if (err.ErrorCode != null) {
      if (String(err.ErrorCode) === "1019") continue; // still generating
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
  throw new Error("Flex statement generation timed out");
}

/**
 * Fetch every configured query (typically one per 365-day window — the IBKR
 * cap) and merge, de-duplicating fills that appear in overlapping ranges.
 */
async function fetchTrades(): Promise<FlexTrade[]> {
  const merged = new Map<string, FlexTrade>();
  // Sequential on purpose: IBKR throttles concurrent Flex requests.
  for (const queryId of config.flex.queryIds) {
    for (const t of await fetchQueryTrades(queryId)) {
      const key =
        t.tradeId ?? `${t.conId ?? t.symbol}|${t.time}|${t.quantity}|${t.price}`;
      merged.set(key, t);
    }
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

/** Full trade history from the configured Flex Query (cached ~15 min). */
export async function getFlexTrades(): Promise<FlexTrade[]> {
  if (!flexConfigured()) throw new Error("Flex Query not configured");
  if (cache && performance.now() - cache.fetchedAt < FLEX_TTL_MS) return cache.trades;
  if (cooldown && Date.now() < cooldown.until) {
    const at = new Date(cooldown.until).toLocaleTimeString();
    throw new Error(`${cooldown.message} (next retry after ${at})`);
  }
  if (inFlight) return inFlight;
  inFlight = fetchTrades()
    .then((trades) => {
      cache = { trades, fetchedAt: performance.now() };
      cooldown = null;
      try {
        unlinkSync(COOLDOWN_FILE);
      } catch {
        // never existed — fine
      }
      return trades;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const ms = /too many failed attempts/i.test(message)
        ? LOCKOUT_COOLDOWN_MS
        : FAILURE_COOLDOWN_MS;
      cooldown = { message, until: Date.now() + ms };
      try {
        writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown));
      } catch {
        // in-memory cooldown still applies
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
