import type { GatewayLastAction, RestartMode } from "../api";

/** What to tell the user right after a restart request is accepted. */
export function restartMessage(mode: RestartMode): string {
  return mode === "start"
    ? "Starting IB Gateway: approve the IB Key notification on your phone."
    : "Restarting IB Gateway: back in about a minute.";
}

const VERBS: Record<GatewayLastAction["action"], string> = {
  reconnect: "Reconnect",
  restart: "Restart",
  start: "Start",
};

/** "Restart 3 min ago", or the failure message, for the header menu. */
export function lastActionText(last: GatewayLastAction | null, now: number): string | null {
  if (!last) return null;
  const verb = VERBS[last.action];
  if (!last.ok) return `${verb} failed: ${last.message ?? "unknown error"}`;
  return `${verb} ${ago(now - last.at)}`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
