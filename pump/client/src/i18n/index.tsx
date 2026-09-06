import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Check, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Lightweight i18n: every UI string lives in `./locales/<code>.json` (flat
 * `{ "ns.key": "text" }` maps). English is bundled and used as the fallback; the
 * other locales are code-split and loaded on demand.
 *
 *   const t = useT();  t("auth.title", { app: "Next" })
 *   const { locale, setLocale, locales } = useLocale();
 *   <LanguageSwitcher />
 */

export type Dict = Record<string, string>;
export type Dir = "ltr" | "rtl";
export interface LocaleInfo {
  code: string;
  /** native name shown in the switcher */
  name: string;
  dir: Dir;
}
export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

const STORAGE_KEY = "locale";
const RTL = new Set(["ar", "he", "fa", "ur"]);

const ALL_LOCALES: LocaleInfo[] = [
  { code: "en", name: "English", dir: "ltr" },
  { code: "es", name: "Español", dir: "ltr" },
  { code: "pt", name: "Português", dir: "ltr" },
  { code: "fr", name: "Français", dir: "ltr" },
  { code: "de", name: "Deutsch", dir: "ltr" },
  { code: "it", name: "Italiano", dir: "ltr" },
  { code: "nl", name: "Nederlands", dir: "ltr" },
  { code: "pl", name: "Polski", dir: "ltr" },
  { code: "ru", name: "Русский", dir: "ltr" },
  { code: "uk", name: "Українська", dir: "ltr" },
  { code: "tr", name: "Türkçe", dir: "ltr" },
  { code: "ar", name: "العربية", dir: "rtl" },
  { code: "he", name: "עברית", dir: "rtl" },
  { code: "fa", name: "فارسی", dir: "rtl" },
  { code: "hi", name: "हिन्दी", dir: "ltr" },
  { code: "bn", name: "বাংলা", dir: "ltr" },
  { code: "id", name: "Bahasa Indonesia", dir: "ltr" },
  { code: "ms", name: "Bahasa Melayu", dir: "ltr" },
  { code: "vi", name: "Tiếng Việt", dir: "ltr" },
  { code: "th", name: "ไทย", dir: "ltr" },
  { code: "zh-CN", name: "简体中文", dir: "ltr" },
  { code: "zh-TW", name: "繁體中文", dir: "ltr" },
  { code: "ja", name: "日本語", dir: "ltr" },
  { code: "ko", name: "한국어", dir: "ltr" },
  { code: "sw", name: "Kiswahili", dir: "ltr" },
  { code: "fil", name: "Filipino", dir: "ltr" },
];

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

// English is always bundled (eager) so there is never a flash of raw keys.
const eagerEn = import.meta.glob<{ default: Dict }>("./locales/en.json", { eager: true });
const en: Dict = Object.values(eagerEn)[0]?.default ?? {};

// Every other locale is a lazy chunk.
const loaders = import.meta.glob<{ default: Dict }>("./locales/*.json");
const loaderFor = (code: string) => loaders[`./locales/${code}.json`];

/** Locales that actually have a translation file on disk (en always). */
export const LOCALES: LocaleInfo[] = ALL_LOCALES.filter((l) => l.code === "en" || !!loaderFor(l.code));
const SUPPORTED = new Set(LOCALES.map((l) => l.code));

const dicts = new Map<string, Dict>([["en", en]]);
const pending = new Map<string, Promise<Dict>>();

function loadDict(code: string): Promise<Dict> {
  const cached = dicts.get(code);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(code);
  if (inflight) return inflight;
  const loader = loaderFor(code);
  if (!loader) return Promise.resolve(en);
  const p = loader()
    .then((mod) => {
      const dict = mod.default ?? {};
      dicts.set(code, dict);
      return dict;
    })
    .catch(() => en)
    .finally(() => pending.delete(code));
  pending.set(code, p);
  return p;
}

// ---------------------------------------------------------------------------
// Detection & persistence
// ---------------------------------------------------------------------------

function normalizeCode(raw: string): string | null {
  const lower = raw.toLowerCase();
  // exact (case-insensitive) match, e.g. "zh-cn" → "zh-CN"
  const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const base = lower.split("-")[0];
  if (SUPPORTED.has(base)) return base;
  // "zh" / "zh-hant" style → first supported variant of the base language
  const variant = LOCALES.find((l) => l.code.toLowerCase().split("-")[0] === base);
  return variant ? variant.code : null;
}

function storedLocale(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && SUPPORTED.has(v) ? v : null;
  } catch {
    return null;
  }
}

export function detectLocale(): string {
  const stored = storedLocale();
  if (stored) return stored;
  if (typeof navigator !== "undefined") {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const l of langs) {
      if (!l) continue;
      const code = normalizeCode(l);
      if (code) return code;
    }
  }
  return "en";
}

export const dirOf = (code: string): Dir => (RTL.has(code.split("-")[0]) ? "rtl" : "ltr");

function applyHtmlLang(code: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = code;
  document.documentElement.dir = dirOf(code);
}

// ---------------------------------------------------------------------------
// Translation core (usable outside React, e.g. from lib/useLive.ts toasts)
// ---------------------------------------------------------------------------

const VAR_RE = /\{(\w+)\}/g;

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(VAR_RE, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

let activeLocale = "en";
let activeDict: Dict = en;
const activeListeners = new Set<() => void>();

function setActive(code: string, dict: Dict) {
  activeLocale = code;
  activeDict = dict;
  activeListeners.forEach((l) => l());
}

function lookup(dict: Dict, key: string, vars?: Record<string, string | number>): string {
  const raw = dict[key] ?? en[key] ?? key;
  return interpolate(raw, vars);
}

/** Non-hook translator bound to the currently active locale (for module code such as toasts). */
export const translate: TFunction = (key, vars) => lookup(activeDict, key, vars);

/** The active locale code outside React. */
export const currentLocale = () => activeLocale;

// ---------------------------------------------------------------------------
// Provider & hooks
// ---------------------------------------------------------------------------

interface I18nContextValue {
  locale: string;
  dict: Dict;
  setLocale: (code: string) => void;
  locales: LocaleInfo[];
  /** true while a non-bundled dictionary is being fetched */
  loading: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: string }) {
  const [locale, setLocaleState] = useState<string>(() => {
    const code = initialLocale && SUPPORTED.has(initialLocale) ? initialLocale : detectLocale();
    return code;
  });
  const [dict, setDict] = useState<Dict>(() => dicts.get(locale) ?? en);
  const [loading, setLoading] = useState(false);

  // Load the dictionary whenever the locale changes; keep <html lang dir> in sync.
  useEffect(() => {
    applyHtmlLang(locale);
    const cached = dicts.get(locale);
    if (cached) {
      setDict(cached);
      setActive(locale, cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadDict(locale).then((d) => {
      if (cancelled) return;
      setDict(d);
      setActive(locale, d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((code: string) => {
    const next = normalizeCode(code) ?? "en";
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dict, setLocale, locales: LOCALES, loading }),
    [locale, dict, setLocale, loading],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT/useLocale must be used inside <I18nProvider>");
  return ctx;
}

/** Returns the translator for the active locale. Stable across renders until the dictionary changes. */
export function useT(): TFunction {
  const { dict } = useI18n();
  return useCallback<TFunction>((key, vars) => lookup(dict, key, vars), [dict]);
}

export function useLocale(): { locale: string; setLocale: (code: string) => void; locales: LocaleInfo[]; dir: Dir; loading: boolean } {
  const { locale, setLocale, locales, loading } = useI18n();
  return { locale, setLocale, locales, dir: dirOf(locale), loading };
}

/** Subscribe to the active locale from components that are outside the provider (rare). */
export function useActiveLocale(): string {
  return useSyncExternalStore(
    (cb) => {
      activeListeners.add(cb);
      return () => {
        activeListeners.delete(cb);
      };
    },
    () => activeLocale,
    () => "en",
  );
}

// ---------------------------------------------------------------------------
// LanguageSwitcher
// ---------------------------------------------------------------------------

/**
 * Globe button opening a menu with every available locale (native names).
 * - "icon": compact icon-only trigger (header/footer)
 * - "row":  full-width row with the current language name (menus)
 */
export function LanguageSwitcher({
  variant = "icon",
  className,
  align = "end",
}: {
  variant?: "icon" | "row";
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const t = useT();
  const { locale, setLocale, locales } = useLocale();
  const current = locales.find((l) => l.code === locale) ?? locales[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "row" ? (
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
              className,
            )}
            aria-label={t("nav.language")}
          >
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-left">{t("nav.language")}</span>
            <span className="text-xs text-muted-foreground">{current?.name}</span>
          </button>
        ) : (
          <button
            type="button"
            aria-label={t("nav.language")}
            title={current?.name}
            className={cn(
              "inline-flex h-9 items-center justify-center gap-1 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
              className,
            )}
          >
            <Globe className="h-4 w-4" />
            <span className="hidden text-xs font-semibold uppercase lg:inline">{locale.split("-")[0]}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[70vh] w-56 overflow-y-auto rounded-xl">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("nav.language")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {locales.map((l) => {
          const active = l.code === locale;
          return (
            <DropdownMenuItem
              key={l.code}
              onSelect={() => setLocale(l.code)}
              className={cn("cursor-pointer gap-2", active && "font-semibold")}
              lang={l.code}
              dir={l.dir}
            >
              <span className="flex-1">{l.name}</span>
              {active && <Check className="h-4 w-4 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
