import { cn } from "@/lib/utils";

/**
 * SwarmMark — the Insight Finder identity mark.
 *
 * Concentric scan rings with a single bright signal node off-axis. Reads as
 * radar / OSINT / cross-source convergence and replaces the generic "P"
 * placeholder that previously stood in for the brand.
 *
 * Rendered as inline SVG so the rings can use currentColor + the design
 * tokens (--primary, --accent). Size with className (e.g. w-5 h-5).
 */
export function SwarmMark({
  className,
  glow = true,
  title = "Insight Finder",
}: {
  className?: string;
  glow?: boolean;
  title?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox="0 0 32 32"
      className={cn("block", className)}
      style={glow ? { filter: "drop-shadow(0 0 6px hsl(var(--primary) / 0.55))" } : undefined}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id="swarm-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
        <radialGradient id="swarm-node" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="1" />
          <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0.85" />
        </radialGradient>
      </defs>
      {/* concentric scan rings */}
      <circle cx="16" cy="16" r="13" fill="none" stroke="url(#swarm-stroke)" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx="16" cy="16" r="9"  fill="none" stroke="url(#swarm-stroke)" strokeOpacity="0.55" strokeWidth="1" />
      <circle cx="16" cy="16" r="5"  fill="none" stroke="url(#swarm-stroke)" strokeOpacity="0.85" strokeWidth="1" />
      {/* crosshair ticks */}
      <path d="M16 1 L16 4 M16 28 L16 31 M1 16 L4 16 M28 16 L31 16"
        stroke="url(#swarm-stroke)" strokeOpacity="0.55" strokeWidth="1" strokeLinecap="round" />
      {/* off-axis signal node */}
      <circle cx="22.2" cy="9.8" r="2.1" fill="url(#swarm-node)" />
      <circle cx="22.2" cy="9.8" r="3.6" fill="none" stroke="hsl(var(--primary))" strokeOpacity="0.35" strokeWidth="1" />
      {/* center anchor */}
      <circle cx="16" cy="16" r="1.2" fill="hsl(var(--primary))" />
    </svg>
  );
}