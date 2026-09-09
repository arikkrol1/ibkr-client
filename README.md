# IBKR Client

A local, read-only web client for viewing **charts/quotes** and **portfolio insights**
from your Interactive Brokers account — a friendlier face than the TWS desktop UI.

- **Backend:** Node + TypeScript + Fastify, talking to IB Gateway/TWS via
  [`@stoqey/ib`](https://github.com/stoqey/ib) (`IBApiNext`).
- **Frontend:** React + Vite + Tailwind + TradingView
  [`lightweight-charts`](https://tradingview.github.io/lightweight-charts/) v5.
- **Scope:** read-only. No orders are ever placed (and the *Read-Only API* toggle
  below enforces it at the gateway).

```
IB Gateway (127.0.0.1:4001) ──socket──> Node/Fastify backend ──REST+WS──> React UI
```

## 1. One-time IBKR setup

You need a local connector running — there is no gateway-less path for retail
accounts. **IB Gateway** is the lightweight, headless choice (recommended over full
TWS). Install it, log into your **live** account, then:

**Configure → Settings → API → Settings**
- ✅ Enable ActiveX and Socket Clients
- Socket port = **4001** (live). Paper trading = 4002.
- Trusted IPs → add **127.0.0.1**
- ✅ **Read-Only API** (blocks any order — matches this app's scope)

> Prefer full TWS? It works unchanged — just set `IB_PORT=7496` (live) / `7497` (paper).

> **Market data:** realtime quotes require an active market-data subscription on the
> account. Without one, set `IB_MARKET_DATA_TYPE=3` to use IBKR's delayed feed — the
> UI clearly badges quotes/charts as **DELAYED**.

> IB Gateway auto-restarts daily; the backend reconnects automatically.

## 2. Install & run

```bash
npm install

# Dev (two processes, hot reload):
npm run dev:server   # backend on http://127.0.0.1:4010
npm run dev:web      # UI on http://127.0.0.1:5173  (proxies /api + /ws to backend)

# …or production single-origin:
npm run build
npm start            # serves API + built UI on http://127.0.0.1:4010
```

Open **http://127.0.0.1:5173** (dev) or **http://127.0.0.1:4010** (prod).

## 3. Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4010` | Backend HTTP/WS port |
| `IB_HOST` | `127.0.0.1` | Gateway/TWS host |
| `IB_PORT` | `4001` | 4001/4002 (Gateway live/paper), 7496/7497 (TWS live/paper) |
| `IB_CLIENT_ID` | `10` | API client id |
| `IB_MARKET_DATA_TYPE` | `1` | 1=realtime, 3=delayed, 2/4=frozen variants |
| `IB_RECONNECT_MS` | `5000` | Auto-reconnect interval |

## 4. API surface

- `GET /api/health` — connection + market-data-type status
- `GET /api/search?q=AAPL` — symbol lookup
- `GET /api/history?symbol=AAPL&barSize=1%20day&duration=6%20M` — candlestick bars
- `GET /api/portfolio` — positions, balances, PnL
- `WS  /ws/quotes` — send `{"type":"subscribe","symbol":"AAPL"}`; receive `{type:"quote",…}`

## 5. Verify end-to-end

With IB Gateway running + logged in:

```bash
curl localhost:4010/api/health                    # connected:true, marketDataType
curl "localhost:4010/api/search?q=AAPL"           # matching contracts
curl "localhost:4010/api/history?symbol=AAPL&barSize=1%20day&duration=6%20M"
curl localhost:4010/api/portfolio                 # your positions/balances
```

Then in the browser: search **AAPL** → candlestick chart + live/DELAYED quote header;
open **Dashboard** → positions, balances, P&L, allocation (cross-check against TWS).
