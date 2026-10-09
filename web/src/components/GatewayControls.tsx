import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useHealth } from "../hooks/useHealth";
import { lastActionText, restartMessage } from "../utils/gateway";

/**
 * Reconnect / Restart Gateway buttons plus a one-line status. Used in the
 * connection banner (when disconnected) and in the header's Gateway menu.
 */
export function GatewayControls({ showLastAction = false }: { showLastAction?: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useHealth();
  const gateway = data?.gateway;
  const [busy, setBusy] = useState<"reconnect" | "restart" | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  const run = async (kind: "reconnect" | "restart") => {
    setBusy(kind);
    setNote(null);
    try {
      if (kind === "restart") {
        const { mode } = await api.ibRestart();
        setNote({ text: restartMessage(mode) });
      } else {
        await api.ibReconnect();
        setNote({ text: "Reconnecting to IB Gateway…" });
      }
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  const restarting = gateway?.restarting ?? false;
  const last = showLastAction ? lastActionText(gateway?.lastAction ?? null, Date.now()) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => run("reconnect")} disabled={busy !== null}>
        {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
      </Button>
      {gateway?.restartEnabled && (
        <Button onClick={() => run("restart")} disabled={busy !== null || restarting}>
          {busy === "restart" || restarting ? "Restarting…" : "Restart Gateway"}
        </Button>
      )}
      {note && <span className={note.error ? "text-red-300" : ""}>{note.text}</span>}
      {!note && last && <span className="text-gray-400">{last}</span>}
    </div>
  );
}

/** Header dropdown so Gateway can be restarted even while it looks connected. */
export function GatewayMenu() {
  const ref = useRef<HTMLDetailsElement>(null);

  // Close when tapping/clicking outside.
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <details ref={ref} className="relative ml-auto">
      <summary className="cursor-pointer list-none rounded-md px-3 py-1.5 text-sm font-medium text-gray-400 hover:bg-gray-900 hover:text-gray-200">
        ⋯ Gateway
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-gray-800 bg-[#0b0e11] p-3 text-sm shadow-lg">
        <GatewayControls showLastAction />
      </div>
    </details>
  );
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-current/40 px-2.5 py-1 text-xs font-medium hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
