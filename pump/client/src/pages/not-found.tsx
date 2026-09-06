import { Link } from "wouter";
import { ArrowLeft, Compass, PlusCircle } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

/** Also usable inline from other pages: `<NotFound title={t("coin.notFound")} hint={...} />`. */
export default function NotFound({ title, hint }: { title?: string; hint?: string; params?: unknown } = {}) {
  const t = useT();
  return (
    <PageShell className="flex items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Compass className="h-6 w-6" />
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{title ?? t("common.notFound")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{hint ?? t("common.notFoundHint")}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button asChild className="rounded-lg font-semibold">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              {t("common.goHome")}
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-lg font-semibold">
            <Link href="/create">
              <PlusCircle className="h-4 w-4" />
              {t("nav.create")}
            </Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
