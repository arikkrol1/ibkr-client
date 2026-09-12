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

export interface PnlHistory {
  series: PnlSeries[];
  errors: { symbol: string; message: string }[];
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
};
