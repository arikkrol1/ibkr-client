import { useEffect, useRef, useState } from "react";
import { api, type SymbolMatch } from "../api";

interface Props {
  onSelect: (match: SymbolMatch) => void;
}

/** Debounced symbol search with a results dropdown. */
export function SymbolSearch({ onSelect }: Props) {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<SymbolMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 1) {
      setMatches([]);
      return;
    }
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const res = await api.search(q.trim());
        setMatches(res.matches.slice(0, 12));
        setOpen(true);
      } catch (e) {
        setError((e as Error).message);
        setMatches([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const pick = (m: SymbolMatch) => {
    onSelect(m);
    setQ(m.symbol ?? "");
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => matches.length && setOpen(true)}
        placeholder="Search ticker (e.g. AAPL, TSLA)…"
        className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
      />
      {loading && (
        <span className="absolute right-3 top-2.5 text-xs text-gray-500">…</span>
      )}
      {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
      {open && matches.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          {matches.map((m, i) => (
            <li key={`${m.conId ?? m.symbol}-${i}`}>
              <button
                onClick={() => pick(m)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-800"
              >
                <span>
                  <span className="font-semibold text-gray-100">{m.symbol}</span>
                  <span className="ml-2 text-gray-400">{m.name}</span>
                </span>
                <span className="shrink-0 text-xs text-gray-500">
                  {m.secType} · {m.primaryExch ?? m.currency}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
