import type { GatewayLastAction, Health, RestartMode } from "../api";

/** What to tell the user right after a restart request is accepted. */
export function restartMessage(mode: RestartMode): string {
  return mode === "start"
    ? "Starting IB Gateway: approve the IB Key notification on your phone."
    : "Restarting IB Gateway: back in about a minute (falls back to a fresh IB Key login if not back in ~3 min).";
}

/** Status line for a restart in flight, from /api/health; null when idle. */
export function phaseMessage(phase: Health["gateway"]["phase"] | undefined): string | null {
  if (phase === "start") return "Logging in to IB Gateway: approve the IB Key notification on your phone.";
  if (phase === "restart") return "Restarting IB Gateway…";
  return null;
}

const VERBS: Record<GatewayLastAction["action"], string> = {
  reconnect: "Reconnect",
  restart: "Restart",
  start: "Start",
  fallback: "Fallback",
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
