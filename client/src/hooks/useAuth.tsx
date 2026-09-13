import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import type { SafeUser } from "@shared/schema";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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

const AUTH_ERRORS: Record<string, string> = {
  invalid_link: "That sign-in link is invalid or has expired. Please request a new one.",
  expired_link: "That sign-in link has expired. Please request a new one.",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const [loginOpen, setLoginOpen] = useState(false);

  const { data, isLoading } = useQuery<SafeUser | null>({
    queryKey: ["/api/me"],
    queryFn: getQueryFn<SafeUser | null>({ on401: "returnNull" }),
    staleTime: 60_000,
  });
  const user = data ?? null;

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
        title: "Sign-in failed",
        description: AUTH_ERRORS[authError] ?? "We could not sign you in. Please try again.",
      });
      params.delete("auth_error");
    }
    if (welcome !== null) {
      toast({ title: "You're signed in", description: "Welcome to Foresight. Happy forecasting!" });
      params.delete("welcome");
      queryClient.invalidateQueries({ queryKey: ["/api/me"] });
    }
    const rest = params.toString();
    navigate(`${location}${rest ? `?${rest}` : ""}${window.location.hash}`, { replace: true });
  }, [search, location, navigate, toast]);

  const openLogin = useCallback(() => setLoginOpen(true), []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);

  const logout = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } finally {
      queryClient.setQueryData(["/api/me"], null);
      await queryClient.invalidateQueries();
      toast({ title: "Logged out", description: "See you next time." });
    }
  }, [toast]);

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
      <AuthModal open={loginOpen && !user} onOpenChange={setLoginOpen} />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
