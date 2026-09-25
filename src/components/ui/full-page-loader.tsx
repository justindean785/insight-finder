import { SwarmMark } from "@/components/ui/swarm-mark";
import { cn } from "@/lib/utils";

/**
 * One branded loading surface for route, auth, and thread gates.
 *
 * A schematic instrument, not a card: a thin-line radar (range rings, cardinal
 * ticks) whose sweep is the only moving part and the only accent, because the
 * one true state on this screen is "live, working". It invents no phase or
 * percentage. The sweep stops under reduced motion and the dial still reads.
 */
export function FullPageLoader({
  label = "Loading workspace",
  fullScreen = true,
  className,
}: {
  label?: string;
  fullScreen?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "relative isolate flex flex-col items-center justify-center overflow-hidden text-center",
        fullScreen ? "min-h-[100dvh] bg-background px-6" : "h-full min-h-56 w-full bg-background",
        className,
      )}
    >
      <div className="relative grid h-24 w-24 place-items-center">
        <svg viewBox="0 0 96 96" className="absolute inset-0 h-full w-full" aria-hidden>
          <g fill="none" stroke="hsl(var(--border-strong))" strokeWidth="1">
            <circle cx="48" cy="48" r="47" />
            <circle cx="48" cy="48" r="32" stroke="hsl(var(--border))" />
            <circle cx="48" cy="48" r="17" stroke="hsl(var(--border))" />
          </g>
          <g stroke="hsl(var(--faint-foreground))" strokeWidth="1">
            <path d="M48 0v6M48 90v6M0 48h6M90 48h6" />
          </g>
        </svg>
        {/* The sweep: a conic wedge trailing a 1px accent edge. */}
        <div
          aria-hidden
          className="absolute inset-[1px] rounded-full motion-safe:animate-[spin_2.8s_linear_infinite]"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg 300deg, hsl(var(--brand) / 0.16) 356deg, hsl(var(--brand)) 359deg, transparent 360deg)",
          }}
        />
        <div className="relative grid h-9 w-9 place-items-center rounded-md border border-border bg-background">
          <SwarmMark className="h-[18px] w-[18px]" />
        </div>
      </div>

      <div className="mt-5 font-display text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Insight Finder
      </div>
      <div className="mt-1.5 flex items-center justify-center gap-2 text-micro text-subtle-foreground">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand))]" />
        {label}
      </div>
    </div>
  );
}
