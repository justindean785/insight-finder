import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The chip primitive — one grammar for every pill-shaped tag in the workspace.
 *
 * Why this exists: audit §1 of `tasks/stage1-verification/design-audit.md` found
 * the same semantic review chip rendered in three different shapes across five
 * sites (padding `px-2 py-1` vs `px-2 py-0.5` vs `px-1.5 py-0.5`, corner `rounded`
 * vs `rounded-md` vs `rounded-full`, tracking `[0.14em]` vs `wider`). The color
 * tokens were correct; the dimensions had forked. This primitive owns dimensions
 * ONLY — height, padding, corner, gap, font-size, tracking — and takes the color
 * variant through `tone` so `REVIEW_CLASS[rState]`, `CHIP[authority]` and
 * `--source-chip` continue to carry the semantic distinction (authority / review
 * / quarantine). Standardize styling, preserve meaning.
 */
export interface ChipProps {
  /** Color variant className — e.g. `REVIEW_CLASS[rState]`, `CHIP[authority]`. */
  tone?: string;
  /** sm matches `AuthorityChip` size="sm" (px-1.5 py-px text-eyebrow); md matches size="md". */
  size?: "sm" | "md";
  /**
   * Monospace + uppercase + letter-spacing. Reserved for data chips (review
   * state short codes, LIVE CALL markers). Default is proportional + medium
   * weight for prose labels.
   */
  mono?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Chip({ tone, size = "sm", mono = false, className, title, children }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border whitespace-nowrap",
        size === "sm" ? "px-1.5 py-px text-eyebrow" : "px-2 py-0.5 text-micro",
        mono ? "font-mono uppercase tracking-[0.14em]" : "font-medium",
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}
