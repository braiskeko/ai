import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Loader2, Mail, Sparkles } from "lucide-react";
import type { SafeUser } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useConfig } from "@/hooks/useConfig";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/hooks/useAuth";
import { useTheme } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Third-party identity SDK typings
// ---------------------------------------------------------------------------

interface GoogleCredentialResponse {
  credential: string;
  select_by?: string;
  clientId?: string;
}

interface GoogleIdConfiguration {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  ux_mode?: "popup" | "redirect";
  itp_support?: boolean;
  use_fedcm_for_prompt?: boolean;
}

interface GsiButtonConfiguration {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number | string;
  locale?: string;
}

interface AppleAuthConfig {
  clientId: string;
  scope?: string;
  redirectURI: string;
  state?: string;
  nonce?: string;
  usePopup?: boolean;
}

interface AppleSignInResponse {
  authorization: { code: string; id_token: string; state?: string };
  user?: { email?: string; name?: { firstName?: string; lastName?: string } };
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: GoogleIdConfiguration) => void;
          renderButton: (parent: HTMLElement, options: GsiButtonConfiguration) => void;
          prompt: () => void;
          cancel: () => void;
          disableAutoSelect: () => void;
        };
      };
    };
    AppleID?: {
      auth: {
        init: (config: AppleAuthConfig) => void;
        signIn: (config?: Partial<AppleAuthConfig>) => Promise<AppleSignInResponse>;
      };
    };
  }
}

const GOOGLE_SDK = "https://accounts.google.com/gsi/client";
const APPLE_SDK = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

const scriptPromises = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  const existing = scriptPromises.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromises.delete(src);
      el.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(el);
  });
  scriptPromises.set(src, p);
  return p;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Provider = "google" | "apple";

export function AuthModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const config = useConfig();
  const { toast } = useToast();
  const { isDark } = useTheme();

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  const googleClientId = config?.googleClientId ?? null;
  const appleClientId = config?.appleClientId ?? null;

  // Reset transient state whenever the dialog is closed.
  useEffect(() => {
    if (open) return;
    setSending(false);
    setSentTo(null);
    setDevLink(null);
    setError(null);
    setBusyProvider(null);
  }, [open]);

  const finishLogin = useCallback(
    (user: SafeUser) => {
      queryClient.setQueryData(["/api/me"], user);
      queryClient.invalidateQueries();
      onOpenChange(false);
      toast({ title: `Welcome, ${user.username}`, description: "You're signed in." });
    },
    [onOpenChange, toast],
  );

  const exchangeCredential = useCallback(
    async (provider: Provider, credential: string) => {
      setBusyProvider(provider);
      setError(null);
      try {
        const res = await apiRequest("POST", `/api/auth/${provider}`, { credential });
        const user = (await res.json()) as SafeUser;
        finishLogin(user);
      } catch (e) {
        setError(apiErrorMessage(e, `Could not sign in with ${provider === "google" ? "Google" : "Apple"}.`));
      } finally {
        setBusyProvider(null);
      }
    },
    [finishLogin],
  );

  // Google Identity Services button
  useEffect(() => {
    if (!open || !googleClientId) return;
    let cancelled = false;
    setGoogleReady(false);
    loadScript(GOOGLE_SDK)
      .then(() => {
        if (cancelled) return;
        const google = window.google;
        const host = googleButtonRef.current;
        if (!google || !host) return;
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            if (response.credential) void exchangeCredential("google", response.credential);
          },
          ux_mode: "popup",
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
        });
        host.innerHTML = "";
        const width = Math.max(200, Math.min(400, Math.floor(host.clientWidth || 360)));
        google.accounts.id.renderButton(host, {
          type: "standard",
          theme: isDark ? "filled_black" : "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width,
        });
        setGoogleReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Google sign-in could not be loaded. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, googleClientId, isDark, exchangeCredential]);

  // Sign in with Apple
  useEffect(() => {
    if (!open || !appleClientId) return;
    let cancelled = false;
    setAppleReady(false);
    loadScript(APPLE_SDK)
      .then(() => {
        if (cancelled || !window.AppleID) return;
        window.AppleID.auth.init({
          clientId: appleClientId,
          scope: "name email",
          redirectURI: window.location.origin,
          usePopup: true,
        });
        setAppleReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Apple sign-in could not be loaded. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, appleClientId]);

  const signInWithApple = async () => {
    if (!window.AppleID) return;
    setBusyProvider("apple");
    setError(null);
    try {
      const res = await window.AppleID.auth.signIn();
      const idToken = res?.authorization?.id_token;
      if (!idToken) throw new Error("Apple did not return an identity token.");
      await exchangeCredential("apple", idToken);
    } catch (e) {
      const code = typeof e === "object" && e !== null ? (e as { error?: string }).error : undefined;
      if (code !== "popup_closed_by_user" && code !== "user_cancelled_authorize") {
        setError(apiErrorMessage(e, "Could not sign in with Apple."));
      }
      setBusyProvider(null);
    }
  };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address) return;
    setSending(true);
    setError(null);
    try {
      if (config?.instantEmailLogin) {
        // Pre-launch mode: the email alone creates the account and signs in.
        const res = await apiRequest("POST", "/api/auth/email", { email: address });
        const user = (await res.json()) as SafeUser;
        finishLogin(user);
        return;
      }
      const res = await apiRequest("POST", "/api/auth/magic", { email: address });
      const body = (await res.json()) as { ok: boolean; devLink?: string };
      setSentTo(address);
      setDevLink(body.devLink ?? null);
    } catch (err) {
      setError(apiErrorMessage(err, config?.instantEmailLogin ? "Could not sign in." : "Could not send the sign-in link."));
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setSentTo(null);
    setDevLink(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] gap-0 rounded-2xl border-border bg-card p-0 shadow-xl sm:rounded-2xl">
        <TooltipProvider delayDuration={150}>
          <div className="p-6 sm:p-7">
            <DialogHeader className="items-center text-center sm:text-center">
              <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <Logo className="h-6 w-6" />
              </div>
              <DialogTitle className="text-xl font-bold tracking-tight">
                {sentTo ? "Check your email" : `Welcome to ${config?.appName ?? "Foresight"}`}
              </DialogTitle>
              <DialogDescription>
                {sentTo ? (
                  <>
                    We sent a sign-in link to <span className="font-medium text-foreground">{sentTo}</span>. Open it on
                    this device to finish signing in.
                  </>
                ) : (
                  config?.instantEmailLogin
                    ? "Enter your email to sign in or create an account instantly."
                    : "Sign in or create an account to trade."
                )}
              </DialogDescription>
            </DialogHeader>

            {sentTo ? (
              <div className="mt-6 space-y-4">
                {devLink && (
                  <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
                    <div className="mb-1 flex items-center gap-2 font-semibold text-primary">
                      <Sparkles className="h-4 w-4" />
                      Demo mode
                    </div>
                    <p className="text-muted-foreground">
                      Email sending is not configured on this deployment, so here is your link instead.
                    </p>
                    <a
                      href={devLink}
                      className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      Click to sign in
                    </a>
                  </div>
                )}
                {!devLink && (
                  <div className="flex items-start gap-3 rounded-xl bg-muted p-4 text-sm text-muted-foreground">
                    <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>The link expires in 15 minutes. If you don't see the email, check your spam folder.</p>
                  </div>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
                <button
                  type="button"
                  onClick={reset}
                  className="mx-auto flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Use a different email
                </button>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {/* Google */}
                {googleClientId ? (
                  <div className="relative h-11">
                    <div
                      ref={googleButtonRef}
                      className={cn(
                        "flex h-11 w-full items-center justify-center overflow-hidden rounded-lg [&>div]:w-full",
                        !googleReady && "invisible",
                      )}
                    />
                    {(!googleReady || busyProvider === "google") && (
                      <div className="absolute inset-0">
                        <ProviderButton icon={<GoogleIcon />} label="Continue with Google" loading disabled />
                      </div>
                    )}
                  </div>
                ) : (
                  <NotConfigured>
                    <ProviderButton icon={<GoogleIcon />} label="Continue with Google" disabled />
                  </NotConfigured>
                )}

                {/* Apple */}
                {appleClientId ? (
                  <ProviderButton
                    icon={<AppleIcon />}
                    label="Continue with Apple"
                    onClick={signInWithApple}
                    loading={!appleReady || busyProvider === "apple"}
                    disabled={!appleReady || busyProvider !== null}
                  />
                ) : (
                  <NotConfigured>
                    <ProviderButton icon={<AppleIcon />} label="Continue with Apple" disabled />
                  </NotConfigured>
                )}

                <div className="flex items-center gap-3 py-1 text-xs font-medium text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  OR
                  <div className="h-px flex-1 bg-border" />
                </div>

                <form onSubmit={submitEmail} className="space-y-3">
                  <label htmlFor="auth-email" className="sr-only">
                    Email address
                  </label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    required
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={sending}
                    className="h-11 rounded-lg bg-background text-base sm:text-sm"
                  />
                  <Button
                    type="submit"
                    disabled={sending || !email.trim()}
                    className="h-11 w-full rounded-lg text-sm font-semibold"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue"}
                  </Button>
                </form>

                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-b-2xl border-t border-border bg-muted/50 px-6 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
            By continuing you agree that this is a demo platform using play-money and testnet USDC only.
          </div>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ProviderButton({
  icon,
  label,
  onClick,
  disabled,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="relative h-11 w-full justify-center rounded-lg border-border bg-background text-sm font-medium hover:bg-accent disabled:opacity-60"
    >
      <span className="absolute left-4 flex h-5 w-5 items-center justify-center">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      {label}
    </Button>
  );
}

function NotConfigured({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="block w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Not configured on this deployment</TooltipContent>
    </Tooltip>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 4h12v3.5H9.75V10.5H16.5V14H9.75V20H6V4Z" fill="currentColor" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-current" aria-hidden>
      <path d="M16.365 1.43c0 1.14-.417 2.208-1.25 3.087-.884.94-1.94 1.487-3.023 1.398a3.44 3.44 0 0 1-.03-.415c0-1.1.475-2.24 1.317-3.097.42-.44.955-.805 1.6-1.09.646-.28 1.257-.436 1.83-.47.026.187.04.375.04.587zm3.95 16.15c-.548 1.27-.81 1.84-1.515 2.96-.985 1.56-2.375 3.5-4.1 3.52-1.53.014-1.925-1.01-4-1-2.075.01-2.51 1.018-4.045 1.003-1.725-.015-3.043-1.77-4.03-3.33-2.76-4.36-3.05-9.48-1.35-12.2 1.21-1.93 3.11-3.06 4.9-3.06 1.82 0 2.965 1.01 4.47 1.01 1.46 0 2.35-1.012 4.455-1.012 1.59 0 3.276.87 4.475 2.37-3.93 2.16-3.29 7.79.74 9.74z" />
    </svg>
  );
}
