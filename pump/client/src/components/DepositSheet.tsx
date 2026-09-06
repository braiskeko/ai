import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ChevronLeft, Copy, CreditCard, LayoutGrid, Loader2, QrCode } from "lucide-react";
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

interface Network {
  key: string;
  label: string;
  chain: Chain;
  /** Simplified network glyph, drawn rather than fetched. */
  glyph: ReactNode;
}

const SOLANA_GLYPH = (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
    <path d="M4.3 16.4c.2-.2.4-.3.7-.3h15c.4 0 .6.5.3.8l-3 3c-.2.2-.4.3-.7.3h-15c-.4 0-.6-.5-.3-.8l3-3Z" />
    <path d="M4.3 3.8c.2-.2.5-.3.7-.3h15c.4 0 .6.5.3.8l-3 3c-.2.2-.4.3-.7.3h-15c-.4 0-.6-.5-.3-.8l3-3Z" />
    <path d="M17.3 10.1c-.2-.2-.4-.3-.7-.3h-15c-.4 0-.6.5-.3.8l3 3c.2.2.4.3.7.3h15c.4 0 .6-.5.3-.8l-3-3Z" />
  </svg>
);

const NETWORKS: Network[] = [
  { key: "solana", label: "Solana", chain: "solana", glyph: SOLANA_GLYPH },
  {
    key: "base",
    label: "Base",
    chain: "evm",
    glyph: <span className="block h-4 w-4 rounded-[3px] bg-current" />,
  },
  {
    key: "bnb",
    label: "BNB Chain",
    chain: "evm",
    glyph: <span className="block h-4 w-4 rotate-45 rounded-[3px] border-2 border-current" />,
  },
  {
    key: "monad",
    label: "Monad",
    chain: "evm",
    glyph: <span className="block h-4 w-4 rotate-45 rounded-[5px] bg-current" />,
  },
  {
    key: "hyperliquid",
    label: "Hyperliquid",
    chain: "evm",
    glyph: <span className="block h-4 w-4 rounded-full border-2 border-current" />,
  },
  {
    key: "ethereum",
    label: "Ethereum",
    chain: "evm",
    glyph: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
        <path d="M12 2 5.5 12.2 12 16l6.5-3.8L12 2ZM5.5 13.6 12 22l6.5-8.4L12 17.4l-6.5-3.8Z" />
      </svg>
    ),
  },
];

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
                  <span className="text-foreground">{n.glyph}</span>
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
