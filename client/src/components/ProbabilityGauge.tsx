import { NO_COLOR, YES_COLOR } from "@shared/schema";
import { cn } from "@/lib/utils";

/**
 * Half-circle probability gauge, Polymarket style: arc + "62%" + "chance".
 * `value` is a probability in 0..1. Defaults to green above 50%, red-orange below.
 */
export function ProbabilityGauge({
  value,
  size = 56,
  color,
  className,
}: {
  value: number;
  size?: number;
  color?: string;
  className?: string;
}) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = Math.round(v * 100);
  const stroke = Math.max(4, Math.round(size * 0.11));
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const halfCircumference = Math.PI * r;
  const dash = v * halfCircumference;
  const arcColor = color ?? (v >= 0.5 ? YES_COLOR : NO_COLOR);
  // Only the top half of the circle is drawn: path from left to right over the top.
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const height = cy + stroke / 2;

  return (
    <div
      className={cn("relative shrink-0 select-none", className)}
      style={{ width: size, height }}
      role="img"
      aria-label={`${percent}% chance`}
    >
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`} aria-hidden>
        <path d={d} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} strokeLinecap="round" />
        {dash > 0 && (
          <path
            d={d}
            fill="none"
            stroke={arcColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${halfCircumference + stroke}`}
            className="transition-[stroke-dasharray] duration-500 ease-out"
          />
        )}
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center leading-none">
        <span className="font-bold tabular" style={{ fontSize: Math.max(11, Math.round(size * 0.27)) }}>
          {percent}%
        </span>
        <span
          className="uppercase tracking-wide text-muted-foreground"
          style={{ fontSize: Math.max(8, Math.round(size * 0.15)) }}
        >
          chance
        </span>
      </div>
    </div>
  );
}
