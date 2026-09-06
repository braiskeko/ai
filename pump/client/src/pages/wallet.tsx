import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import {
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  Info,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Wallet as WalletIcon,
} from "lucide-react";
import type { WalletView } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { shortAddress, sol, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-8 w-8 shrink-0 rounded-md"
      aria-label={t("wallet.copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast({ title: t("wallet.copied"), description: shortAddress(text) });
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast({ variant: "destructive", title: t("wallet.copyFailed"), description: t("wallet.copyFailedHint") });
        }
      }}
    >
      {copied ? <Check className="h-4 w-4 text-up" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "warn" | "info" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-xs",
        tone === "warn" ? "border-gold/40 bg-gold/10 text-foreground/90" : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Address QR code, generated client-side with the `qrcode` package. */
function AddressQr({ address }: { address: string }) {
  const t = useT();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    QRCode.toDataURL(address, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        /* leave the skeleton up — a broken QR isn't fatal, the address is shown as text too */
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!dataUrl) {
    return <Skeleton className="h-[220px] w-[220px] rounded-xl" />;
  }
  return (
    <img
      src={dataUrl}
      alt={t("wallet.qrAlt")}
      width={220}
      height={220}
      className="rounded-xl border border-border bg-white p-2"
    />
  );
}

const BUY_SOL_LINKS = [
  { key: "phantom", label: "Phantom", href: "https://phantom.app/" },
  { key: "coinbase", label: "Coinbase", href: "https://www.coinbase.com/price/solana" },
  { key: "moonpay", label: "MoonPay", href: "https://www.moonpay.com/buy/sol" },
] as const;

function WalletSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-8 w-40 rounded-lg" />
      <Skeleton className="h-[132px] rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-[380px] rounded-xl" />
        <Skeleton className="h-[380px] rounded-xl" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WalletPage() {
  const t = useT();
  const { toast } = useToast();
  const { user, isLoading: authLoading, openLogin, logout } = useAuth();
  const walletAdapter = useWallet();

  const wallet = useQuery<WalletView>({
    queryKey: ["/api/wallet"],
    staleTime: 15_000,
  });

  if (authLoading || wallet.isLoading) {
    return (
      <PageShell>
        <WalletSkeleton />
      </PageShell>
    );
  }

  const data = wallet.data;
  const address = data?.wallet ?? user?.walletAddress ?? null;

  if (!address) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto flex w-full max-w-md flex-col items-center surface p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <WalletIcon className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">{t("wallet.loginRequired")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("wallet.connectHint")}</p>
          <Button className="mt-6 rounded-lg font-semibold" onClick={openLogin}>
            <LogIn className="h-4 w-4" />
            {t("nav.login")}
          </Button>
        </div>
      </PageShell>
    );
  }

  if (wallet.isError || !data) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto w-full max-w-md surface p-8 text-center">
          <h1 className="text-lg font-bold">{t("wallet.loadError")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(wallet.error, t("common.error"))}</p>
          <Button variant="outline" className="mt-5 rounded-lg" onClick={() => void wallet.refetch()}>
            <RefreshCw className={cn("h-4 w-4", wallet.isFetching && "animate-spin")} />
            {t("common.retry")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const chain = data.chain;
  const explorerHref = `${chain.explorer}/account/${address}${chain.testnet ? "?cluster=devnet" : ""}`;

  const disconnect = async () => {
    try {
      if (walletAdapter.connected) await walletAdapter.disconnect();
    } catch {
      /* best-effort — the wallet extension may already be closed */
    }
    try {
      await logout();
    } catch (err) {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err, t("common.error")) });
    }
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("wallet.title")}</h1>

        <section className="flex flex-col justify-between gap-4 surface p-5 sm:flex-row sm:items-center">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("wallet.solBalance")}</div>
            <div className="mt-1 text-4xl font-extrabold text-primary tabular">{usd(data.balanceSol, data.solUsd)}</div>
            <div className="mt-1 text-sm text-muted-foreground tabular">{sol(data.balanceSol)}</div>
            {chain.testnet && (
              <span className="mt-1.5 inline-flex items-center rounded-full bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">
                {t("wallet.testnet")} ({chain.cluster})
              </span>
            )}
          </div>
          <ShieldCheck className="hidden h-10 w-10 shrink-0 text-primary/40 sm:block" />
        </section>

        <Notice tone="info">{t("wallet.nonCustodialNotice")}</Notice>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="surface p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
                <WalletIcon className="h-4 w-4" />
              </span>
              <h2 className="text-base font-bold">{t("wallet.address")}</h2>
            </div>

            <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <AddressQr address={address} />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/60 px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{address}</code>
                  <CopyButton text={address} />
                </div>
                <a
                  href={explorerHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t("wallet.viewExplorer")} <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <Button type="button" variant="outline" className="w-full rounded-lg font-semibold sm:w-auto" onClick={() => void disconnect()}>
                  <LogOut className="h-4 w-4" />
                  {t("wallet.disconnect")}
                </Button>
              </div>
            </div>
          </section>

          <section className="surface p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
                <CreditCard className="h-4 w-4" />
              </span>
              <h2 className="text-base font-bold">{t("wallet.buySol")}</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t("wallet.buySolHint")}</p>
            <div className="mt-4 space-y-2">
              {BUY_SOL_LINKS.map((l) => (
                <a
                  key={l.key}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm font-semibold transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {l.label}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">{t("wallet.buySolFooter")}</p>
          </section>
        </div>
      </div>
    </PageShell>
  );
}
