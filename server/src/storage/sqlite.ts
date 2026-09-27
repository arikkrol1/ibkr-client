import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Storage,
  StoredTrade,
  StoredBar,
  StoredAccountDay,
  StoredCashTransaction,
} from "./storage.js";

/** The only file in the codebase that knows SQL. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flex_statements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id   TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  xml        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  trade_key  TEXT PRIMARY KEY,
  symbol     TEXT    NOT NULL,
  con_id     INTEGER,
  sec_type   TEXT,
  currency   TEXT,
  multiplier REAL    NOT NULL DEFAULT 1,
  time       INTEGER NOT NULL,
  quantity   REAL    NOT NULL,
  price      REAL    NOT NULL,
  commission REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(time);

CREATE TABLE IF NOT EXISTS bars_daily (
  contract_key TEXT    NOT NULL,
  time         INTEGER NOT NULL,
  open   REAL NOT NULL,
  high   REAL NOT NULL,
  low    REAL NOT NULL,
  close  REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (contract_key, time)
);

CREATE TABLE IF NOT EXISTS account_days (
  date     INTEGER PRIMARY KEY,
  currency TEXT,
  nav      REAL,
  cash     REAL,
  stock    REAL,
  twr      REAL
);

CREATE TABLE IF NOT EXISTS cash_transactions (
  tx_key   TEXT PRIMARY KEY,
  time     INTEGER NOT NULL,
  type     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  symbol   TEXT,
  con_id   INTEGER,
  currency TEXT,
  amount   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_tx_time ON cash_transactions(time);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async archiveFlexStatement(queryId: string, xml: string): Promise<void> {
    this.db
      .prepare("INSERT INTO flex_statements (query_id, fetched_at, xml) VALUES (?, ?, ?)")
      .run(queryId, Date.now(), xml);
  }

  async upsertTrades(trades: StoredTrade[]): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO trades
         (trade_key, symbol, con_id, sec_type, currency, multiplier, time, quantity, price, commission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.transaction(() => {
      let inserted = 0;
      for (const t of trades) {
        const res = stmt.run(
          t.tradeKey,
          t.symbol,
          t.conId ?? null,
          t.secType ?? null,
          t.currency ?? null,
          t.multiplier,
          t.time,
          t.quantity,
          t.price,
          t.commission,
        );
        inserted += Number(res.changes);
      }
      return inserted;
    });
  }

  async getAllTrades(): Promise<StoredTrade[]> {
    const rows = this.db
      .prepare("SELECT * FROM trades ORDER BY time ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      tradeKey: String(r.trade_key),
      symbol: String(r.symbol),
      conId: r.con_id == null ? undefined : Number(r.con_id),
      secType: r.sec_type == null ? undefined : String(r.sec_type),
      currency: r.currency == null ? undefined : String(r.currency),
      multiplier: Number(r.multiplier),
      time: Number(r.time),
      quantity: Number(r.quantity),
      price: Number(r.price),
      commission: Number(r.commission),
    }));
  }

  async getDailyBars(contractKey: string, fromTime: number): Promise<StoredBar[]> {
    const rows = this.db
      .prepare(
        "SELECT time, open, high, low, close, volume FROM bars_daily WHERE contract_key = ? AND time >= ? ORDER BY time ASC",
      )
      .all(contractKey, fromTime) as Record<string, unknown>[];
    return rows.map((r) => ({
      time: Number(r.time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  }

  async upsertDailyBars(contractKey: string, bars: StoredBar[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO bars_daily (contract_key, time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const b of bars) stmt.run(contractKey, b.time, b.open, b.high, b.low, b.close, b.volume);
    });
  }

  async replaceDailyBars(contractKey: string, bars: StoredBar[]): Promise<void> {
    const del = this.db.prepare("DELETE FROM bars_daily WHERE contract_key = ?");
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO bars_daily (contract_key, time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      del.run(contractKey);
      for (const b of bars) ins.run(contractKey, b.time, b.open, b.high, b.low, b.close, b.volume);
    });
  }

  async upsertAccountDays(days: StoredAccountDay[]): Promise<number> {
    // Sections arrive in separate statements, so merge field-by-field rather
    // than replacing the row — COALESCE keeps whatever a later row omits.
    const stmt = this.db.prepare(
      `INSERT INTO account_days (date, currency, nav, cash, stock, twr)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         currency = COALESCE(excluded.currency, account_days.currency),
         nav      = COALESCE(excluded.nav,      account_days.nav),
         cash     = COALESCE(excluded.cash,     account_days.cash),
         stock    = COALESCE(excluded.stock,    account_days.stock),
         twr      = COALESCE(excluded.twr,      account_days.twr)`,
    );
    return this.transaction(() => {
      for (const d of days) {
        stmt.run(
          d.date,
          d.currency ?? null,
          d.nav ?? null,
          d.cash ?? null,
          d.stock ?? null,
          d.twr ?? null,
        );
      }
      return days.length;
    });
  }

  async getAccountDays(fromTime: number): Promise<StoredAccountDay[]> {
    return this.db
      .prepare(
        `SELECT date, currency, nav, cash, stock, twr
           FROM account_days WHERE date >= ? ORDER BY date`,
      )
      .all(fromTime) as unknown as StoredAccountDay[];
  }

  async upsertCashTransactions(rows: StoredCashTransaction[]): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO cash_transactions
         (tx_key, time, type, kind, symbol, con_id, currency, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.transaction(() => {
      let inserted = 0;
      for (const r of rows) {
        const res = stmt.run(
          r.txKey,
          r.time,
          r.type,
          r.kind,
          r.symbol ?? null,
          r.conId ?? null,
          r.currency ?? null,
          r.amount,
        );
        inserted += Number(res.changes ?? 0);
      }
      return inserted;
    });
  }

  async getCashTransactions(fromTime: number): Promise<StoredCashTransaction[]> {
    return this.db
      .prepare(
        `SELECT tx_key AS txKey, time, type, kind, symbol, con_id AS conId,
                currency, amount
           FROM cash_transactions WHERE time >= ? ORDER BY time`,
      )
      .all(fromTime) as unknown as StoredCashTransaction[];
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: unknown }
      | undefined;
    return row?.value == null ? null : String(row.value);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  async deleteMeta(key: string): Promise<void> {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
