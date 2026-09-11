import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load the project-root .env (two levels up from server/src or server/dist).
// The server runs with cwd=server/, so dotenv's default lookup would miss it.
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../.env"),
  quiet: true,
});

/**
 * Runtime configuration. All values can be overridden with env vars so the same
 * build can point at IB Gateway (live 4001 / paper 4002) or TWS (7496 / 7497).
 */
export const config = {
  /** HTTP/WS port this backend listens on. */
  httpPort: Number(process.env.PORT ?? 4010),

  ib: {
    host: process.env.IB_HOST ?? "127.0.0.1",
    /** IB Gateway live=4001, paper=4002; TWS live=7496, paper=7497. */
    port: Number(process.env.IB_PORT ?? 4001),
    /** Fixed client id so reconnects are clean and don't collide with TWS internals. */
    clientId: Number(process.env.IB_CLIENT_ID ?? 10),
    /** Auto-reconnect interval (ms) handled by IBApiNext. 0 disables. */
    reconnectInterval: Number(process.env.IB_RECONNECT_MS ?? 5000),
    /**
     * Preferred market data type. REALTIME(1) needs a live subscription; if you
     * don't have one, set IB_MARKET_DATA_TYPE=3 (DELAYED) to still see quotes.
     */
    marketDataType: Number(process.env.IB_MARKET_DATA_TYPE ?? 1),
  },

  /**
   * IBKR Flex Web Service credentials (Account Management → Performance &
   * Reports → Flex Queries). When set, the P&L tab uses the account's full
   * trade history — including closed positions. When empty, the server falls
   * back to approximating P&L from current positions only.
   *
   * IBKR caps each Flex query at a 365-day window, so IB_FLEX_QUERY_ID takes a
   * comma-separated list of query ids (one per custom year range); their trades
   * are merged and de-duplicated.
   */
  flex: {
    token: process.env.IB_FLEX_TOKEN ?? "",
    queryIds: (process.env.IB_FLEX_QUERY_ID ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
} as const;
