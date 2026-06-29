import { Radar, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmptyState — "awaiting signal" intel-terminal treatment.
 *
 * Shared across the workspace panels (Report, Brain, Audit, Clusters, Map,
 * Timeline, Graph, Tools). Instead of a flat grey placeholder it reads like a
 * sensor scanning for a contact: a glyph at the centre of expanding radar pings,
 * a faint masked scan-grid, an intel-blue signal glow, a blinking mono eyebrow,
 * and a Sora display title. CSS-only motion; honours prefers-reduced-motion.
 */
export function EmptyState({
  icon: Icon = Radar,
  title,
  hint,
  eyebrow = "Standby",
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  eyebrow?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden flex flex-col items-center justify-center text-center px-8 py-10 min-h-[220px]",
        className,
      )}
    >
      {/* radial signal glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 36%, hsl(var(--intel-blue) / 0.10), transparent 62%)",
        }}
      />
      {/* masked scan-grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--intel-blue)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--intel-blue)) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          WebkitMaskImage:
            "radial-gradient(64% 56% at 50% 38%, #000 0%, transparent 78%)",
          maskImage:
            "radial-gradient(64% 56% at 50% 38%, #000 0%, transparent 78%)",
        }}
      />

      {/* radar node */}
      <div className="relative mb-6 grid h-14 w-14 place-items-center">
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
        <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-[hsl(var(--intel-blue)/0.35)] bg-[linear-gradient(180deg,hsl(var(--surface-3)),hsl(var(--surface-1)))] text-[hsl(var(--intel-blue))] shadow-[0_0_30px_-8px_hsl(var(--intel-blue)/0.65)]">
          <Icon className="h-[22px] w-[22px]" strokeWidth={1.6} />
        </div>
      </div>

      {eyebrow && (
        <div className="mb-2 flex items-center gap-2 font-mono text-eyebrow uppercase tracking-[0.28em] text-[hsl(var(--intel-blue))]">
          <span className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--intel-blue))]" />
          {eyebrow}
        </div>
      )}
      <div className="font-display text-xl font-semibold leading-snug tracking-tight text-foreground">
        {title}
      </div>
      {hint && (
        <div className="mt-2 max-w-[300px] text-data leading-relaxed text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}
