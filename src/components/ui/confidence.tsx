/**
 * confidence.tsx — the ONE confidence component pair used everywhere a
 * confidence renders. Both derive color from confidence-tier.ts, so the number,
 * the bar, and the tag on a given row always agree (the fix for the old
 * green-75%-next-to-an-amber-badge inconsistency).
 *
 *   <ConfidenceTag score={82} />        → "Likely · 82%" pill, tier-colored
 *   <ConfidenceBar score={82} />        → thin track + tier-colored fill
 *   <ConfidenceBar score={82} showValue/> for the inline label too
 *
 * Display-only: never computes or caps confidence (that stays server-side).
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { tierInfo } from "@/lib/confidence-tier";

function useMountWidth(target: number): number {
  // Animate the bar fill in from 0 on mount; instant under reduced-motion.
  const [w, setW] = useState(() => {
    if (typeof window === "undefined") return target;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? target : 0;
  });
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setW(target);
      return;
    }
    raf.current = requestAnimationFrame(() => setW(target));
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);
  return w;
}

export function ConfidenceTag({
  score,
  showLabel = true,
  className,
}: {
  score: number | null | undefined;
  showLabel?: boolean;
  className?: string;
}) {
  const t = tierInfo(score);
  const pct = score == null || !Number.isFinite(score) ? null : Math.round(score);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-eyebrow font-mono uppercase tracking-wider tabular-nums",
        className,
      )}
      style={{
        color: t.color,
        borderColor: `hsl(var(${t.varName}) / 0.4)`,
        backgroundColor: `hsl(var(${t.varName}) / 0.1)`,
        ...(t.glow ? { boxShadow: `0 0 14px -4px hsl(var(--conf-confirmed-glow) / 0.5)` } : {}),
      }}
      title={`${t.label}${pct != null ? ` — ${pct}%` : ""}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
      {showLabel && <span>{t.label}</span>}
      {pct != null && <span className="opacity-90">{pct}%</span>}
    </span>
  );
}

export function ConfidenceBar({
  score,
  showValue = false,
  className,
  trackClassName,
}: {
  score: number | null | undefined;
  showValue?: boolean;
  className?: string;
  trackClassName?: string;
}) {
  const t = tierInfo(score);
  const pct = score == null || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(100, score));
  const width = useMountWidth(pct);
  const label = score == null || !Number.isFinite(score) ? "—" : `${Math.round(score)}%`;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn("h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3", trackClassName)}
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Confidence ${label} (${t.label})`}
      >
        <div
          className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
          style={{
            width: `${width}%`,
            backgroundColor: t.color,
            ...(t.glow ? { boxShadow: `0 0 8px -1px hsl(var(--conf-confirmed-glow) / 0.6)` } : {}),
          }}
        />
      </div>
      {showValue && (
        <span className="w-9 shrink-0 text-right font-mono text-data tabular-nums" style={{ color: t.color }}>
          {label}
        </span>
      )}
    </div>
  );
}
