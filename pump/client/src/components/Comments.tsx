import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Heart, ImagePlus, Loader2, MessageSquare, X } from "lucide-react";
import { Link } from "wouter";
import type { CoinDetail, CommentView } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { HoldersTable } from "@/components/HoldersTable";
import { EmptyBox, PublicAvatar, TradesTable } from "@/components/TradesTable";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { timeAgo, tokens as fmtTokens } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const MAX_BODY = 500;
const MAX_IMAGE_PX = 800;
/** Keep well under the server's 1.5 MB data-URL limit. */
const MAX_IMAGE_DATA_URL = 1_400_000;

export type CommentsTab = "comments" | "trades" | "holders";

export interface CommentsProps {
  coin: CoinDetail;
  defaultTab?: CommentsTab;
  className?: string;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Inserts or replaces a comment in the cached CoinDetail (dedupe by id, prepend when new). */
export function upsertCoinComment(qc: QueryClient, ca: string, comment: CommentView) {
  qc.setQueryData<CoinDetail>([`/api/coins/${ca}`], (prev) => {
    if (!prev) return prev;
    const exists = prev.commentsList.some((c) => c.id === comment.id);
    const commentsList = exists
      ? prev.commentsList.map((c) => (c.id === comment.id ? comment : c))
      : [comment, ...prev.commentsList];
    return { ...prev, commentsList, comments: exists ? prev.comments : prev.comments + 1 };
  });
}

// ---------------------------------------------------------------------------
// Image helpers (client-side resize → data URL)
// ---------------------------------------------------------------------------

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

/** Resizes an image file so its longest side is <= MAX_IMAGE_PX and returns a webp/jpeg data URL. */
export async function resizeImageToDataUrl(file: File, maxPx = MAX_IMAGE_PX): Promise<string> {
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const ratio = Math.min(1, maxPx / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  // Small GIFs keep their animation; everything else is re-encoded.
  if (file.type === "image/gif" && ratio === 1 && original.length <= MAX_IMAGE_DATA_URL) return original;

  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * ratio));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);

  const encode = (quality: number) => {
    const webp = canvas.toDataURL("image/webp", quality);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
  };
  let out = encode(0.85);
  if (out.length > MAX_IMAGE_DATA_URL) out = encode(0.7);
  if (out.length > MAX_IMAGE_DATA_URL) out = encode(0.5);
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Comments({ coin, defaultTab = "comments", className }: CommentsProps) {
  const t = useT();
  const commentCount = Math.max(coin.comments, coin.commentsList.length);
  const holderCount = coin.holders;
  return (
    <Tabs defaultValue={defaultTab} className={cn("w-full", className)}>
      <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0">
        <UnderlineTab value="comments">
          {t("comments.title")} <Count n={commentCount} />
        </UnderlineTab>
        <UnderlineTab value="trades">
          {t("comments.trades")} <Count n={coin.buys + coin.sells} />
        </UnderlineTab>
        <UnderlineTab value="holders">
          {t("comments.holders")} <Count n={holderCount} />
        </UnderlineTab>
      </TabsList>
      <TabsContent value="comments" className="mt-4">
        <CommentsTab coin={coin} />
      </TabsContent>
      <TabsContent value="trades" className="mt-4">
        <TradesTable trades={coin.recentTrades} ticker={coin.ticker} />
      </TabsContent>
      <TabsContent value="holders" className="mt-4">
        <HoldersTable coin={coin} />
      </TabsContent>
    </Tabs>
  );
}

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular text-muted-foreground">{n}</span>;
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

function CommentsTab({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const list = useMemo(() => {
    const byId = new Map<number, CommentView>();
    for (const c of coin.commentsList) byId.set(c.id, c);
    return Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id,
    );
  }, [coin.commentsList]);

  // Comments present on first render do not animate; new ones (own or live) slide in.
  const initialIdsRef = useRef<Set<number> | null>(null);
  if (initialIdsRef.current === null) initialIdsRef.current = new Set(list.map((c) => c.id));

  return (
    <div className="space-y-5">
      <Composer coin={coin} />
      {list.length === 0 ? (
        <EmptyBox icon={<MessageSquare className="h-5 w-5" />}>{t("comments.empty")}</EmptyBox>
      ) : (
        <ul className="divide-y divide-border">
          <AnimatePresence initial={false}>
            {list.map((c) => {
              const fresh = !initialIdsRef.current!.has(c.id);
              return (
                <motion.li
                  key={c.id}
                  layout="position"
                  initial={fresh ? { opacity: 0, y: -12, backgroundColor: "rgba(74,222,128,0.12)" } : false}
                  animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className="rounded-lg py-4 first:pt-0"
                >
                  <CommentItem coin={coin} comment={c} />
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

function Composer({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, openLogin } = useAuth();
  const [body, setBody] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const trimmed = body.trim();

  const post = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/coins/${coin.ca}/comments`, {
        body: trimmed,
        image: image ?? undefined,
      });
      return (await res.json()) as CommentView;
    },
    onSuccess: (comment) => {
      upsertCoinComment(qc, coin.ca, comment);
      setBody("");
      setImage(null);
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
    },
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      toast({ variant: "destructive", title: t("common.error"), description: t("create.imageHint") });
      return;
    }
    setPreparing(true);
    try {
      setImage(await resizeImageToDataUrl(file));
    } catch (err) {
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <span className="text-sm text-muted-foreground">{t("comments.placeholder")}</span>
        <Button size="sm" onClick={openLogin}>
          {t("comments.loginToComment")}
        </Button>
      </div>
    );
  }

  const canPost = !!trimmed && !post.isPending && !preparing;
  const submit = () => {
    if (canPost) post.mutate();
  };

  return (
    <div className="flex gap-3">
      <PublicAvatar user={user} size={32} className="mt-1" />
      <div className="min-w-0 flex-1">
        <Textarea
          value={body}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const file = Array.from(e.clipboardData?.files ?? [])[0];
            if (file) {
              e.preventDefault();
              void pickFile(file);
            }
          }}
          placeholder={t("comments.placeholder")}
          rows={3}
          className="min-h-[72px] resize-none rounded-lg"
        />
        {image && (
          <div className="relative mt-2 inline-block">
            <img src={image} alt="" className="max-h-40 rounded-lg border border-border object-cover" />
            <button
              type="button"
              onClick={() => setImage(null)}
              aria-label={t("common.close")}
              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={preparing || post.isPending}
              onClick={() => fileRef.current?.click()}
              className="gap-1.5 text-muted-foreground"
            >
              {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              <span className="hidden sm:inline">{t("comments.attachImage")}</span>
            </Button>
            <span className="text-[11px] tabular text-muted-foreground">
              {body.length > MAX_BODY * 0.8 ? `${body.length}/${MAX_BODY}` : ""}
            </span>
          </div>
          <Button size="sm" onClick={submit} disabled={!canPost} className="min-w-[72px]">
            {post.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t("comments.post")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentItem({ coin, comment }: { coin: CoinDetail; comment: CommentView }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, openLogin } = useAuth();
  const [expanded, setExpanded] = useState(false);

  const liked = !!user && comment.likes.includes(user.id);
  const likeCount = comment.likes.length;
  const isDev = comment.userId === coin.creatorId;
  const mine = !!user && user.id === comment.userId;

  const like = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/comments/${comment.id}/like`);
      return (await res.json()) as CommentView;
    },
    onMutate: () => {
      if (!user) return;
      upsertCoinComment(qc, coin.ca, {
        ...comment,
        likes: liked ? comment.likes.filter((id) => id !== user.id) : [...comment.likes, user.id],
      });
    },
    onSuccess: (updated) => upsertCoinComment(qc, coin.ca, updated),
    onError: (err) => {
      upsertCoinComment(qc, coin.ca, comment);
      toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err) });
    },
  });

  const onLike = () => {
    if (!user) {
      openLogin();
      return;
    }
    if (!like.isPending) like.mutate();
  };

  // Close the lightbox with Escape.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <div className="flex gap-3">
      <Link href={`/u/${encodeURIComponent(comment.user.username)}`} className="shrink-0">
        <PublicAvatar user={comment.user} size={32} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Link
            href={`/u/${encodeURIComponent(comment.user.username)}`}
            className={cn("font-semibold hover:underline", isDev && "text-[#fbbf24]")}
          >
            {mine ? t("chart.you") : `@${comment.user.username}`}
          </Link>
          {isDev && (
            <span className="rounded-md bg-[#fbbf24]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#fbbf24]">
              {t("comments.creatorBadge")}
            </span>
          )}
          {comment.holding > 0 && (
            <span
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium tabular text-primary"
              title={`${fmtTokens(comment.holding)} ${coin.ticker}`}
            >
              {t("comments.holdsTokens", { amount: `${fmtTokens(comment.holding)} ${coin.ticker}` })}
            </span>
          )}
          <span className="text-xs text-muted-foreground" title={new Date(comment.createdAt).toLocaleString()}>
            {timeAgo(comment.createdAt)}
          </span>
        </div>
        {comment.body && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{comment.body}</p>
        )}
        {comment.imageUrl && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 block overflow-hidden rounded-lg border border-border"
            aria-label={t("common.viewAll")}
          >
            <img src={comment.imageUrl} alt="" loading="lazy" className="max-h-64 max-w-full object-cover" />
          </button>
        )}
        {expanded && comment.imageUrl && (
          <div
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
            onClick={() => setExpanded(false)}
            role="dialog"
            aria-modal
          >
            <img src={comment.imageUrl} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-4 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onLike}
            aria-pressed={liked}
            aria-label={t("comments.like")}
            className={cn(
              "inline-flex items-center gap-1 rounded-md py-0.5 font-medium transition-colors hover:text-foreground",
              liked && "text-[#f43f5e] hover:text-[#f43f5e]",
            )}
          >
            <motion.span
              key={likeCount}
              initial={{ scale: 1 }}
              animate={{ scale: [1, 1.3, 1] }}
              transition={{ duration: 0.25 }}
              className="inline-flex"
            >
              <Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} />
            </motion.span>
            <span className="tabular">{likeCount > 0 ? likeCount : t("comments.like")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default Comments;
