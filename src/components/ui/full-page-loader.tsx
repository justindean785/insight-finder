import { SwarmMark } from "@/components/ui/swarm-mark";
import { cn } from "@/lib/utils";

/**
 * One branded loading surface for route, auth, and thread gates.
 *
 * The restrained progress rail communicates activity without inventing a phase
 * or percentage. Motion is CSS-only and disabled by the global reduced-motion
 * contract.
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
        fullScreen ? "ops-shell min-h-[100dvh] bg-background px-6" : "h-full min-h-56 w-full",
        className,
      )}
    >
      {fullScreen && <div aria-hidden className="ops-grid pointer-events-none absolute inset-0 opacity-60" />}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_45%_at_50%_44%,hsl(var(--intel-blue)/0.08),transparent_74%)]" />

      <div className="instrument-panel relative w-full max-w-[310px] overflow-hidden rounded-2xl px-8 py-9">
        <div className="live-seam" aria-hidden />
        <div className="relative mx-auto grid h-14 w-14 place-items-center">
          <span
            aria-hidden
            className="radar-ring absolute h-14 w-14 rounded-full border border-[hsl(var(--intel-blue)/0.42)]"
            style={{ animation: "radar-ping 3.4s ease-out infinite" }}
          />
          <span
            aria-hidden
            className="radar-ring absolute h-14 w-14 rounded-full border border-[hsl(var(--intel-blue)/0.42)]"
            style={{ animation: "radar-ping 3.4s ease-out infinite", animationDelay: "1.7s" }}
          />
          <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-[hsl(var(--intel-blue)/0.32)] bg-[hsl(var(--surface-2))] shadow-[0_0_32px_-10px_hsl(var(--intel-blue)/0.7)]">
            <SwarmMark className="h-[27px] w-[27px]" />
          </div>
        </div>

        <div className="mt-6 font-display text-base font-semibold tracking-tight text-foreground">
          Insight Finder
        </div>
        <div className="mt-2 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[hsl(var(--intel-blue))]">
          <span aria-hidden className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--intel-blue))]" />
          {label}
        </div>

        <div aria-hidden className="mx-auto mt-6 flex w-28 items-center gap-1.5">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[hsl(var(--intel-blue)/0.55)]" />
          <span className="h-1 w-1 rounded-full bg-[hsl(var(--intel-blue))]" />
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[hsl(var(--intel-blue)/0.55)]" />
        </div>
      </div>
    </div>
  );
}
