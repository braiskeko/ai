import { useQuery } from "@tanstack/react-query";
import type { AppConfig } from "@shared/schema";

/** Public runtime configuration (`GET /api/config`). Undefined while loading. */
export function useConfig(): AppConfig | undefined {
  const { data } = useQuery<AppConfig>({
    queryKey: ["/api/config"],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
