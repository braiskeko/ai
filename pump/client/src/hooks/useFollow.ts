import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest } from "@/lib/queryClient";

/**
 * Follow / unfollow a wallet — any trader is followable whether or not they
 * have a Next account (see server `POST /api/follow` / `DELETE /api/follow/:wallet`).
 * Shared by the search, people and profile pages.
 */
export function useFollowMutation() {
  const qc = useQueryClient();
  const { user, openLogin } = useAuth();
  const { toast } = useToast();
  const t = useT();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["/api/traders"], exact: false });
    void qc.invalidateQueries({ queryKey: ["/api/feed"], exact: false });
    void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/users/") });
  };

  const onError = (err: unknown) => {
    toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
  };

  const follow = useMutation({
    mutationFn: (wallet: string) => apiRequest("POST", "/api/follow", { wallet }),
    onSuccess: invalidate,
    onError,
  });

  const unfollow = useMutation({
    mutationFn: (wallet: string) => apiRequest("DELETE", `/api/follow/${encodeURIComponent(wallet)}`),
    onSuccess: invalidate,
    onError,
  });

  /** Toggles the follow state for `wallet`. Opens the login dialog when signed out. */
  const toggle = (wallet: string, isFollowing: boolean) => {
    if (!user) {
      openLogin();
      return;
    }
    if (isFollowing) unfollow.mutate(wallet);
    else follow.mutate(wallet);
  };

  return { toggle, pending: follow.isPending || unfollow.isPending };
}
