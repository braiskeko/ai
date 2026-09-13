import { QueryClient, QueryFunction } from "@tanstack/react-query";

/**
 * Turns a failed response into an error worth reading.
 *
 * A web server in front of the app answers with its own HTML error page, and
 * dumping that into a toast is unreadable — so anything that is not our own
 * JSON/text becomes "404 at /api/…", which says where the request actually
 * failed. The status prefix is preserved because callers match on it (a 404 is
 * "not found" rather than an error, in several places).
 */
async function throwIfResNotOk(res: Response) {
  if (res.ok) return;
  const raw = (await res.text().catch(() => "")).trim();
  const looksLikeHtml = raw.startsWith("<!DOCTYPE") || raw.startsWith("<html") || raw.includes("<body");
  const path = (() => {
    try {
      return new URL(res.url).pathname;
    } catch {
      return res.url;
    }
  })();
  const detail = !raw || looksLikeHtml ? `${res.statusText || "Request failed"} at ${path}` : raw;
  if (looksLikeHtml) {
    // eslint-disable-next-line no-console
    console.error(`Non-JSON ${res.status} from ${res.url}`);
  }
  throw new Error(`${res.status}: ${detail}`);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
