import { Forex, WhatToShow } from "@stoqey/ib";
import { ib } from "./connection.js";
import { ibCall } from "./ibCall.js";
import { getHistory, type HistoryBar } from "./marketData.js";

/**
 * Daily FX rates, so P&L on a non-base-currency instrument can be expressed in
 * the account's base currency. Without this a SEK-denominated position's P&L
 * gets summed into a USD account total as if a krona were a dollar.
 */

export interface FxRates {
  /** Base-currency units per 1 unit of the foreign currency, at `time`. */
  at(time: number): number;
}

/**
 * IDEALPRO lists each pair in one canonical direction, and asking for the other
 * one doesn't fail — IB quietly resolves SEK.USD to USD.SEK and returns krona
 * per dollar. So never infer the direction from what was requested: resolve the
 * contract and read back which currency IB treated as the base.
 */
async function resolvePair(
  from: string,
  to: string,
): Promise<{ contract: Forex; invert: boolean } | null> {
  const requested = new Forex(from, to);
  try {
    const details = await ibCall(`getContractDetails ${from}.${to}`, 15_000, () =>
      ib.api.getContractDetails(requested),
    );
    const resolved = details[0]?.contract;
    if (!resolved?.symbol || !resolved.currency) return null;
    // Quote is `currency` per 1 `symbol`. We want `to` per 1 `from`.
    if (resolved.symbol === from && resolved.currency === to) {
      return { contract: requested, invert: false };
    }
    if (resolved.symbol === to && resolved.currency === from) {
      return { contract: new Forex(to, from), invert: true };
    }
    return null;
  } catch {
    return null;
  }
}

function lookup(sorted: HistoryBar[], invert: boolean): FxRates {
  return {
    at(time: number): number {
      // Step-forward: the last close at or before `time`, else the earliest.
      let lo = 0;
      let hi = sorted.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].time <= time) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const close = sorted[found >= 0 ? found : 0].close;
      return invert ? 1 / close : close;
    },
  };
}

/**
 * Rates converting `from` into `to`, or null when IB can't price the pair (the
 * caller then leaves the series in its own currency and flags it).
 */
export async function getFxRates(
  from: string,
  to: string,
  duration: string,
): Promise<FxRates | null> {
  if (from === to) return { at: () => 1 };
  const pair = await resolvePair(from, to);
  if (!pair) return null;
  try {
    const bars = await getHistory({
      contract: pair.contract,
      barSize: "1 day",
      duration,
      useRTH: false, // forex trades around the clock
      whatToShow: WhatToShow.MIDPOINT,
    });
    return bars.length > 0 ? lookup(bars, pair.invert) : null;
  } catch {
    return null;
  }
}
