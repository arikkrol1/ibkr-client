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
} as const;
