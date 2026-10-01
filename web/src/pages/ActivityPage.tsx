import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type SymbolActivity } from "../api";
import { ActivityChart } from "../components/ActivityChart";
import {
  ACTIVITY_TIMEFRAMES,
  DEFAULT_ACTIVITY_TIMEFRAME,
  STATUS_FILTERS,
  changeSince,
  fmtTradeDate,
  matchesStatus,
  tradeMarkers,
  windowBars,
  type ActivityTimeframe,
  type StatusFilter,
} from "../utils/activity";
import { fmtNum, fmtPct, pnlColor } from "../utils/format";

/**
 * One chart per stock you've ever bought or sold, newest activity first, with
 * every fill marked and a line at the last fill's price.
 */
export function ActivityPage() {
  const [tfKey, setTfKey] = useState(DEFAULT_ACTIVITY_TIMEFRAME);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const tf =
    ACTIVITY_TIMEFRAMES.find((t) => t.key === tfKey) ??
    ACTIVITY_TIMEFRAMES.find((t) => t.key === DEFAULT_ACTIVITY_TIMEFRAME)!;
  const startSec = useMemo(() => {
    const d = tf.start(new Date());
    return d ? Math.floor(d.getTime() / 1000) : null;
  }, [tf]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["activity"],
    queryFn: api.activity,
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <Centered>Loading activity…</Centered>;
  if (isError) return <Centered tone="error">{(error as Error).message}</Centered>;
  if (!data) return null;

  const shown = data.symbols.filter((s) => matchesStatus(s, statusFilter));

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Activity ({shown.length})</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            Every stock you've bought or sold, most recent activity first. The
            line marks your last trade's price —{" "}
            <span className="text-emerald-500/70">green for a buy</span>,{" "}
            <span className="text-red-500/70">red for a sell</span>; ▲/▼ mark
            earlier trades.
          </p>
          {data.tradesAsOf && (
            <p className="text-xs text-gray-500">
              Trades as of {new Date(data.tradesAsOf).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  statusFilter === f
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="h-5 w-px bg-gray-800" aria-hidden />
          <div className="flex gap-1">
            {ACTIVITY_TIMEFRAMES.map((t) => (
              <button
                key={t.key}
                onClick={() => setTfKey(t.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  t.key === tfKey
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data.symbols.length === 0 ? (
        <Centered>No buy/sell activity in the trade history.</Centered>
      ) : shown.length === 0 ? (
        <Centered>No {statusFilter.toLowerCase()} positions.</Centered>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {shown.map((s) => (
            <ActivityCard key={s.conId ?? s.symbol} activity={s} tf={tf} startSec={startSec} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityCard({
  activity,
  tf,
  startSec,
}: {
  activity: SymbolActivity;
  tf: ActivityTimeframe;
  startSec: number | null;
}) {
  const navigate = useNavigate();
  const { symbol, conId, currency, last } = activity;
  const intraday = tf.intraday;

  // 1D / 1W need finer bars than the daily history the page loaded.
  const intradayQuery = useQuery({
    queryKey: ["activityBars", conId ?? symbol, tf.key],
    queryFn: () =>
      api.history({ symbol, conId, barSize: intraday!.barSize, duration: intraday!.duration }),
    enabled: intraday != null,
    staleTime: 60_000,
    refetchInterval: tf.key === "1d" ? 30_000 : false,
  });

  const bars = useMemo(
    () => (intraday ? intradayQuery.data?.bars ?? [] : windowBars(activity.bars, startSec)),
    [intraday, intradayQuery.data, activity.bars, startSec],
  );
  const markers = useMemo(
    () => tradeMarkers(activity.trades, bars, intraday?.barSeconds),
    [activity.trades, bars, intraday],
  );
  const latestBars = intraday && bars.length > 0 ? bars : activity.bars;
  const close = latestBars[latestBars.length - 1]?.close;
  const since = changeSince(last.price, latestBars);
  const isBuy = last.side === "buy";

  const openInCharts = () => {
    const qs = new URLSearchParams({ symbol });
    if (conId != null) qs.set("conId", String(conId));
    if (currency) qs.set("currency", currency);
    navigate(`/chart?${qs.toString()}`);
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-gray-100">{symbol}</span>
            <span
              title={activity.open ? `Holding ${fmtNum(activity.position, 4)} shares` : "Position closed"}
              className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                activity.open
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-gray-700/40 text-gray-400"
              }`}
            >
              {activity.open ? `Open · ${fmtNum(activity.position, 4)}` : "Closed"}
            </span>
            <button
              type="button"
              onClick={openInCharts}
              title={`Open ${symbol} in Charts`}
              aria-label={`Open ${symbol} in Charts`}
              className="rounded p-0.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.5" y2="16.5" />
              </svg>
            </button>
          </div>
          <div className="text-xs tabular-nums text-gray-400">
            <span className={isBuy ? "text-emerald-400" : "text-red-400"}>
              {isBuy ? "Bought" : "Sold"} {fmtNum(last.quantity, 4)} @ {fmtNum(last.price)}
            </span>{" "}
            · {fmtTradeDate(last.time)}
          </div>
        </div>
        <div className="text-right text-xs tabular-nums">
          <div className="text-sm font-semibold text-gray-200">{fmtNum(close)}</div>
          {since != null && (
            <div className={pnlColor(since)} title="Latest close vs. last fill">
              {fmtPct(since)} since
            </div>
          )}
        </div>
      </div>

      {intraday && intradayQuery.isLoading ? (
        <div className="h-[180px] animate-pulse rounded bg-gray-900" />
      ) : intraday && intradayQuery.isError ? (
        <div className="flex h-[180px] items-center justify-center px-2 text-center text-xs text-gray-500">
          {(intradayQuery.error as Error).message}
        </div>
      ) : activity.error && activity.bars.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center px-2 text-center text-xs text-gray-500">
          {activity.error}
        </div>
      ) : bars.length < 2 ? (
        <div className="flex h-[180px] items-center justify-center text-xs text-gray-500">
          Not enough data for this timeframe.
        </div>
      ) : (
        <ActivityChart bars={bars} markers={markers} last={last} intraday={intraday != null} />
      )}
    </div>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={`flex h-64 items-center justify-center text-sm ${
        tone === "error" ? "text-red-400" : "text-gray-500"
      }`}
    >
      {children}
    </div>
  );
}
