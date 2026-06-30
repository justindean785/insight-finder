import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { ConfidenceTier } from "@/lib/audit/confidence-linter";
import { tierOf } from "@/lib/audit/confidence-linter";

/**
 * Forensic report primitives, built on the project's real design tokens.
 * Accent is whatever `--primary` maps to today (white/mono); semantic color is
 * carried by --confidence-* / --danger / --intel-violet.
 *
 * Design rules in force (per review):
 *  - Tier badges are OUTLINE-only so a "Medium" tier never competes visually
 *    with an amber Warning pill (which is filled + left-barred).
 *  - Violet ("Verified") only renders when actually earned — see ReportCardV2.
 *  - Tables use whitespace + tabular alignment, not per-row hairlines.
 */

const TIER_TOKEN: Record<ConfidenceTier, string> = {
  Verified: "var(--intel-violet)",
  High: "var(--confidence-high)",
  Medium: "var(--confidence-mid)",
  Low: "var(--confidence-low)",
};

/* ── Tier Badge (outline-only) ─────────────────────────────────────── */

export function TierBadge({
  tier,
  muted = false,
  size = "md",
}: {
  tier: ConfidenceTier;
  /** Declared-but-not-earned — render struck/neutral, never colored. */
  muted?: boolean;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-0.5 text-data";

  if (muted) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-[3px] font-mono uppercase tracking-[0.14em] line-through opacity-60",
          pad,
        )}
        style={{ color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border-subtle))" }}
        title="Declared tier, not supported by the evidence"
      >
        {tier}
      </span>
    );
  }

  const c = TIER_TOKEN[tier];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] font-mono uppercase tracking-[0.14em]",
        pad,
      )}
      style={{ color: `hsl(${c})`, border: `1px solid hsl(${c} / 0.4)` }}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: `hsl(${c})` }} />
      {tier}
    </span>
  );
}

/* ── Segmented confidence meter (instrument-panel style) ───────────── */

export function ConfidenceMeter({
  value,
  showValue = true,
  width = 96,
}: {
  value: number; // 0–100
  showValue?: boolean;
  width?: number;
}) {
  const segments = 10;
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);
  const c =
    value >= 90 ? "var(--intel-violet)" :
    value >= 71 ? "var(--confidence-high)" :
    value >= 41 ? "var(--confidence-mid)" :
    value >= 1 ? "var(--confidence-low)" :
    "var(--border-strong)";

  return (
    <div className="inline-flex items-center gap-2">
      <div className="flex gap-[2px]" style={{ width }} aria-label={`Confidence ${value} of 100 — ${value >= 1 ? tierOf(value) : "Unverified"} tier`}>
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className="h-2 flex-1 rounded-[1px]"
            style={{
              background: i < filled ? `hsl(${c})` : "hsl(0 0% 100% / 0.05)",
              boxShadow: i < filled ? `0 0 4px hsl(${c} / 0.35)` : "none",
            }}
          />
        ))}
      </div>
      {showValue && (
        <span className="font-mono text-data tabular-nums" style={{ color: `hsl(${c})` }}>
          {value.toString().padStart(2, "0")}
        </span>
      )}
    </div>
  );
}

/* ── Section label ─────────────────────────────────────────────────── */

export function SectionLabel({
  children,
  count,
  status,
}: {
  children: ReactNode;
  count?: number;
  status?: "ok" | "warn" | "err";
}) {
  const dot =
    status === "ok" ? "var(--confidence-high)" :
    status === "warn" ? "var(--confidence-mid)" :
    status === "err" ? "var(--danger)" :
    "var(--border-strong)";
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="h-[5px] w-[5px] rounded-full"
        style={{ background: `hsl(${dot})`, boxShadow: status ? `0 0 6px hsl(${dot})` : "none" }}
      />
      <span className="font-mono text-eyebrow uppercase tracking-[0.22em] text-muted-foreground">
        {children}
      </span>
      {count !== undefined && (
        <span className="font-mono text-data tabular-nums text-muted-foreground/60">
          {count.toString().padStart(2, "0")}
        </span>
      )}
      <div className="flex-1 border-t border-border-subtle" />
    </div>
  );
}

/* ── Finding pill (filled tint + left bar — distinct from tier badges) ─ */

export function FindingPill({
  severity,
  children,
}: {
  severity: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const c =
    severity === "error" ? "var(--danger)" :
    severity === "warn" ? "var(--confidence-mid)" :
    "var(--muted-foreground)";
  const icon = severity === "error" ? "■" : severity === "warn" ? "▲" : "ℹ";
  return (
    <div
      className="flex items-start gap-2.5 rounded-[3px] px-3 py-2 font-mono text-data leading-relaxed"
      style={{ color: `hsl(${c})`, background: `hsl(${c} / 0.07)`, borderLeft: `2px solid hsl(${c})` }}
    >
      <span className="mt-px text-data opacity-80">{icon}</span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

/* ── Stat block ────────────────────────────────────────────────────── */

export function Stat({
  label,
  value,
  delta,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  delta?: string;
  tone?: "neutral" | "ok" | "warn" | "err";
}) {
  const valueColor =
    tone === "ok" ? "hsl(var(--confidence-high))" :
    tone === "warn" ? "hsl(var(--confidence-mid))" :
    tone === "err" ? "hsl(var(--danger))" :
    "hsl(var(--foreground))";
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
        {label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[22px] leading-none tabular-nums tracking-tight" style={{ color: valueColor }}>
          {value}
        </span>
        {delta && <span className="font-mono text-data tabular-nums text-muted-foreground/70">{delta}</span>}
      </div>
    </div>
  );
}
