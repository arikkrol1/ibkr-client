import {
  IBApiNext,
  ConnectionState,
  MarketDataType,
  type IBApiNextError,
} from "@stoqey/ib";
import { config } from "../config.js";

/**
 * Owns the single, long-lived connection to IB Gateway / TWS.
 *
 * IBApiNext has built-in auto-reconnect (via `reconnectInterval`), so we don't
 * hand-roll backoff — we just observe the connection state and (re)apply the
 * market-data type each time we (re)connect. This transparently survives IB
 * Gateway's daily restart.
 */
class IbConnection {
  readonly api: IBApiNext;

  private _state: ConnectionState = ConnectionState.Disconnected;
  private _lastError: string | null = null;
  private _connectedOnce = false;
  /** The market-data type actually in effect (may differ from requested). */
  private _marketDataType: MarketDataType = config.ib.marketDataType as MarketDataType;

  constructor() {
    this.api = new IBApiNext({
      host: config.ib.host,
      port: config.ib.port,
      reconnectInterval: config.ib.reconnectInterval,
    });

    this.api.connectionState.subscribe((state) => {
      this._state = state;
      if (state === ConnectionState.Connected) {
        this._connectedOnce = true;
        this._lastError = null;
        // Re-apply on every (re)connect — the setting is per-session.
        this.api.setMarketDataType(this._marketDataType);
        console.log(
          `[ib] connected ${config.ib.host}:${config.ib.port} clientId=${config.ib.clientId} ` +
            `marketDataType=${MarketDataType[this._marketDataType]}`,
        );
      } else {
        console.log(`[ib] connection state: ${ConnectionState[state]}`);
      }
    });

    // Connection-level errors surface here (get-function observables also emit their own).
    this.api.error.subscribe((err: IBApiNextError) => {
      // Codes 2104/2106/2158 are benign "market data farm connected" info messages.
      const benign = [2104, 2106, 2158, 2107, 2119];
      if (benign.includes(err.code)) return;
      this._lastError = `${err.code}: ${err.error?.message ?? err.error}`;
      console.warn(`[ib] error ${this._lastError}`);
    });
  }

  connect(): void {
    this.api.connect(config.ib.clientId);
  }

  disconnect(): void {
    this.api.disconnect();
  }

  /** Drop and reopen the API socket (e.g. a stale session). Gateway itself is untouched. */
  reconnect(): void {
    this.api.disconnect();
    setTimeout(() => this.connect(), 1000);
  }

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === ConnectionState.Connected;
  }

  get marketDataType(): MarketDataType {
    return this._marketDataType;
  }

  /** Snapshot for the /api/health endpoint. */
  health() {
    return {
      connected: this.isConnected,
      state: ConnectionState[this._state],
      connectedOnce: this._connectedOnce,
      host: config.ib.host,
      port: config.ib.port,
      clientId: config.ib.clientId,
      marketDataType: MarketDataType[this._marketDataType],
      isDelayed:
        this._marketDataType === MarketDataType.DELAYED ||
        this._marketDataType === MarketDataType.DELAYED_FROZEN,
      lastError: this._lastError,
    };
  }
}

/** Process-wide singleton. */
export const ib = new IbConnection();
