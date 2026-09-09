import { useEffect, useRef, useState } from "react";

export interface Quote {
  last?: number;
  bid?: number;
  ask?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  delayed: boolean;
}

/**
 * Streams a live/delayed quote for a single symbol over the /ws/quotes socket.
 * Reconnects automatically and re-subscribes when the symbol changes.
 */
export function useQuote(symbol: string | null): Quote | null {
  const [quote, setQuote] = useState<Quote | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef<string | null>(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    setQuote(null);
    if (!symbol) return;

    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/quotes`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", symbol }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "quote" && msg.symbol === symbolRef.current) {
            setQuote(msg.quote);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "unsubscribe", symbol }));
      }
      ws?.close();
    };
  }, [symbol]);

  return quote;
}
