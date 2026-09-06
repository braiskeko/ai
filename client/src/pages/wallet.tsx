import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
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
  Wallet as WalletIcon,
} from "lucide-react";
import type { SafeUser, WalletView, Withdrawal, WithdrawalStatus } from "@shared/schema";
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
import { apiRequest } from "@/lib/queryClient";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * EIP-1193 provider injected by MetaMask & co. Read via a cast instead of a
 * `declare global` so we never collide with other Window augmentations.
 */
function getEthereum(): Eip1193Provider | undefined {
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

const USDC_ABI = ["function transfer(address to, uint256 value) returns (bool)"];
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function shortAddress(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function shortHash(h: string) {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function errorCode(err: unknown): number | undefined {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } }; error?: { code?: unknown } };
  const candidates = [e?.code, e?.data?.originalError?.code, e?.error?.code];
  for (const c of candidates) if (typeof c === "number") return c;
  return undefined;
}

function walletErrorMessage(err: unknown): string {
  const code = errorCode(err);
  if (code === 4001) return "Request rejected in your wallet.";
  const e = err as { shortMessage?: string; reason?: string; info?: { error?: { message?: string } } };
  if (typeof e?.shortMessage === "string" && e.shortMessage) return e.shortMessage;
  if (typeof e?.reason === "string" && e.reason) return e.reason;
  if (typeof e?.info?.error?.message === "string" && e.info.error.message) return e.info.error.message;
  return apiErrorMessage(err, "Transaction failed");
}

const STATUS_PILL: Record<WithdrawalStatus, string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  sent: "bg-yes/15 text-yes",
  failed: "bg-no/15 text-no",
};

function StatusPill({ status }: { status: WithdrawalStatus | "confirmed" }) {
  const cls = status === "confirmed" ? STATUS_PILL.sent : STATUS_PILL[status];
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold capitalize", cls)}>
      {status}
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
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-8 w-8 shrink-0 rounded-md"
      aria-label="Copy address"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast({ title: "Address copied", description: shortAddress(text) });
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast({ variant: "destructive", title: "Could not copy", description: "Select the address and copy it manually." });
        }
      }}
    >
      {copied ? <Check className="h-4 w-4 text-yes" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

function WalletSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Skeleton className="h-[140px] rounded-xl lg:col-span-2" />
      <Skeleton className="h-[420px] rounded-xl" />
      <Skeleton className="h-[420px] rounded-xl" />
      <Skeleton className="h-[260px] rounded-xl lg:col-span-2" />
    </div>
  );
}

function DepositCard({ wallet, depositsEnabled }: { wallet: WalletView; depositsEnabled: boolean }) {
  const { toast } = useToast();
  const chain = wallet.chain;
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const hasWallet = typeof window !== "undefined" && !!getEthereum();

  const send = useMutation({
    mutationFn: async (value: string) => {
      const eth = getEthereum();
      if (!eth) throw new Error("No browser wallet detected");
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
      toast({
        title: "Transaction sent",
        description: `Your deposit will be credited after ${chain.confirmations} confirmation${chain.confirmations === 1 ? "" : "s"}.`,
      });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Deposit failed", description: walletErrorMessage(err) });
    },
  });

  const amountNum = Number(amount);
  const amountValid = /^\d+(\.\d{1,6})?$/.test(amount) && amountNum > 0;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <ArrowDownToLine className="h-5 w-5 text-primary" />
        <h2 className="text-base font-bold">Deposit</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Send USDC on <span className="font-medium text-foreground">{chain.name}</span> to your personal deposit address.
        Funds are credited after {chain.confirmations} confirmation{chain.confirmations === 1 ? "" : "s"}.
      </p>
      {!depositsEnabled && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          On-chain deposit monitoring is currently paused. Transfers will be credited once it resumes.
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="mx-auto shrink-0 rounded-xl border border-border bg-white p-3 sm:mx-0">
          <QRCodeSVG value={wallet.depositAddress} size={160} level="M" includeMargin={false} />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Your deposit address</Label>
            <div className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-muted/60 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{wallet.depositAddress}</code>
              <CopyButton text={wallet.depositAddress} />
            </div>
          </div>
          <a
            href={`${chain.explorer}/address/${wallet.depositAddress}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            View on explorer <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <p className="text-xs text-muted-foreground">
            Only send USDC ({shortAddress(chain.usdcAddress)}) on {chain.name}. Other tokens or networks cannot be recovered.
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Deposit from browser wallet</h3>
        {!hasWallet ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            Install MetaMask or another EVM wallet to deposit directly from your browser, or send USDC to the address above from any wallet or exchange.
          </p>
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
                  aria-label="Deposit amount in USDC"
                />
              </div>
              <Button
                type="button"
                className="rounded-lg"
                disabled={!amountValid || send.isPending}
                onClick={() => send.mutate(amount)}
              >
                {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Deposit USDC
              </Button>
            </div>
            {txHash && (
              <p className="mt-2 text-xs text-muted-foreground">
                Transaction submitted: <TxLink explorer={chain.explorer} hash={txHash} />
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function FaucetCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const faucet = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/wallet/faucet");
      return (await res.json()) as SafeUser;
    },
    onSuccess: async (user) => {
      qc.setQueryData(["/api/me"], user);
      await qc.invalidateQueries({ queryKey: ["/api/wallet"] });
      await qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      toast({ title: "Test USDC added", description: `Your balance is now ${usd(user.balance)}.` });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Faucet unavailable", description: apiErrorMessage(err) });
    },
  });
  return (
    <section className="rounded-xl border border-dashed border-amber-500/50 bg-amber-500/5 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Droplets className="h-5 w-5 text-amber-600 dark:text-amber-400" />
        <h2 className="text-base font-bold">Get test USDC</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        This deployment runs on a testnet. Claim free play money to try trading without any real funds.
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-3 rounded-lg"
        disabled={faucet.isPending}
        onClick={() => faucet.mutate()}
      >
        {faucet.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Claim test USDC
      </Button>
    </section>
  );
}

function WithdrawCard({ wallet, withdrawalsEnabled }: { wallet: WalletView; withdrawalsEnabled: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");

  const withdraw = useMutation({
    mutationFn: async (body: { toAddress: string; amount: number }) => {
      const res = await apiRequest("POST", "/api/wallet/withdraw", body);
      return (await res.json()) as Withdrawal;
    },
    onSuccess: async (w) => {
      setAmount("");
      setToAddress("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/wallet"] }),
        qc.invalidateQueries({ queryKey: ["/api/me"] }),
        qc.invalidateQueries({ queryKey: ["/api/portfolio"] }),
      ]);
      toast({ title: "Withdrawal requested", description: `${usd(w.amount)} to ${shortAddress(w.toAddress)}.` });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Withdrawal failed", description: apiErrorMessage(err) });
    },
  });

  const amountNum = Number(amount);
  const addressValid = ADDRESS_RE.test(toAddress.trim());
  const amountValid = /^\d+(\.\d{1,6})?$/.test(amount) && amountNum > 0 && amountNum <= wallet.balance + 1e-9;
  const overBalance = amount !== "" && amountNum > wallet.balance + 1e-9;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <ArrowUpFromLine className="h-5 w-5 text-primary" />
        <h2 className="text-base font-bold">Withdraw</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Send USDC from your cash balance to any address on {wallet.chain.name}.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addressValid || !amountValid) return;
          withdraw.mutate({ toAddress: toAddress.trim(), amount: amountNum });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="withdraw-address">Destination address</Label>
          <Input
            id="withdraw-address"
            placeholder="0x…"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            className="rounded-lg font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          {toAddress && !addressValid && <p className="text-xs text-no">Enter a valid EVM address (0x + 40 hex characters).</p>}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="withdraw-amount">Amount</Label>
            <span className="text-xs text-muted-foreground tabular">Available {usd(wallet.balance)}</span>
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span>
            <Input
              id="withdraw-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              className="rounded-lg pl-7 pr-16 tabular"
            />
            <button
              type="button"
              onClick={() => setAmount((Math.floor(wallet.balance * 1e6) / 1e6).toString())}
              className="absolute inset-y-0 right-2 my-auto h-7 rounded-md px-2 text-xs font-semibold text-primary hover:bg-primary/10"
            >
              Max
            </button>
          </div>
          {overBalance && <p className="text-xs text-no">Amount exceeds your available balance.</p>}
        </div>
        <Button type="submit" className="w-full rounded-lg" disabled={!addressValid || !amountValid || withdraw.isPending}>
          {withdraw.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Withdraw {amountValid ? usd(amountNum) : "USDC"}
        </Button>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        Withdrawals are paid from the platform treasury and may take a few minutes.
      </p>
      {!withdrawalsEnabled && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Withdrawals are processed manually by an admin. You will see the transaction hash here once it is sent.
        </div>
      )}
    </section>
  );
}

function HistoryCard({ wallet }: { wallet: WalletView }) {
  const explorer = wallet.chain.explorer;
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-base font-bold">History</h2>
      <Tabs defaultValue="deposits" className="mt-3">
        <TabsList className="rounded-lg">
          <TabsTrigger value="deposits" className="rounded-md">
            Deposits
            {wallet.deposits.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{wallet.deposits.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="withdrawals" className="rounded-md">
            Withdrawals
            {wallet.withdrawals.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{wallet.withdrawals.length}</span>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="deposits" className="mt-3">
          {wallet.deposits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              No deposits yet. Confirmed on-chain transfers will be listed here.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Time</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Transaction</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallet.deposits.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
                        {format(new Date(d.createdAt), "MMM d, yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right font-medium text-yes tabular">+{usd(d.amount)}</TableCell>
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
          {wallet.withdrawals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              No withdrawals yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Time</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Transaction</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallet.withdrawals.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
                        {format(new Date(w.createdAt), "MMM d, yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right font-medium text-no tabular">-{usd(w.amount)}</TableCell>
                      <TableCell>
                        <a
                          href={`${explorer}/address/${w.toAddress}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs hover:underline"
                        >
                          {shortAddress(w.toAddress)}
                        </a>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <StatusPill status={w.status} />
                          {w.status === "failed" && w.error && <span className="text-xs text-no">{w.error}</span>}
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

export default function WalletPage() {
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const config = useConfig();

  const { data: wallet, isLoading, error } = useQuery<WalletView>({
    queryKey: ["/api/wallet"],
    enabled: !!user,
  });

  if (authLoading) {
    return (
      <PageShell>
        <WalletSkeleton />
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
            <WalletIcon className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Log in to manage your wallet</h1>
          <p className="mt-2 text-sm text-muted-foreground">Deposit and withdraw USDC, and review your transaction history.</p>
          <Button className="mt-6 rounded-lg" onClick={openLogin}>
            <LogIn className="mr-2 h-4 w-4" />
            Log in
          </Button>
        </div>
      </PageShell>
    );
  }

  if (isLoading || (!wallet && !error)) {
    return (
      <PageShell>
        <WalletSkeleton />
      </PageShell>
    );
  }

  if (error || !wallet) {
    return (
      <PageShell>
        <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center">
          <h1 className="text-lg font-bold">Could not load your wallet</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(error)}</p>
        </div>
      </PageShell>
    );
  }

  const chain = wallet.chain;
  const depositsEnabled = config?.depositsEnabled ?? true;
  const withdrawalsEnabled = config?.withdrawalsEnabled ?? true;

  return (
    <PageShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Wallet</h1>

        <section className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cash balance</div>
            <div className="mt-1 text-4xl font-bold text-yes tabular">{usd(wallet.balance)}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>USDC on {chain.name}</span>
              {chain.testnet && (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                  Testnet
                </span>
              )}
            </div>
          </div>
          <div className="text-sm text-muted-foreground sm:text-right">
            <div>Available for trading and withdrawal.</div>
            <div className="mt-0.5">Each share pays $1.00 if its outcome wins.</div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <DepositCard wallet={wallet} depositsEnabled={depositsEnabled} />
            {chain.testnet && <FaucetCard />}
          </div>
          <WithdrawCard wallet={wallet} withdrawalsEnabled={withdrawalsEnabled} />
        </div>

        <HistoryCard wallet={wallet} />
      </div>
    </PageShell>
  );
}
