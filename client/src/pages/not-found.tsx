import { Link } from "wouter";
import { ArrowLeft, Compass } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <PageShell className="flex items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">🔮</div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">This page has a 0% chance</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn't find what you were looking for. The market may have been removed or the link is wrong.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button asChild className="rounded-lg font-semibold">
            <Link href="/markets">
              <Compass className="h-4 w-4" />
              Browse markets
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-lg font-semibold">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Back home
            </Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
