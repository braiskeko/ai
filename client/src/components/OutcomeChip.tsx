import type { MouseEvent } from "react";
import { cents } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Compact pill for one outcome: colored dot, name and the current price in cents.
 * Renders as a button when `onClick` is given; otherwise as a static badge.
 */
export function OutcomeChip({
  name,
  color,
  price,
  selected = false,
  onClick,
  className,
}: {
  name: string;
  color: string;
  price: number;
  selected?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  className?: string;
}) {
  const base = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none transition-colors tabular",
    selected ? "border-transparent text-foreground" : "border-border bg-card text-foreground",
    onClick && !selected && "hover:bg-accent",
    className,
  );
  const style = selected ? { backgroundColor: `${color}1f`, borderColor: `${color}80` } : undefined;
  const content = (
    <>
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{name}</span>
      <span className={cn("shrink-0 font-semibold", !selected && "text-muted-foreground")}>{cents(price)}</span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} className={base} style={style}>
        {content}
      </button>
    );
  }
  return (
    <span className={base} style={style}>
      {content}
    </span>
  );
}
