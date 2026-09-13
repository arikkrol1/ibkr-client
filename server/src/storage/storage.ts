import { config } from "../config.js";
import { SqliteStorage } from "./sqlite.js";

/**
 * Domain-level persistence contract. Consumers (flex, market data) speak
 * trades/bars/meta — never SQL — so swapping the database means implementing
 * this interface in one new driver file and pointing DB_DRIVER at it.
 *
 * All methods are async even where the current driver is synchronous, so a
 * networked database (Postgres, Turso, …) can implement them unchanged.
 */

export interface StoredTrade {
  /** Stable dedup key: Flex tradeID, else a conId|time|qty|price composite. */
  tradeKey: string;
  symbol: string;
  conId?: number;
  secType?: string;
  currency?: string;
  multiplier: number;
  /** Execution time, UNIX seconds (UTC). */
  time: number;
  /** Signed quantity: buys positive, sells negative. */
  quantity: number;
  price: number;
  /** Negative = cost. */
  commission: number;
}

export interface StoredBar {
  /** Bar day, UNIX seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Storage {
  /** Append-only archive of raw Flex statement XML (re-parse insurance). */
  archiveFlexStatement(queryId: string, xml: string): Promise<void>;

  /** Insert trades, ignoring already-known tradeKeys. Returns # newly inserted. */
  upsertTrades(trades: StoredTrade[]): Promise<number>;
  /** All trades, sorted by time ascending. */
  getAllTrades(): Promise<StoredTrade[]>;

  /** Daily bars for a contract from `fromTime` onward, sorted by time. */
  getDailyBars(contractKey: string, fromTime: number): Promise<StoredBar[]>;
  upsertDailyBars(contractKey: string, bars: StoredBar[]): Promise<void>;
  /** Drop and rewrite a contract's bars (split-adjustment repair). */
  replaceDailyBars(contractKey: string, bars: StoredBar[]): Promise<void>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;

  close(): Promise<void>;
}

let instance: Storage | null = null;

export function getStorage(): Storage {
  if (instance) return instance;
  if (config.db.driver === "sqlite") {
    instance = new SqliteStorage(config.db.sqlitePath);
    return instance;
  }
  throw new Error(`Unknown DB_DRIVER "${config.db.driver}" (valid: sqlite)`);
}
