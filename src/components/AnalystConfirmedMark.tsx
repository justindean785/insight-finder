import type { DisplayConfidence } from "@/lib/display-confidence";
import {
  ANALYST_CONFIRMED_TEXT,
  analystConfirmedLabel,
  machineScoreText,
} from "@/lib/analyst-confirmed";
import { cn } from "@/lib/utils";

/**
 * What an ATTESTED row shows where its machine score would sit.
 *
 * A small label, not a figure: the serif numeral and its magnitude rule are a
 * MEASUREMENT, and an analyst decision is not one. The machine score is not
 * hidden — it is the accessible name, the native title, and a line in the ⓘ
 * popover beside it. Constant ink, like the numeral it replaces: the authority
 * chip on the same row carries the verdict's hue.
 *
 * Callers decide WHEN to render this with `isAnalystConfirmed` (lib/analyst-
 * confirmed.ts), which is the label ladder's own ATTESTED rung.
 */
export function AnalystConfirmedMark({
  shown,
  className,
}: {
  shown: Pick<DisplayConfidence, "effective" | "cap">;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={analystConfirmedLabel(shown)}
      title={machineScoreText(shown)}
      data-analyst-confirmed
      className={cn("text-eyebrow font-medium leading-tight text-foreground/85", className)}
    >
      {ANALYST_CONFIRMED_TEXT}
    </span>
  );
}
