import { Star } from "lucide-react";
import { useT } from "@/i18n";
import { useWatchlist } from "@/lib/watchlist";
import { cn } from "@/lib/utils";

/**
 * The star that puts an asset on the watchlist, shown on its own page rather
 * than on every row of a list — one deliberate tap instead of a column of them.
 *
 * `id` is whatever the home screen keys a row by: a coin's `next:<ca>`, a
 * token's `chain:address`, or `perp:<symbol>`.
 */
export function WatchButton({ id, className }: { id: string; className?: string }) {
  const t = useT();
  const watchlist = useWatchlist();
  const starred = watchlist.has(id);
  return (
    <button
      type="button"
      onClick={() => watchlist.toggle(id)}
      aria-pressed={starred}
      aria-label={starred ? t("common.watchlistRemove") : t("common.watchlistAdd")}
      title={starred ? t("common.watchlistRemove") : t("common.watchlistAdd")}
      className={cn(
        "tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors",
        starred && "text-gold",
        className,
      )}
    >
      <Star className={cn("h-[20px] w-[20px]", starred && "fill-current")} />
    </button>
  );
}

export default WatchButton;
