import { useEffect } from "react";
import { useLocation } from "wouter";
import { PageShell } from "@/components/PageShell";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import Profile from "@/pages/profile";

/**
 * `/profile` — the signed-in user's own page. The bottom tab points here rather than at
 * `/u/<username>` so it works before the session has loaded and keeps working if the
 * user renames themselves; anyone signed out is sent to the wallet screen to connect.
 */
export default function MyProfile() {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !user) navigate("/wallet", { replace: true });
  }, [isLoading, user, navigate]);

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
  if (!user) return null;
  return <Profile username={user.username} />;
}
