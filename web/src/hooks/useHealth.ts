import { useQuery } from "@tanstack/react-query";
import { api, type Health } from "../api";

/** Polls backend + IB connection status every few seconds. */
export function useHealth() {
  return useQuery<Health>({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 4000,
    staleTime: 2000,
  });
}
