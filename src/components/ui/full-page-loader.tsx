import { SwarmMark } from "@/components/ui/swarm-mark";
import { cn } from "@/lib/utils";

/**
 * FullPageLoader — the one branded loading treatment for route/auth/thread
 * gates. Replaces the bare centered "Loading…" text that used to be the literal
 * first paint after login on every route. Reuses the EmptyState "awaiting
 * signal" radar language (concentric pings behind the SwarmMark) so a cold load
 * reads as the same product, not an unfinished screen.
 *
 * CSS-only motion via the shared `radar-ping` keyframe; the `.radar-ring` class
 * is already disabled under prefers-reduced-motion in index.css.
 *
 *  - `fullScreen` (default): fills the viewport for a route-level gate.
 *  - `fullScreen={false}` + `className`: fills its container for an in-panel gate
 *    (e.g. a Suspense fallback inside the workspace).
 */
export function FullPageLoader({
  label = "Loading",
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
        "relative isolate flex flex-col items-center justify-center gap-5 text-center",
        fullScreen ? "min-h-[100dvh] bg-background" : "h-full w-full",
        className,
      )}
    >
      {/* radial signal glow — restrained, single accent */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 42%, hsl(var(--intel-blue) / 0.07), transparent 62%)",
        }}
      />

      {/* radar node */}
      <div className="relative grid h-14 w-14 place-items-center">
        <span
          aria-hidden
          className="radar-ring absolute h-14 w-14 rounded-full border border-[hsl(var(--intel-blue)/0.5)]"
          style={{ animation: "radar-ping 3.4s ease-out infinite" }}
        />
        <span
          aria-hidden
          className="radar-ring absolute h-14 w-14 rounded-full border border-[hsl(var(--intel-blue)/0.5)]"
          style={{ animation: "radar-ping 3.4s ease-out infinite", animationDelay: "1.7s" }}
        />
        <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-[hsl(var(--intel-blue)/0.35)] bg-[linear-gradient(180deg,hsl(var(--surface-3)),hsl(var(--surface-1)))] shadow-[0_0_30px_-8px_hsl(var(--intel-blue)/0.6)]">
          <SwarmMark className="h-[26px] w-[26px]" />
        </div>
      </div>

      <div className="flex items-center gap-2 font-mono text-eyebrow uppercase tracking-[0.28em] text-[hsl(var(--intel-blue))]">
        <span aria-hidden className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--intel-blue))]" />
        {label}
      </div>
    </div>
  );
}
