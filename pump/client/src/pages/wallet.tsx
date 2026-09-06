import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import {
  ArrowUpRight,
  Check,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet as WalletIcon,
} from "lucide-react";
import type { UnsignedTx, WalletView } from "@shared/schema";
import { SOLANA_ADDRESS_RE } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { useDepositSheet } from "@/components/DepositSheet";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useEmbeddedWallet } from "@/hooks/useEmbeddedWallet";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest } from "@/lib/queryClient";
import { useWalletTx } from "@/lib/solana";
import { shortAddress, sol, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Left behind so the wallet can still pay for its next transaction. */
const WITHDRAW_RESERVE_SOL = 0.003;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * Withdraw: move SOL out of this wallet to any Solana address.
 *
 * The server assembles the transfer, the account's own key signs it here and the
 * signed bytes go back through /api/tx/send — Next never holds the funds and
 * never signs for them.
 */
function WithdrawSheet({
  open,
  onOpenChange,
  balanceSol,
  solUsd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balanceSol: number;
  solUsd: number;
}) {
  const t = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { signAndSend } = useWalletTx();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);

  const spendable = Math.max(0, balanceSol - WITHDRAW_RESERVE_SOL);
  const amountSol = Number(amount) || 0;
  const invalid = !SOLANA_ADDRESS_RE.test(to.trim()) || amountSol <= 0 || amountSol > spendable + 1e-9;

  const submit = async () => {
    if (invalid || sending) return;
    setSending(true);
    try {
      const res = await apiRequest("POST", "/api/wallet/withdraw-tx", { to: to.trim(), amountSol });
      const unsigned = (await res.json()) as UnsignedTx;
      const sent = await signAndSend(unsigned, "withdraw");
      toast({
        title: t("wallet.sent"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="font-medium underline">
            {t("trade.viewOnSolscan")}
          </a>
        ),
      });
      setTo("");
      setAmount("");
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ["/api/wallet"] });
    } catch (err) {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err, t("common.error")) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-[28px] border-t-0 bg-card/95 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" aria-hidden />
        <SheetTitle className="mb-1 text-center text-[22px] font-bold">{t("wallet.withdraw")}</SheetTitle>
        <p className="mb-5 text-center text-[15px] text-muted-foreground">{t("wallet.withdrawSheetHint")}</p>

        <label className="block text-sm font-semibold" htmlFor="withdraw-to">
          {t("wallet.destination")}
        </label>
        <input
          id="withdraw-to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="So1…"
          spellCheck={false}
          className="mt-1.5 h-12 w-full rounded-2xl bg-secondary px-4 text-[15px] outline-none"
        />

        <div className="mt-4 flex items-baseline justify-between">
          <label className="text-sm font-semibold" htmlFor="withdraw-amount">
            {t("wallet.amount")}
          </label>
          <button
            type="button"
            onClick={() => setAmount(String(Number(spendable.toFixed(6))))}
            className="tap text-xs font-bold text-primary"
          >
            {t("wallet.available", { amount: `${sol(spendable)} SOL` })}
          </button>
        </div>
        <div className="relative mt-1.5">
          <input
            id="withdraw-amount"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
            className="h-12 w-full rounded-2xl bg-secondary px-4 pr-16 text-[15px] tabular outline-none"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">SOL</span>
        </div>
        {amountSol > 0 && <p className="mt-1.5 text-xs text-muted-foreground tabular">≈ {usd(amountSol, solUsd)}</p>}

        <Button
          size="lg"
          disabled={invalid || sending}
          onClick={() => void submit()}
          className="tap mt-6 h-14 w-full rounded-2xl text-base font-bold"
        >
          {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : t("wallet.withdrawSubmit")}
        </Button>
      </SheetContent>
    </Sheet>
  );
}


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
// The built-in wallet: its recovery phrase, and importing another one
// ---------------------------------------------------------------------------

/**
 * The phrase is the wallet. It is shown only on demand, never sent anywhere, and
 * carries the warning it deserves — losing it (clearing site data, a new device)
 * loses the funds, and sharing it hands them over.
 */
function RecoveryCard() {
  const t = useT();
  const { toast } = useToast();
  const { vault, restore } = useEmbeddedWallet();
  const [revealed, setRevealed] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [importing, setImporting] = useState(false);

  if (!vault) return null;
  const words = vault.mnemonic.split(" ");

  const submitImport = async () => {
    setImporting(true);
    try {
      await restore(phrase);
      setPhrase("");
      setRevealed(false);
      toast({ title: t("wallet.imported") });
    } catch (err) {
      toast({ variant: "destructive", title: t("wallet.importFailed"), description: apiErrorMessage(err, "") });
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="surface p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gold/10 text-gold">
          <KeyRound className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("wallet.recovery")}</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t("wallet.recoveryHint")}</p>

      {revealed ? (
        <>
          <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {words.map((word, i) => (
              <li key={`${word}-${i}`} className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm font-medium">
                <span className="mr-2 text-xs tabular text-muted-foreground">{i + 1}</span>
                {word}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-lg font-semibold"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(vault.mnemonic);
                  toast({ title: t("wallet.phraseCopied") });
                } catch {
                  toast({ variant: "destructive", title: t("wallet.copyFailed") });
                }
              }}
            >
              <Copy className="h-4 w-4" />
              {t("wallet.copyPhrase")}
            </Button>
            <Button type="button" variant="ghost" className="rounded-lg font-semibold" onClick={() => setRevealed(false)}>
              <EyeOff className="h-4 w-4" />
              {t("wallet.hide")}
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" variant="outline" className="mt-4 rounded-lg font-semibold" onClick={() => setRevealed(true)}>
          <Eye className="h-4 w-4" />
          {t("wallet.reveal")}
        </Button>
      )}

      <div className="mt-5 border-t border-border/70 pt-4">
        <h3 className="text-sm font-bold">{t("wallet.import")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("wallet.importHint")}</p>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          rows={2}
          spellCheck={false}
          autoComplete="off"
          placeholder="word word word…"
          className="mt-2 w-full resize-none rounded-lg border border-border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          type="button"
          className="mt-2 rounded-lg font-semibold"
          disabled={importing || phrase.trim().split(/\s+/).length < 12}
          onClick={() => void submitImport()}
        >
          {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t("wallet.importAction")}
        </Button>
      </div>
    </section>
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
  const { vault } = useEmbeddedWallet();
  const deposit = useDepositSheet();
  const [withdrawOpen, setWithdrawOpen] = useState(false);

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
  // The account's own wallet counts even before the link round-trip finishes.
  const address = data?.wallet ?? user?.walletAddress ?? vault?.solana ?? null;

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
            <div className="label">{t("wallet.solBalance")}</div>
            <div className="stat mt-1 text-4xl text-primary">{usd(data.balanceSol, data.solUsd)}</div>
            <div className="mt-1 text-sm text-muted-foreground tabular">{sol(data.balanceSol)}</div>
            {chain.testnet && (
              <span className="mt-1.5 inline-flex items-center rounded-full bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">
                {t("wallet.testnet")} ({chain.cluster})
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button size="lg" className="tap h-12 rounded-2xl px-6 text-base font-bold" onClick={deposit.open}>
              <Plus className="h-4 w-4" />
              {t("wallet.deposit")}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="tap h-12 rounded-2xl px-6 text-base font-bold"
              onClick={() => setWithdrawOpen(true)}
            >
              <ArrowUpRight className="h-4 w-4" />
              {t("wallet.withdraw")}
            </Button>
            <ShieldCheck className="hidden h-10 w-10 shrink-0 text-primary/40 sm:block" />
          </div>
        </section>
        {deposit.sheet}
        <WithdrawSheet open={withdrawOpen} onOpenChange={setWithdrawOpen} balanceSol={data.balanceSol} solUsd={data.solUsd} />

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

          <RecoveryCard />
        </div>
      </div>
    </PageShell>
  );
}
