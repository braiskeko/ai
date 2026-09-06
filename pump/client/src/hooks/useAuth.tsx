import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import type { SafeUser } from "@shared/schema";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { AuthModal } from "@/components/AuthModal";

export interface AuthContextValue {
  user: SafeUser | null;
  isLoading: boolean;
  openLogin: () => void;
  closeLogin: () => void;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Turns an error thrown by `apiRequest` / react-query into a human message:
 * strips the leading "NNN: " status prefix and unwraps `{message}` JSON bodies.
 */
export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;
  const stripped = raw.replace(/^\d{3}:\s*/, "").trim();
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message) return parsed.message;
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      /* not JSON */
    }
  }
  return stripped || fallback;
}

const CACHED_USER_KEY = "nx_me";

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && /^401:/.test(err.message);
}

function readCachedUser(): SafeUser | null | undefined {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as SafeUser | null;
    return parsed && typeof parsed.id === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedUser(user: SafeUser | null): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

const AUTH_ERROR_KEYS: Record<string, string> = {
  invalid_link: "auth.invalidLink",
  expired_link: "auth.expiredLink",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const t = useT();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const [loginOpen, setLoginOpen] = useState(false);

  /**
   * Staying signed in through a bad answer.
   *
   * A single failed `/api/me` — the host's resource-limit page, a restart, a
   * dropped connection — used to render the whole app as signed out. So the last
   * known account is kept in this browser and used as the starting value: the
   * query still refetches immediately, a real 401 clears it, and everything else
   * is treated as "we could not ask", not as "you are logged out".
   */
  const { data, isLoading } = useQuery<SafeUser | null>({
    queryKey: ["/api/me"],
    queryFn: getQueryFn<SafeUser | null>({ on401: "returnNull" }),
    staleTime: 60_000,
    initialData: readCachedUser,
    initialDataUpdatedAt: 0,
    retry: (count, err) => !isUnauthorized(err) && count < 3,
    retryDelay: (count) => Math.min(4_000, 500 * 2 ** count),
  });
  const user = data ?? null;

  // Mirror whatever the server last said, so the next cold load starts from it.
  useEffect(() => {
    if (data === undefined) return;
    writeCachedUser(data);
  }, [data]);

  // ?auth_error=… and ?welcome=1 arrive via the magic-link redirect.
  const handledSearch = useRef<string | null>(null);
  useEffect(() => {
    if (handledSearch.current === search) return;
    handledSearch.current = search;
    const params = new URLSearchParams(search);
    const authError = params.get("auth_error");
    const welcome = params.get("welcome");
    if (authError === null && welcome === null) return;

    if (authError !== null) {
      toast({
        variant: "destructive",
        title: t("auth.signInFailed"),
        description: t(AUTH_ERROR_KEYS[authError] ?? "auth.genericError"),
      });
      params.delete("auth_error");
    }
    if (welcome !== null) {
      // No "you're signed in" toast: landing on the app already says so.
      params.delete("welcome");
      queryClient.invalidateQueries({ queryKey: ["/api/me"] });
    }
    const rest = params.toString();
    navigate(`${location}${rest ? `?${rest}` : ""}${window.location.hash}`, { replace: true });
  }, [search, location, navigate, toast, t]);

  const openLogin = useCallback(() => setLoginOpen(true), []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);

  const logout = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } finally {
      writeCachedUser(null);
      queryClient.setQueryData(["/api/me"], null);
      await queryClient.invalidateQueries();
      toast({ title: t("auth.loggedOut"), description: t("auth.signedOut") });
    }
  }, [toast, t]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      openLogin,
      closeLogin,
      logout,
      isAdmin: !!user?.isAdmin,
    }),
    [user, isLoading, openLogin, closeLogin, logout],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/*
       * Open regardless of `user`: a signed-in Google/Apple/email user with no
       * wallet yet still needs this dialog (in "link a wallet" mode) before they
       * can create or trade — see AuthModal.
       */}
      <AuthModal open={loginOpen} onOpenChange={setLoginOpen} />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
