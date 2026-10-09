import { useHealth } from "../hooks/useHealth";
import { GatewayControls } from "./GatewayControls";

/** Slim status strip: shows IB connection health + delayed-data warning. */
export function ConnectionBanner() {
  const { data, isError } = useHealth();
  const ib = data?.ib;

  if (isError || !data) {
    return (
      <Bar tone="red">Backend unreachable — is the server running on :4010?</Bar>
    );
  }

  if (!ib?.connected) {
    return (
      <Bar tone="amber">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>
            Not connected to IB Gateway ({ib?.host}:{ib?.port}).{" "}
            {data.gateway?.restartEnabled
              ? "Reconnect, or restart Gateway via IBC."
              : "Launch IB Gateway, log in, and enable the API."}{" "}
            {ib?.lastError ? `(${ib.lastError})` : ""}
          </span>
          <GatewayControls />
        </div>
      </Bar>
    );
  }

  if (ib.isDelayed) {
    return (
      <Bar tone="amber">
        Connected · showing <strong>DELAYED</strong> market data (no realtime
        subscription). Charts &amp; quotes are ~15 min behind.
      </Bar>
    );
  }

  return null;
}

function Bar({ tone, children }: { tone: "red" | "amber"; children: React.ReactNode }) {
  const cls =
    tone === "red"
      ? "bg-red-950/60 text-red-200 border-red-800"
      : "bg-amber-950/60 text-amber-200 border-amber-800";
  return (
    <div className={`border-b px-4 py-2 text-sm ${cls}`}>{children}</div>
  );
}
