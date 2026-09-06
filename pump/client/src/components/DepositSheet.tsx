import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ChevronLeft, Copy, CreditCard, LayoutGrid, Loader2, QrCode } from "lucide-react";
import type { Chain as SchemaChain } from "@shared/schema";
import { CHAIN_LABELS } from "@shared/schema";
import { ChainIcon } from "@/components/ChainIcon";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useEmbeddedWallet } from "@/hooks/useEmbeddedWallet";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * "Deposit with" — the sheet every deposit button opens.
 *
 * Three steps, bottom-up: how (crypto / card / an exchange), which network, and
 * then the address for that network as a QR plus copyable text. The addresses are
 * the account's own: one Solana account and one EVM account derived from the same
 * recovery phrase, so every EVM network shares an address the way wallets do.
 */

type Step = "how" | "network" | "address";
type Chain = "solana" | "evm";

const NETWORKS: { key: string; label: string; chain: Chain; icon: SchemaChain }[] = [
  { key: "solana", label: CHAIN_LABELS.solana, chain: "solana", icon: "solana" },
  { key: "base", label: CHAIN_LABELS.base, chain: "evm", icon: "base" },
  { key: "bnb", label: CHAIN_LABELS.bsc, chain: "evm", icon: "bsc" },
  { key: "monad", label: CHAIN_LABELS.monad, chain: "evm", icon: "monad" },
  { key: "hyperliquid", label: CHAIN_LABELS.hyperliquid, chain: "evm", icon: "hyperliquid" },
  { key: "robinhood", label: CHAIN_LABELS.robinhood, chain: "evm", icon: "robinhood" },
  { key: "ethereum", label: CHAIN_LABELS.ethereum, chain: "evm", icon: "ethereum" },
];

type Network = (typeof NETWORKS)[number];

export function DepositSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const { toast } = useToast();
  const { user, openLogin } = useAuth();
  const { vault, provision, provisioning } = useEmbeddedWallet();
  const [step, setStep] = useState<Step>("how");
  const [network, setNetwork] = useState<Network>(NETWORKS[0]);

  // Every open starts at the first screen.
  useEffect(() => {
    if (open) setStep("how");
  }, [open]);

  const address = network.chain === "solana" ? vault?.solana : vault?.evm;

  const openCrypto = async () => {
    if (!user) {
      onOpenChange(false);
      openLogin();
      return;
    }
    if (!vault) await provision().catch(() => undefined);
    setStep("network");
  };

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast({ title: t("deposit.copied"), description: address });
    } catch {
      toast({ variant: "destructive", title: t("common.error") });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[90vh] overflow-y-auto rounded-t-[28px] border-t-0 bg-secondary/95 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" aria-hidden />

        {step === "how" && (
          <>
            <SheetTitle className="mb-5 text-center text-[22px] font-bold">{t("deposit.title")}</SheetTitle>
            <div className="space-y-3">
              <OptionRow
                title={t("deposit.crypto")}
                hint={t("deposit.cryptoHint")}
                icon={provisioning ? <Loader2 className="h-6 w-6 animate-spin" /> : <QrCode className="h-6 w-6" />}
                onClick={() => void openCrypto()}
              />
              <OptionRow
                title={t("deposit.debit")}
                hint={t("deposit.soonHint")}
                icon={<CreditCard className="h-6 w-6" />}
                disabled
              />
              <OptionRow
                title={t("deposit.exchanges")}
                hint={t("deposit.exchangesHint")}
                icon={<LayoutGrid className="h-6 w-6" />}
                disabled
              />
            </div>
          </>
        )}

        {step === "network" && (
          <>
            <SheetHeaderRow title={t("deposit.cryptoTitle")} onBack={() => setStep("how")} />
            <p className="mb-5 text-center text-[15px] text-muted-foreground">{t("deposit.chooseNetwork")}</p>
            <div className="space-y-3">
              {NETWORKS.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  onClick={() => {
                    setNetwork(n);
                    setStep("address");
                  }}
                  className="tap flex w-full items-center justify-between gap-3 rounded-2xl bg-card px-5 py-4 text-left"
                >
                  <span className="text-[19px] font-bold">{n.label}</span>
                  <ChainIcon chain={n.icon} size={28} mono className="text-muted-foreground" />
                </button>
              ))}
            </div>
          </>
        )}

        {step === "address" && (
          <>
            <SheetHeaderRow title={t("deposit.cryptoTitle")} onBack={() => setStep("network")} />
            <p className="text-center text-[15px] leading-relaxed text-muted-foreground">
              {t("deposit.sendAny", { network: network.label })}
              {network.chain === "evm" && (
                <>
                  <br />
                  {t("deposit.evmHint")}
                </>
              )}
            </p>
            <div className="mt-6 flex flex-col items-center">
              {address ? (
                <>
                  <div className="rounded-3xl bg-card p-5">
                    <QRCodeSVG value={address} size={196} bgColor="transparent" fgColor="#ffffff" level="M" />
                  </div>
                  <p className="mt-5 break-all px-4 text-center text-[17px] font-medium text-muted-foreground">{address}</p>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="tap mt-5 inline-flex h-12 items-center gap-2 rounded-2xl bg-card px-6 text-base font-bold"
                  >
                    <Copy className="h-4 w-4" />
                    {t("deposit.copyAddress")}
                  </button>
                </>
              ) : (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetHeaderRow({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="relative mb-2 flex items-center justify-center">
      <button type="button" onClick={onBack} aria-label="Back" className="tap absolute left-0 text-muted-foreground">
        <ChevronLeft className="h-6 w-6" />
      </button>
      <SheetTitle className="text-[22px] font-bold">{title}</SheetTitle>
    </div>
  );
}

function OptionRow({
  title,
  hint,
  icon,
  onClick,
  disabled,
}: {
  title: string;
  hint: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "tap flex w-full items-center justify-between gap-4 rounded-2xl bg-card px-5 py-4 text-left transition-opacity",
        disabled && "opacity-50",
      )}
    >
      <span className="min-w-0">
        <span className="block text-[21px] font-bold leading-tight">{title}</span>
        <span className="mt-1 block text-[15px] text-muted-foreground">{hint}</span>
      </span>
      <span className="shrink-0 text-foreground">{icon}</span>
    </button>
  );
}

/** Convenience wrapper: any button that should open the sheet. */
export function useDepositSheet() {
  const [open, setOpen] = useState(false);
  return { open: () => setOpen(true), sheet: <DepositSheet open={open} onOpenChange={setOpen} /> };
}

export default DepositSheet;
