// Typed client for the backend REST API. All requests go through the Vite proxy
// (dev) or same origin (prod), so paths are relative.

export interface Health {
  ok: boolean;
  ib: {
    connected: boolean;
    state: string;
    connectedOnce: boolean;
    host: string;
    port: number;
    clientId: number;
    marketDataType: string;
    isDelayed: boolean;
    lastError: string | null;
  };
}

export interface SymbolMatch {
  conId?: number;
  symbol?: string;
  name?: string;
  secType?: string;
  currency?: string;
  primaryExch?: string;
}

export interface SymbolInfo {
  conId?: number;
  symbol?: string;
  longName?: string;
  secType?: string;
  /** IBKR stock classification, e.g. "COMMON", "ETF", "ETN", "ADR". */
  stockType?: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  currency?: string;
  primaryExch?: string;
}

export interface HistoryBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoryResponse {
  contract: { symbol?: string; conId?: number };
  isDelayed: boolean;
  bars: HistoryBar[];
}

export interface PortfolioPosition {
  conId?: number;
  symbol?: string;
  secType?: string;
  currency?: string;
  position: number;
  avgCost?: number;
  marketPrice?: number;
  marketValue?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
}

export interface Portfolio {
  account: string | null;
  balances: {
    netLiquidation?: number;
    totalCashValue?: number;
    buyingPower?: number;
    grossPositionValue?: number;
    availableFunds?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
  };
  dailyPnL?: number;
  positions: PortfolioPosition[];
}

export interface PnlPoint {
  time: number;
  value: number;
  /** Market value of the open position that day (signed; 0 when flat). */
  mv: number;
}

export interface PnlSeries {
  key: string;
  symbol: string;
  secType?: string;
  currency?: string;
  closed?: boolean;
  realized?: number;
  unrealized?: number;
  total: number;
  costBasis?: number;
  points: PnlPoint[];
}

/** A day of account-level state, when the Flex query reports one. */
export interface AccountDay {
  /** UTC midnight, UNIX seconds. */
  time: number;
  nav?: number;
  cash?: number;
  stock?: number;
  /** IBKR's own time-weighted return for that day, in percent. */
  twr?: number;
}

/** Non-trade P&L: dividends, interest, withholding, fees. */
export interface IncomeEntry {
  time: number;
  type: string;
  symbol?: string;
  /** Base currency; negative for withholding and fees. */
  amount: number;
}

export interface PnlHistory {
  series: PnlSeries[];
  /** Empty until the Flex query includes a NAV section. */
  accountDays: AccountDay[];
  /** Empty until the Flex query includes Cash Transactions. */
  income: IncomeEntry[];
  errors: { symbol: string; message: string }[];
  /** Epoch ms of the last successful trade-history fetch. */
  tradesAsOf?: number;
  /** True when this is a stale response and the server is recomputing in the background. */
  refreshing?: boolean;
}

export interface ActivityTrade {
  /** Execution time, UNIX seconds. */
  time: number;
  side: "buy" | "sell";
  /** Absolute share count, split-adjusted to match the bars. */
  quantity: number;
  /** Fill price, split-adjusted to match the bars. */
  price: number;
}

export interface SymbolActivity {
  symbol: string;
  conId?: number;
  currency?: string;
  /** Every buy/sell, oldest first. */
  trades: ActivityTrade[];
  /** The most recent fill. */
  last: ActivityTrade;
  /** Shares held now (signed; 0 when closed). */
  position: number;
  /** True while a position is still held. */
  open: boolean;
  /** Daily bars covering at least the whole trade history. */
  bars: HistoryBar[];
  /** Set when the bars couldn't be fetched. */
  error?: string;
}

export interface Activity {
  /** Newest last activity first. */
  symbols: SymbolActivity[];
  /** Epoch ms of the last successful trade-history fetch. */
  tradesAsOf?: number;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  health: () => getJSON<Health>("/api/health"),
  search: (q: string) =>
    getJSON<{ matches: SymbolMatch[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  symbolInfo: (params: { symbol?: string; conId?: number }) => {
    const qs = new URLSearchParams();
    if (params.symbol) qs.set("symbol", params.symbol);
    if (params.conId) qs.set("conId", String(params.conId));
    return getJSON<SymbolInfo>(`/api/symbol-info?${qs.toString()}`);
  },
  history: (params: { symbol?: string; conId?: number; barSize: string; duration: string }) => {
    const qs = new URLSearchParams();
    if (params.symbol) qs.set("symbol", params.symbol);
    if (params.conId) qs.set("conId", String(params.conId));
    qs.set("barSize", params.barSize);
    qs.set("duration", params.duration);
    return getJSON<HistoryResponse>(`/api/history?${qs.toString()}`);
  },
  portfolio: () => getJSON<Portfolio>("/api/portfolio"),
  pnl: (days: number) => getJSON<PnlHistory>(`/api/pnl?days=${days}`),
  activity: () => getJSON<Activity>("/api/activity"),
  pnlRefresh: async (): Promise<{ ok: boolean; tradesAsOf?: number }> => {
    const res = await fetch("/api/pnl/refresh", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
};
