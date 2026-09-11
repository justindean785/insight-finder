import { findAssertedConfidence } from "@/lib/asserted-confidence";
import { cn } from "@/lib/utils";

/**
 * Printed beside an artifact value that asserts its own confidence ("…
 * confirmed at 92% confidence"), so the prose figure cannot be read as the
 * engine's. Renders nothing for a value that makes no such claim.
 */
export function AssertedConfidenceNote({
  value, engine, className,
}: {
  value: string;
  /** The engine's confidence for this row, when the surface has it. */
  engine?: number | null;
  className?: string;
}) {
  const claim = findAssertedConfidence(value);
  if (!claim) return null;
  const hasEngine = typeof engine === "number" && Number.isFinite(engine);
  return (
    <span
      title={`“${claim.phrase}” is written into this value by whoever recorded it. It is not a score${hasEngine ? `; the engine gives this row ${Math.round(engine)}%` : ""}.`}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] px-1 py-px align-middle font-mono text-micro uppercase tracking-wider text-[hsl(var(--warning))] no-underline",
        className,
      )}
    >
      claims {claim.pct}%{hasEngine ? ` · engine ${Math.round(engine)}%` : " · not a score"}
    </span>
  );
}
