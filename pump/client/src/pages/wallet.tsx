import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BrowserProvider, Contract, parseUnits, type Eip1193Provider } from "ethers";
import { format } from "date-fns";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Droplets,
  ExternalLink,
  Info,
  Loader2,
  LogIn,
  RefreshCw,
  Wallet as WalletIcon,
} from "lucide-react";
import type { SafeUser, WalletView, Withdrawal, WithdrawalStatus } from "@shared/schema";
import { withdrawSchema } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { useToast } from "@/hooks/use-toast";
import { useT, type TFunction } from "@/i18n";
import { apiRequest } from "@/lib/queryClient";
import { shortAddress, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Browser wallet helpers (EIP-1193)
// ---------------------------------------------------------------------------

function getEthereum(): Eip1193Provider | undefined {
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

const USDC_ABI = ["function transfer(address to, uint256 value) returns (bool)"];

function shortHash(h: string) {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function errorCode(err: unknown): number | undefined {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } }; error?: { code?: unknown } };
  const candidates = [e?.code, e?.data?.originalError?.code, e?.error?.code];
  for (const c of candidates) if (typeof c === "number") return c;
  return undefined;
}

function walletErrorMessage(err: unknown, t: TFunction): string {
  if (errorCode(err) === 4001) return t("wallet.walletRejected");
  const e = err as { shortMessage?: string; reason?: string; info?: { error?: { message?: string } } };
  if (typeof e?.shortMessage === "string" && e.shortMessage) return e.shortMessage;
  if (typeof e?.reason === "string" && e.reason) return e.reason;
  if (typeof e?.info?.error?.message === "string" && e.info.error.message) return e.info.error.message;
  return apiErrorMessage(err, t("wallet.txFailed"));
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const STATUS_PILL: Record<WithdrawalStatus | "confirmed", string> = {
  pending: "bg-gold/15 text-gold",
  sent: "bg-up/15 text-up",
  confirmed: "bg-up/15 text-up",
  failed: "bg-down/15 text-down",
};

function StatusPill({ status }: { status: WithdrawalStatus | "confirmed" }) {
  const t = useT();
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", STATUS_PILL[status])}>
      {t(`wallet.status.${status}`)}
    </span>
  );
}

function TxLink({ explorer, hash }: { explorer: string; hash: string | null }) {
  if (!hash) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
    >
      {shortHash(hash)}
      <ExternalLink className="h-3 w-3" />
    </a>
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

function Notice({ children, tone = "warn" }: { children: React.ReactNode; tone?: "warn" | "info" }) {
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

function WalletSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-8 w-40 rounded-lg" />
      <Skeleton className="h-[132px] rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-[420px] rounded-xl" />
        <Skeleton className="h-[420px] rounded-xl" />
      </div>
      <Skeleton className="h-[260px] rounded-xl" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

function DepositCard({ wallet, depositsEnabled }: { wallet: WalletView; depositsEnabled: boolean }) {
  const t = useT();
  const { toast } = useToast();
  const chain = wallet.chain;
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const hasWallet = typeof window !== "undefined" && !!getEthereum();

  const send = useMutation({
    mutationFn: async (value: string) => {
      const eth = getEthereum();
      if (!eth) throw new Error(t("auth.walletNoProvider"));
      const hexChainId = `0x${chain.chainId.toString(16)}`;
      await eth.request({ method: "eth_requestAccounts" });
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
      } catch (err) {
        if (errorCode(err) === 4902) {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: hexChainId,
                chainName: chain.name,
                rpcUrls: [chain.rpcUrl],
                blockExplorerUrls: [chain.explorer],
                nativeCurrency: {
                  name: chain.key.startsWith("base") ? "Ether" : "POL",
                  symbol: chain.key.startsWith("base") ? "ETH" : "POL",
                  decimals: 18,
                },
              },
            ],
          });
        } else {
          throw err;
        }
      }
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const usdc = new Contract(chain.usdcAddress, USDC_ABI, signer);
      const tx = (await usdc.transfer(wallet.depositAddress, parseUnits(value, 6))) as { hash: string };
      return tx.hash;
    },
    onSuccess: (hash) => {
      setTxHash(hash);
      setAmount("");
      toast({ title: t("wallet.sent"), description: t("wallet.sentHint", { confirmations: chain.confirmations }) });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("wallet.depositFailed"), description: walletErrorMessage(err, t) });
    },
  });

  const amountNum = Number(amount);
  const amountValid = /^\d+(\.\d{1,6})?$/.test(amount) && amountNum > 0;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <ArrowDownToLine className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("wallet.deposit")}</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("wallet.depositHint", { chain: chain.name, confirmations: chain.confirmations })}
      </p>
      {!depositsEnabled && <div className="mt-3"><Notice>{t("wallet.depositPaused")}</Notice></div>}

      <div className="mt-4 space-y-3">
        <div>
          <Label className="text-xs text-muted-foreground">{t("wallet.yourAddress")}</Label>
          <div className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-muted/60 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{wallet.depositAddress}</code>
            <CopyButton text={wallet.depositAddress} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <a
            href={`${chain.explorer}/address/${wallet.depositAddress}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            {t("wallet.viewExplorer")} <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <span className="text-muted-foreground">
            {t("wallet.usdcOn", { chain: chain.name })} · <span className="font-mono">{shortAddress(chain.usdcAddress)}</span>
          </span>
        </div>
        <Notice tone="info">
          {t("wallet.onlyUsdc", { chain: chain.name })}
          {chain.testnet && <> {t("wallet.testnetNote")}</>}
        </Notice>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">{t("wallet.depositBrowser")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("wallet.depositBrowserHint")}</p>
        {!hasWallet ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("wallet.noWallet")}</p>
        ) : (
          <>
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  className="rounded-lg pl-7 tabular"
                  aria-label={t("wallet.depositAmount")}
                />
              </div>
              <Button type="button" className="rounded-lg font-semibold" disabled={!amountValid || send.isPending} onClick={() => send.mutate(amount)}>
                {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("wallet.depositUsdc")}
              </Button>
            </div>
            {txHash && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("wallet.txSubmitted")} <TxLink explorer={chain.explorer} hash={txHash} />
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Faucet (testnet only)
// ---------------------------------------------------------------------------

function FaucetCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const faucet = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wallet/faucet");
      return (await res.json()) as SafeUser;
    },
    onSuccess: async (user) => {
      qc.setQueryData(["/api/me"], user);
      await Promise.all([qc.invalidateQueries({ queryKey: ["/api/wallet"] }), qc.invalidateQueries({ queryKey: ["/api/portfolio"] })]);
      toast({ title: t("wallet.faucetClaimed"), description: t("wallet.balanceNow", { amount: usd(user.balance) }) });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("wallet.faucetUnavailable"), description: apiErrorMessage(err, t("common.error")) });
    },
  });
  return (
    <section className="rounded-xl border border-dashed border-gold/50 bg-gold/5 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gold/15 text-gold">
          <Droplets className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("wallet.faucet")}</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t("wallet.faucetHint")}</p>
      <Button type="button" variant="outline" className="mt-3 rounded-lg font-semibold" disabled={faucet.isPending} onClick={() => faucet.mutate()}>
        {faucet.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Droplets className="h-4 w-4" />}
        {t("wallet.faucetClaim")}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Withdraw (react-hook-form + zod)
// ---------------------------------------------------------------------------

type WithdrawForm = z.infer<typeof withdrawSchema>;

function WithdrawCard({ wallet, withdrawalsEnabled }: { wallet: WalletView; withdrawalsEnabled: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  // withdrawSchema plus the "not more than you have" rule, which only the client knows up front.
  const schema = useMemo(
    () =>
      withdrawSchema.refine((v) => v.amount <= wallet.balance + 1e-9, {
        path: ["amount"],
        message: "over_balance",
      }),
    [wallet.balance],
  );

  const form = useForm<WithdrawForm>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { toAddress: "", amount: undefined as unknown as number },
  });
  const { register, handleSubmit, setValue, watch, reset, formState } = form;
  const { errors, isValid } = formState;
  const amountValue = watch("amount");

  const withdraw = useMutation({
    mutationFn: async (body: WithdrawForm) => {
      const res = await apiRequest("POST", "/api/wallet/withdraw", body);
      return (await res.json()) as Withdrawal;
    },
    onSuccess: async (w) => {
      reset({ toAddress: "", amount: undefined as unknown as number });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/wallet"] }),
        qc.invalidateQueries({ queryKey: ["/api/me"] }),
        qc.invalidateQueries({ queryKey: ["/api/portfolio"] }),
      ]);
      toast({ title: t("wallet.withdrawRequested"), description: t("wallet.withdrawTo", { amount: usd(w.amount), address: shortAddress(w.toAddress) }) });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("wallet.withdrawFailed"), description: apiErrorMessage(err, t("common.error")) });
    },
  });

  const addressError = errors.toAddress ? t("wallet.invalidAddress") : null;
  const amountError = errors.amount
    ? errors.amount.message === "over_balance"
      ? t("wallet.exceedsBalance")
      : errors.amount.type === "invalid_type"
        ? null // untouched / empty field: no message yet
        : t("wallet.amountPositive")
    : null;

  const amountNum = typeof amountValue === "number" && Number.isFinite(amountValue) ? amountValue : 0;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <ArrowUpFromLine className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("wallet.withdraw")}</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t("wallet.withdrawHint", { chain: wallet.chain.name })}</p>

      <form className="mt-4 space-y-3" onSubmit={handleSubmit((values) => withdraw.mutate(values))} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="withdraw-address">{t("wallet.destination")}</Label>
          <Input
            id="withdraw-address"
            placeholder="0x…"
            className="rounded-lg font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!addressError}
            {...register("toAddress", { setValueAs: (v: string) => v.trim() })}
          />
          {addressError && formState.dirtyFields.toAddress && <p className="text-xs text-down">{addressError}</p>}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="withdraw-amount">{t("wallet.amount")}</Label>
            <span className="text-xs text-muted-foreground tabular">{t("wallet.available", { amount: usd(wallet.balance) })}</span>
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span>
            <Input
              id="withdraw-amount"
              type="number"
              inputMode="decimal"
              step="0.000001"
              min="0"
              placeholder="0.00"
              className="rounded-lg pl-7 pr-16 tabular"
              aria-invalid={!!amountError}
              {...register("amount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
            />
            <button
              type="button"
              onClick={() => setValue("amount", Math.floor(wallet.balance * 1e6) / 1e6, { shouldValidate: true, shouldDirty: true })}
              className="absolute inset-y-0 right-2 my-auto h-7 rounded-md px-2 text-xs font-semibold text-primary hover:bg-primary/10"
            >
              {t("trade.max")}
            </button>
          </div>
          {amountError && <p className="text-xs text-down">{amountError}</p>}
        </div>

        <Button type="submit" className="w-full rounded-lg font-semibold" disabled={!isValid || withdraw.isPending}>
          {withdraw.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isValid && amountNum > 0 ? `${t("wallet.withdraw")} ${usd(amountNum)}` : t("wallet.withdrawSubmit")}
        </Button>
      </form>

      <p className="mt-3 text-xs text-muted-foreground">{t("wallet.withdrawNotice")}</p>
      {!withdrawalsEnabled && <div className="mt-2"><Notice>{t("wallet.withdrawManual")}</Notice></div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryEmpty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

function HistoryCard({ wallet }: { wallet: WalletView }) {
  const t = useT();
  const explorer = wallet.chain.explorer;
  const deposits = wallet.deposits.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const withdrawals = wallet.withdrawals.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-base font-bold">{t("wallet.history")}</h2>
      <Tabs defaultValue="deposits" className="mt-3">
        <TabsList className="rounded-lg">
          <TabsTrigger value="deposits" className="rounded-md">
            {t("wallet.history.deposits")}
            {deposits.length > 0 && <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{deposits.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="withdrawals" className="rounded-md">
            {t("wallet.history.withdrawals")}
            {withdrawals.length > 0 && <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{withdrawals.length}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="deposits" className="mt-3">
          {deposits.length === 0 ? (
            <HistoryEmpty>{t("wallet.noDeposits")}</HistoryEmpty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("wallet.time")}</TableHead>
                    <TableHead className="text-right">{t("wallet.amount")}</TableHead>
                    <TableHead>{t("wallet.status")}</TableHead>
                    <TableHead>{t("wallet.transaction")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deposits.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">{format(new Date(d.createdAt), "MMM d, yyyy HH:mm")}</TableCell>
                      <TableCell className="text-right font-medium text-up tabular">+{usd(d.amount)}</TableCell>
                      <TableCell>
                        <StatusPill status="confirmed" />
                      </TableCell>
                      <TableCell>
                        <TxLink explorer={explorer} hash={d.txHash} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="withdrawals" className="mt-3">
          {withdrawals.length === 0 ? (
            <HistoryEmpty>{t("wallet.noWithdrawals")}</HistoryEmpty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("wallet.time")}</TableHead>
                    <TableHead className="text-right">{t("wallet.amount")}</TableHead>
                    <TableHead>{t("wallet.to")}</TableHead>
                    <TableHead>{t("wallet.status")}</TableHead>
                    <TableHead>{t("wallet.transaction")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawals.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">{format(new Date(w.createdAt), "MMM d, yyyy HH:mm")}</TableCell>
                      <TableCell className="text-right font-medium text-down tabular">-{usd(w.amount)}</TableCell>
                      <TableCell>
                        <a href={`${explorer}/address/${w.toAddress}`} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
                          {shortAddress(w.toAddress)}
                        </a>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <StatusPill status={w.status} />
                          {w.status === "failed" && w.error && <span className="text-xs text-down">{w.error}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <TxLink explorer={explorer} hash={w.txHash} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WalletPage() {
  const t = useT();
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const config = useConfig();

  const wallet = useQuery<WalletView>({
    queryKey: ["/api/wallet"],
    enabled: !!user,
    staleTime: 15_000,
  });

  if (authLoading || (user && wallet.isLoading)) {
    return (
      <PageShell>
        <WalletSkeleton />
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <WalletIcon className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">{t("wallet.loginRequired")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("wallet.loginHint")}</p>
          <Button className="mt-6 rounded-lg font-semibold" onClick={openLogin}>
            <LogIn className="h-4 w-4" />
            {t("nav.login")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const data = wallet.data;
  if (wallet.isError || !data) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
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

  const chain = config?.chain ?? data.chain;
  const depositsEnabled = config?.depositsEnabled ?? true;
  const withdrawalsEnabled = config?.withdrawalsEnabled ?? true;

  return (
    <PageShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("wallet.title")}</h1>

        <section className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("wallet.balance")}</div>
            <div className="mt-1 text-4xl font-extrabold text-primary tabular">{usd(data.balance)}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{t("wallet.usdcOn", { chain: chain.name })}</span>
              {chain.testnet && (
                <span className="inline-flex items-center rounded-full bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">{t("wallet.testnet")}</span>
              )}
            </div>
          </div>
          <div className="text-sm text-muted-foreground sm:text-right">
            <div>{t("wallet.availableHint")}</div>
            {chain.testnet && <div className="mt-0.5">{t("wallet.testnetNote")}</div>}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <DepositCard wallet={{ ...data, chain }} depositsEnabled={depositsEnabled} />
            {chain.testnet && <FaucetCard />}
          </div>
          <WithdrawCard wallet={{ ...data, chain }} withdrawalsEnabled={withdrawalsEnabled} />
        </div>

        <HistoryCard wallet={{ ...data, chain }} />
      </div>
    </PageShell>
  );
}
