import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, MessageSquare, Users, Activity as ActivityIcon } from "lucide-react";
import type { CommentView, MarketDetail, MarketOutcome, PublicUser, Trade } from "@shared/schema";
import { YES_COLOR, NO_COLOR } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { cents, shares as fmtShares, timeAgo, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/UserAvatar";
import { useToast } from "@/hooks/use-toast";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";

const MAX_BODY = 1000;

function outcomeColor(market: MarketDetail, outcome: MarketOutcome | undefined): string {
  if (!outcome) return "hsl(var(--muted-foreground))";
  if (market.binary) return outcome.id === 0 ? YES_COLOR : NO_COLOR;
  return outcome.color;
}

function findOutcome(market: MarketDetail, id: number): MarketOutcome | undefined {
  return market.outcomes.find((o) => o.id === id);
}

/** Inserts or replaces a comment in the cached MarketDetail (dedupe by id, prepend when new). */
function upsertComment(qc: ReturnType<typeof useQueryClient>, slug: string, comment: CommentView) {
  qc.setQueryData<MarketDetail>([`/api/markets/${slug}`], (prev) => {
    if (!prev) return prev;
    const exists = prev.comments.some((c) => c.id === comment.id);
    const comments = exists
      ? prev.comments.map((c) => (c.id === comment.id ? comment : c))
      : [comment, ...prev.comments];
    return { ...prev, comments, commentCount: exists ? prev.commentCount : prev.commentCount + 1 };
  });
}

export function Comments({ market }: { market: MarketDetail }) {
  const commentCount = market.comments.length;
  return (
    <Tabs defaultValue="comments" className="w-full">
      <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0">
        <UnderlineTab value="comments">Comments ({commentCount})</UnderlineTab>
        <UnderlineTab value="holders">Top Holders</UnderlineTab>
        <UnderlineTab value="activity">Activity</UnderlineTab>
      </TabsList>
      <TabsContent value="comments" className="mt-4">
        <CommentsTab market={market} />
      </TabsContent>
      <TabsContent value="holders" className="mt-4">
        <HoldersTab market={market} />
      </TabsContent>
      <TabsContent value="activity" className="mt-4">
        <ActivityTab market={market} />
      </TabsContent>
    </Tabs>
  );
}

function UnderlineTab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="relative -mb-px rounded-none border-b-2 border-transparent bg-transparent px-3 py-2.5 text-sm font-semibold text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

// ---------------------------------------------------------------------------
// Comments tab
// ---------------------------------------------------------------------------

function CommentsTab({ market }: { market: MarketDetail }) {
  const { user } = useAuth();

  const { roots, repliesByParent } = useMemo(() => {
    const byId = new Map<number, CommentView>();
    for (const c of market.comments) byId.set(c.id, c);
    const roots: CommentView[] = [];
    const repliesByParent = new Map<number, CommentView[]>();
    for (const c of market.comments) {
      // Treat replies to unknown parents as top-level so nothing disappears.
      if (c.parentId !== null && byId.has(c.parentId)) {
        const list = repliesByParent.get(c.parentId) ?? [];
        list.push(c);
        repliesByParent.set(c.parentId, list);
      } else {
        roots.push(c);
      }
    }
    const ts = (c: CommentView) => new Date(c.createdAt).getTime();
    roots.sort((a, b) => ts(b) - ts(a));
    repliesByParent.forEach((list) => list.sort((a, b) => ts(a) - ts(b)));
    return { roots, repliesByParent };
  }, [market.comments]);

  return (
    <div className="space-y-5">
      <Composer market={market} parentId={null} placeholder="Add a comment" />

      {roots.length === 0 ? (
        <EmptyState icon={<MessageSquare className="h-5 w-5" />} title="No comments yet">
          {user ? "Be the first to share your view." : "Log in to start the conversation."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {roots.map((c) => (
            <li key={c.id} className="py-4 first:pt-0">
              <CommentItem market={market} comment={c} />
              {(repliesByParent.get(c.id) ?? []).length > 0 && (
                <ul className="ml-5 mt-3 space-y-3 border-l-2 border-border pl-4 sm:ml-9">
                  {(repliesByParent.get(c.id) ?? []).map((r) => (
                    <li key={r.id}>
                      <CommentItem market={market} comment={r} replyTo={c.id} compact />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Composer({
  market,
  parentId,
  placeholder,
  autoFocus,
  onDone,
  compact,
}: {
  market: MarketDetail;
  parentId: number | null;
  placeholder: string;
  autoFocus?: boolean;
  onDone?: () => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, openLogin } = useAuth();
  const [body, setBody] = useState("");
  const trimmed = body.trim();

  const post = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/markets/${market.id}/comments`, {
        body: trimmed,
        parentId: parentId ?? undefined,
      });
      return (await res.json()) as CommentView;
    },
    onSuccess: (comment) => {
      upsertComment(qc, market.slug, comment);
      setBody("");
      onDone?.();
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not post comment", description: apiErrorMessage(err) });
    },
  });

  if (!user) {
    if (compact) {
      return (
        <Button variant="outline" size="sm" onClick={openLogin}>
          Log in to reply
        </Button>
      );
    }
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <span className="text-sm text-muted-foreground">Join the discussion</span>
        <Button size="sm" onClick={openLogin}>
          Log in to comment
        </Button>
      </div>
    );
  }

  const submit = () => {
    if (!trimmed || post.isPending) return;
    post.mutate();
  };

  return (
    <div className={cn("flex gap-3", compact && "mt-2")}>
      <UserAvatar seed={user.avatarSeed} name={user.username} size={compact ? 24 : 32} className="mt-1" />
      <div className="min-w-0 flex-1">
        <Textarea
          value={body}
          autoFocus={autoFocus}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? 2 : 3}
          className={cn("resize-none rounded-lg", compact ? "min-h-[56px]" : "min-h-[72px]")}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground tabular">
            {body.length > MAX_BODY * 0.8 ? `${body.length}/${MAX_BODY}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {onDone && (
              <Button variant="ghost" size="sm" onClick={onDone} disabled={post.isPending}>
                Cancel
              </Button>
            )}
            <Button size="sm" onClick={submit} disabled={!trimmed || post.isPending} className="min-w-[64px]">
              {post.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : parentId ? "Reply" : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentItem({
  market,
  comment,
  replyTo,
  compact,
}: {
  market: MarketDetail;
  comment: CommentView;
  /** id of the root comment this reply belongs to (replies attach to the root) */
  replyTo?: number;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, openLogin } = useAuth();
  const [replying, setReplying] = useState(false);

  const liked = !!user && comment.likes.includes(user.id);
  const likeCount = comment.likes.length;

  const like = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/comments/${comment.id}/like`);
      return (await res.json()) as CommentView;
    },
    onMutate: () => {
      if (!user) return;
      // Optimistic toggle; the server response replaces it.
      upsertComment(qc, market.slug, {
        ...comment,
        likes: liked ? comment.likes.filter((id) => id !== user.id) : [...comment.likes, user.id],
      });
    },
    onSuccess: (updated) => upsertComment(qc, market.slug, updated),
    onError: (err) => {
      upsertComment(qc, market.slug, comment);
      toast({ variant: "destructive", title: "Could not update like", description: apiErrorMessage(err) });
    },
  });

  const onLike = () => {
    if (!user) {
      openLogin();
      return;
    }
    if (!like.isPending) like.mutate();
  };

  const posOutcome = comment.position ? findOutcome(market, comment.position.outcomeId) : undefined;
  const posColor = outcomeColor(market, posOutcome);

  return (
    <div className="flex gap-3">
      <UserAvatar seed={comment.user.avatarSeed} name={comment.user.username} size={compact ? 24 : 32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold">{comment.user.username}</span>
          {comment.position && posOutcome && comment.position.shares > 0 && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular"
              style={{ background: `${posColor}1f`, color: posColor }}
              title={`Holds ${fmtShares(comment.position.shares)} ${posOutcome.name} shares`}
            >
              {fmtShares(comment.position.shares)} {posOutcome.name}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{timeAgo(comment.createdAt)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{comment.body}</p>
        <div className="mt-1.5 flex items-center gap-4 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onLike}
            aria-pressed={liked}
            aria-label={liked ? "Unlike" : "Like"}
            className={cn(
              "inline-flex items-center gap-1 rounded-md py-0.5 font-medium transition-colors hover:text-foreground",
              liked && "text-no hover:text-no",
            )}
          >
            <Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} />
            <span className="tabular">{likeCount > 0 ? likeCount : ""}</span>
          </button>
          <button
            type="button"
            onClick={() => (user ? setReplying((v) => !v) : openLogin())}
            className="font-medium transition-colors hover:text-foreground"
          >
            Reply
          </button>
        </div>
        {replying && (
          <Composer
            market={market}
            parentId={replyTo ?? comment.id}
            placeholder={`Reply to ${comment.user.username}`}
            autoFocus
            compact
            onDone={() => setReplying(false)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top holders tab
// ---------------------------------------------------------------------------

type Holder = { user: PublicUser; outcomeId: number; shares: number };

function HoldersTab({ market }: { market: MarketDetail }) {
  const holders = useMemo(
    () => market.holders.filter((h) => h.shares > 1e-6).slice().sort((a, b) => b.shares - a.shares),
    [market.holders],
  );

  if (holders.length === 0) {
    return (
      <EmptyState icon={<Users className="h-5 w-5" />} title="No holders yet">
        Positions will show up here once someone trades.
      </EmptyState>
    );
  }

  if (market.binary) {
    const yes = holders.filter((h) => h.outcomeId === 0);
    const no = holders.filter((h) => h.outcomeId === 1);
    return (
      <div className="grid gap-6 md:grid-cols-2">
        <HolderList title="Yes holders" holders={yes} color={YES_COLOR} market={market} />
        <HolderList title="No holders" holders={no} color={NO_COLOR} market={market} />
      </div>
    );
  }

  return <HolderList title="Holders" holders={holders} market={market} showOutcome />;
}

function HolderList({
  title,
  holders,
  color,
  market,
  showOutcome,
}: {
  title: string;
  holders: Holder[];
  color?: string;
  market: MarketDetail;
  showOutcome?: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
          {title}
        </span>
        <span>Shares</span>
      </div>
      {holders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          Nobody yet
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {holders.map((h, i) => {
            const outcome = findOutcome(market, h.outcomeId);
            const oc = outcomeColor(market, outcome);
            return (
              <li key={`${h.user.id}-${h.outcomeId}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{i + 1}</span>
                <UserAvatar seed={h.user.avatarSeed} name={h.user.username} size={28} />
                <span className="min-w-0 flex-1 truncate font-medium">{h.user.username}</span>
                {showOutcome && outcome && (
                  <span
                    className="hidden rounded-full px-2 py-0.5 text-[11px] font-semibold sm:inline-flex"
                    style={{ background: `${oc}1f`, color: oc }}
                  >
                    {outcome.name}
                  </span>
                )}
                <span className="font-semibold tabular">{fmtShares(h.shares)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity tab
// ---------------------------------------------------------------------------

function ActivityTab({ market }: { market: MarketDetail }) {
  const trades = useMemo(
    () =>
      market.recentTrades
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [market.recentTrades],
  );

  if (trades.length === 0) {
    return (
      <EmptyState icon={<ActivityIcon className="h-5 w-5" />} title="No trades yet">
        Trades on this market will appear here in real time.
      </EmptyState>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {trades.map((t) => (
        <li key={t.id}>
          <TradeRow market={market} trade={t} />
        </li>
      ))}
    </ul>
  );
}

function TradeRow({ market, trade }: { market: MarketDetail; trade: Trade & { user: PublicUser } }) {
  const outcome = findOutcome(market, trade.outcomeId);
  const color = outcomeColor(market, outcome);
  const bought = trade.side === "buy";
  return (
    <div className="flex items-center gap-3 py-2.5 text-sm">
      <UserAvatar seed={trade.user.avatarSeed} name={trade.user.username} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1 leading-snug">
          <span className="font-semibold">{trade.user.username}</span>
          <span className="text-muted-foreground">{bought ? "bought" : "sold"}</span>
          <span className="font-medium tabular">{fmtShares(trade.shares)}</span>
          <span className="font-semibold" style={{ color }}>
            {outcome?.name ?? `Outcome ${trade.outcomeId}`}
          </span>
          <span className="text-muted-foreground">at</span>
          <span className="font-medium tabular">{cents(trade.avgPrice)}</span>
          <span className="text-muted-foreground tabular">({usd(trade.amount)})</span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(trade.createdAt)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
