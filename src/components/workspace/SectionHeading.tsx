import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The prototype's section heading (Case desk R6, JD's prototype 2026-11-02):
 * a 21px title with one line beneath that says what the section is for, and
 * an optional right-hand slot for the section's own controls. Overview,
 * Activity and Report share it so the three read as one product.
 */
export function SectionHeading({ title, subtitle, right, className }: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)} data-section-heading>
      <div className="min-w-0">
        <h2 className="font-display text-[21px] font-medium leading-tight tracking-[-0.03em] text-foreground">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12px] text-muted-foreground">{subtitle}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
