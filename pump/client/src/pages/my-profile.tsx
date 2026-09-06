import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import Profile from "@/pages/profile";

/**
 * `/profile` — the signed-in user's own page. The bottom tab points here rather than at
 * `/u/<username>` so it works before the session has loaded and keeps working if the
 * user renames themselves. Signed out it invites you in rather than sending you
 * somewhere else — a tab should land where it says it will.
 */
export default function MyProfile() {
  const t = useT();
  const { user, isLoading, openLogin } = useAuth();

  if (isLoading) {
    return (
      <PageShell>
        <div className="space-y-4">
          <Skeleton className="h-24 w-24 rounded-full" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </PageShell>
    );
  }
  if (!user) {
    return (
      <PageShell noHeader className="flex items-center justify-center">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
          <h1 className="text-xl font-extrabold">{t("profile.signedOutTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("profile.signedOutHint")}</p>
          <Button size="lg" className="tap mt-6 h-12 rounded-2xl px-8 font-bold" onClick={openLogin}>
            {t("nav.login")}
          </Button>
        </div>
      </PageShell>
    );
  }
  return <Profile username={user.username} />;
}
