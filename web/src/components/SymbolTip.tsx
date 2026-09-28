import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { describe } from "../utils/symbolDescription";

interface Props {
  symbol?: string;
  conId?: number;
  children: ReactNode;
}

/**
 * Hover bubble describing a symbol (name + asset type / industry), fetched
 * lazily on first hover and cached indefinitely (contract details are
 * effectively immutable).
 */
export function SymbolTip({ symbol, conId, children }: Props) {
  const [hover, setHover] = useState(false);
  const { data, isError } = useQuery({
    queryKey: ["symbolInfo", conId ?? symbol],
    queryFn: () => api.symbolInfo({ symbol, conId }),
    enabled: hover && Boolean(symbol || conId),
    staleTime: Infinity,
    retry: 1,
  });

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {hover && !isError && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-64 -translate-x-1/2 rounded-lg border border-gray-700 bg-gray-950/95 px-2.5 py-1.5 text-left text-xs font-normal normal-case shadow-xl">
          {data ? (
            <>
              <span className="block font-medium text-gray-100">
                {data.longName ?? symbol}
              </span>
              {describe(data) && (
                <span className="block text-gray-400">{describe(data)}</span>
              )}
            </>
          ) : (
            <span className="text-gray-500">Loading…</span>
          )}
        </span>
      )}
    </span>
  );
}
