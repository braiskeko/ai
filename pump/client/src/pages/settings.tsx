import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Contrast,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  HelpCircle,
  KeyRound,
  Landmark,
  Loader2,
  LogOut,
  Pencil,
  Scale,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";
import type { Portfolio, SafeUser } from "@shared/schema";
import { BIO_MAX } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { PublicAvatar } from "@/components/TradesTable";
import { useDepositSheet } from "@/components/DepositSheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useEmbeddedWallet } from "@/hooks/useEmbeddedWallet";
import { useToast } from "@/hooks/use-toast";
import { LanguageSwitcher, useLocale, useT } from "@/i18n";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { resizeImageToDataUrl } from "@/components/Comments";
import { cn } from "@/lib/utils";

/**
 * Settings, and the screens behind each row.
 *
 * Only rows that do something are here: the ones that would need a service Next
 * does not run (push notifications, a support desk) are either honest local
 * toggles or plain answers rather than dead links.
 */

type Section = "account" | "appearance" | "language" | "notifications" | "security" | "funds" | "legal" | "taxes" | "help";

const PREFS_KEY = "nx_prefs";

interface Prefs {
  /** Vibrate on a filled trade, where the browser supports it. */
  haptics: boolean;
  /** Toast when somebody launches a coin while you are browsing. */
  launchAlerts: boolean;
}

const DEFAULT_PREFS: Prefs = { haptics: true, launchAlerts: true };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

export default function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const current = (section ?? "") as Section | "";
  if (current === "account") return <EditProfile />;
  if (current === "appearance") return <Appearance />;
  if (current === "language") return <LanguageSection />;
  if (current === "notifications") return <Notifications />;
  if (current === "security") return <Security />;
  if (current === "funds") return <Funds />;
  if (current === "legal") return <Legal />;
  if (current === "taxes") return <Taxes />;
  if (current === "help") return <Help />;
  return <SettingsIndex />;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function SettingsIndex() {
  const t = useT();
  const { user, logout } = useAuth();
  const { locale } = useLocale();

  useEffect(() => {
    document.title = `${t("settings.title")} · ${t("app.name")}`;
  }, [t]);

  return (
    <Shell title={t("settings.title")} back="/profile" large>
      <ul className="mt-2">
        <Row href="/settings/account" icon={<UserIcon className="h-5 w-5" />} label={t("settings.account")} />
        <Row href="/settings/appearance" icon={<Contrast className="h-5 w-5" />} label={t("settings.appearance")} />
        <Row href="/settings/language" icon={<Globe className="h-5 w-5" />} label={t("settings.language")} value={locale.toUpperCase()} />
        <Row href="/settings/notifications" icon={<Bell className="h-5 w-5" />} label={t("settings.notifications")} />
        <Row href="/settings/security" icon={<ShieldCheck className="h-5 w-5" />} label={t("settings.security")} />
        <Row href="/settings/funds" icon={<Landmark className="h-5 w-5" />} label={t("settings.funds")} />
        <Row href="/settings/legal" icon={<Scale className="h-5 w-5" />} label={t("settings.legal")} />
        <Row href="/settings/taxes" icon={<FileText className="h-5 w-5" />} label={t("settings.taxes")} />
        <Row href="/settings/help" icon={<HelpCircle className="h-5 w-5" />} label={t("settings.help")} />
      </ul>

      {user && (
        <button
          type="button"
          onClick={() => void logout()}
          className="tap mt-2 flex w-full items-center gap-4 border-t border-border py-4 text-left text-[17px] font-semibold text-down"
        >
          <LogOut className="h-5 w-5" />
          {t("nav.logout")}
        </button>
      )}
    </Shell>
  );
}

function Row({ href, icon, label, value }: { href: string; icon: ReactNode; label: string; value?: string }) {
  return (
    <li className="border-b border-border">
      <Link href={href} className="tap flex items-center gap-4 py-4">
        <span className="shrink-0 text-foreground">{icon}</span>
        <span className="flex-1 text-[17px] font-semibold">{label}</span>
        {value && <span className="text-[15px] text-muted-foreground">{value}</span>}
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

/** Every settings screen shares this frame: a back chevron, a title, and the content. */
function Shell({ title, back, children, large }: { title: string; back: string; children: ReactNode; large?: boolean }) {
  const t = useT();
  return (
    <PageShell noHeader className="pt-4">
      <div className="mx-auto w-full max-w-2xl">
        <div className={cn("flex items-center gap-3", large ? "mb-2" : "mb-5")}>
          <Link href={back} aria-label={t("common.back")} className="tap -ml-1 shrink-0 text-muted-foreground">
            <ChevronLeft className="h-6 w-6" />
          </Link>
          {!large && <h1 className="flex-1 text-center text-[19px] font-bold">{title}</h1>}
          {!large && <span className="w-6 shrink-0" aria-hidden />}
        </div>
        {large && <h1 className="mb-4 text-[34px] font-extrabold tracking-tight">{title}</h1>}
        {children}
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Edit profile
// ---------------------------------------------------------------------------

function EditProfile() {
  const t = useT();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { vault } = useEmbeddedWallet();
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [showAddresses, setShowAddresses] = useState(false);

  useEffect(() => {
    if (!user) return;
    setUsername(user.username);
    setDisplayName(user.displayName ?? "");
    setBio(user.bio ?? "");
  }, [user]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/me", { username: username.trim(), displayName: displayName.trim(), bio: bio.trim() });
      return (await res.json()) as SafeUser;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/me"], next);
      void queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/users/"),
      });
      toast({ title: t("settings.saved") });
      navigate("/settings");
    },
    onError: (err) => toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) }),
  });

  if (!user) {
    return (
      <Shell title={t("settings.account")} back="/settings">
        <p className="text-sm text-muted-foreground">{t("profile.signedOutHint")}</p>
      </Shell>
    );
  }

  const dirty =
    username.trim() !== user.username || displayName.trim() !== (user.displayName ?? "") || bio.trim() !== (user.bio ?? "");
  const addresses = [
    { label: "Solana", value: user.walletAddress ?? vault?.solana ?? "" },
    { label: "EVM", value: vault?.evm ?? "" },
  ].filter((a) => a.value);

  return (
    <Shell title={t("settings.editProfile")} back="/settings">
      {/* Banner with the avatar overlapping it, both editable. */}
      <div className="relative mb-14">
        <BannerPicker user={user} />
        <div className="absolute -bottom-10 left-2">
          <AvatarPicker user={user} />
        </div>
      </div>

      <Field label={t("settings.username")}>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">@</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
            maxLength={24}
            spellCheck={false}
            className="w-full bg-transparent text-[17px] font-semibold outline-none"
          />
        </div>
      </Field>

      <Field label={t("settings.displayName")}>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={32}
          placeholder={user.username}
          className="w-full bg-transparent text-[17px] font-semibold outline-none placeholder:text-muted-foreground"
        />
      </Field>

      <Field label={t("settings.bio")} hint={`${bio.length} / ${BIO_MAX}`}>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
          rows={3}
          placeholder={t("settings.bioPlaceholder")}
          className="w-full resize-none bg-transparent text-[17px] outline-none placeholder:text-muted-foreground"
        />
      </Field>

      <div className="mt-4 flex items-center gap-2 text-[15px] text-muted-foreground">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-muted text-xs font-bold uppercase">
          {user.provider.slice(0, 1)}
        </span>
        <span className="truncate">{user.email}</span>
      </div>

      {addresses.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setShowAddresses((v) => !v)}
            className="tap flex w-full items-center justify-between text-[17px] font-bold"
          >
            {t("settings.addresses", { n: String(addresses.length) })}
            <ChevronRight className={cn("h-5 w-5 text-muted-foreground transition-transform", showAddresses && "rotate-90")} />
          </button>
          {showAddresses && (
            <ul className="mt-3 space-y-3">
              {addresses.map((a) => (
                <li key={a.label}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{a.label}</div>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(a.value).then(
                        () => toast({ title: t("deposit.copied") }),
                        () => toast({ variant: "destructive", title: t("common.error") }),
                      );
                    }}
                    className="tap mt-1 flex w-full items-center gap-2 break-all rounded-xl bg-card px-3 py-2 text-left font-mono text-[13px]"
                  >
                    <span className="min-w-0 flex-1">{a.value}</span>
                    <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Button
        type="button"
        size="lg"
        disabled={!dirty || save.isPending || username.trim().length < 3}
        onClick={() => save.mutate()}
        className="tap mt-8 h-14 w-full rounded-2xl text-base font-bold"
      >
        {save.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : t("settings.save")}
      </Button>
    </Shell>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[15px] text-muted-foreground">{label}</span>
        {hint && <span className="text-[13px] tabular text-muted-foreground">{hint}</span>}
      </div>
      <div className="rounded-2xl bg-card px-4 py-3">{children}</div>
    </div>
  );
}

/** Uploads to `/api/me/avatar`, resizing in the browser first. */
function AvatarPicker({ user }: { user: SafeUser }) {
  const t = useT();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await resizeImageToDataUrl(file, 256);
      const res = await apiRequest("POST", "/api/me/avatar", { image });
      queryClient.setQueryData(["/api/me"], (await res.json()) as SafeUser);
    } catch (err) {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="relative">
      <PublicAvatar user={user} size={80} className="ring-4 ring-background" />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        aria-label={t("portfolio.avatar")}
        className="absolute bottom-0 right-0 grid h-7 w-7 place-items-center rounded-full border-2 border-background bg-foreground text-background"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3 w-3" />}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
    </div>
  );
}

function BannerPicker({ user }: { user: SafeUser }) {
  const t = useT();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await resizeImageToDataUrl(file, 1200);
      const res = await apiRequest("POST", "/api/me/banner", { image });
      queryClient.setQueryData(["/api/me"], (await res.json()) as SafeUser);
    } catch (err) {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="relative h-28 overflow-hidden rounded-2xl bg-card">
      {user.bannerUrl && <img src={user.bannerUrl} alt="" className="h-full w-full object-cover" />}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        aria-label={t("settings.banner")}
        className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-background/80 text-foreground backdrop-blur"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The smaller screens
// ---------------------------------------------------------------------------

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-4">
      <div className="min-w-0">
        <div className="text-[17px] font-semibold">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Appearance() {
  const t = useT();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  const setTheme = (next: boolean) => {
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  };

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

  return (
    <Shell title={t("settings.appearance")} back="/settings">
      <Toggle label={t("settings.darkMode")} checked={dark} onChange={setTheme} />
      <Toggle
        label={t("settings.haptics")}
        hint={canVibrate ? t("settings.hapticsHint") : t("settings.hapticsUnsupported")}
        checked={prefs.haptics && canVibrate}
        onChange={(v) => {
          update({ haptics: v });
          if (v && canVibrate) navigator.vibrate(12);
        }}
      />
    </Shell>
  );
}

function LanguageSection() {
  const t = useT();
  return (
    <Shell title={t("settings.language")} back="/settings">
      <LanguageSwitcher variant="row" />
    </Shell>
  );
}

function Notifications() {
  const t = useT();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  return (
    <Shell title={t("settings.notifications")} back="/settings">
      <Toggle
        label={t("settings.launchAlerts")}
        hint={t("settings.launchAlertsHint")}
        checked={prefs.launchAlerts}
        onChange={(v) => {
          const next = { ...prefs, launchAlerts: v };
          setPrefs(next);
          savePrefs(next);
        }}
      />
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t("settings.pushNote")}</p>
    </Shell>
  );
}

function Security() {
  const t = useT();
  const { toast } = useToast();
  const { vault } = useEmbeddedWallet();
  const [revealed, setRevealed] = useState(false);

  return (
    <Shell title={t("settings.security")} back="/settings">
      <div className="rounded-2xl border border-gold/40 bg-gold/5 p-4">
        <div className="flex items-center gap-2 text-gold">
          <KeyRound className="h-4 w-4" />
          <h2 className="text-base font-bold">{t("wallet.recovery")}</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t("wallet.recoveryHint")}</p>
        {!vault ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("settings.noWallet")}</p>
        ) : revealed ? (
          <>
            <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {vault.mnemonic.split(" ").map((word, i) => (
                <li key={`${word}-${i}`} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium">
                  <span className="mr-2 text-xs tabular text-muted-foreground">{i + 1}</span>
                  {word}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                className="rounded-xl font-semibold"
                onClick={() =>
                  void navigator.clipboard.writeText(vault.mnemonic).then(
                    () => toast({ title: t("wallet.phraseCopied") }),
                    () => toast({ variant: "destructive", title: t("wallet.copyFailed") }),
                  )
                }
              >
                <Copy className="h-4 w-4" />
                {t("wallet.copyPhrase")}
              </Button>
              <Button variant="ghost" className="rounded-xl font-semibold" onClick={() => setRevealed(false)}>
                <EyeOff className="h-4 w-4" />
                {t("wallet.hide")}
              </Button>
            </div>
          </>
        ) : (
          <Button variant="outline" className="mt-4 rounded-xl font-semibold" onClick={() => setRevealed(true)}>
            <Eye className="h-4 w-4" />
            {t("wallet.reveal")}
          </Button>
        )}
      </div>

      <Button asChild variant="outline" className="mt-4 h-12 w-full rounded-2xl font-semibold">
        <Link href="/wallet">{t("settings.walletScreen")}</Link>
      </Button>
    </Shell>
  );
}

function Funds() {
  const t = useT();
  const deposit = useDepositSheet();
  return (
    <Shell title={t("settings.funds")} back="/settings">
      <Button size="lg" className="h-14 w-full rounded-2xl text-base font-bold" onClick={deposit.open}>
        {t("home.deposit")}
      </Button>
      <Button asChild size="lg" variant="outline" className="mt-3 h-14 w-full rounded-2xl text-base font-bold">
        <Link href="/wallet">{t("settings.withdraw")}</Link>
      </Button>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t("settings.fundsNote")}</p>
      {deposit.sheet}
    </Shell>
  );
}

function Legal() {
  const t = useT();
  return (
    <Shell title={t("settings.legal")} back="/settings">
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>{t("settings.legalCustody")}</p>
        <p>{t("settings.legalRisk")}</p>
        <p>{t("settings.legalData")}</p>
      </div>
    </Shell>
  );
}

/** Downloads every indexed trade as CSV — what a tax return actually needs. */
function Taxes() {
  const t = useT();
  const { user } = useAuth();
  const portfolio = useQuery<Portfolio>({ queryKey: ["/api/portfolio"], enabled: !!user, staleTime: 30_000 });

  const download = () => {
    const rows = portfolio.data?.trades ?? [];
    const header = "date,side,coin,ticker,tokens,sol,fee_sol,price_sol,signature";
    const body = rows
      .map((tr) =>
        [
          tr.createdAt,
          tr.side,
          JSON.stringify(tr.coin.name),
          tr.coin.ticker,
          tr.tokens,
          tr.sol,
          tr.feeSol,
          tr.priceSol,
          tr.signature,
        ].join(","),
      )
      .join("\n");
    const blob = new Blob([`${header}\n${body}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `next-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Shell title={t("settings.taxes")} back="/settings">
      <p className="text-sm leading-relaxed text-muted-foreground">{t("settings.taxesHint")}</p>
      <Button
        size="lg"
        className="mt-4 h-14 w-full rounded-2xl text-base font-bold"
        disabled={!user || portfolio.isLoading}
        onClick={download}
      >
        {t("settings.exportCsv")}
      </Button>
    </Shell>
  );
}

function Help() {
  const t = useT();
  return (
    <Shell title={t("settings.help")} back="/settings">
      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>{t("settings.helpWallet")}</p>
        <p>{t("settings.helpFees")}</p>
        <p>{t("settings.helpContact")}</p>
      </div>
    </Shell>
  );
}
