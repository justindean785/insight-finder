import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthorityState } from "@/lib/authority";

/**
 * vital.tsx — one reading on the case instrument bank.
 *
 * The Overview tiles used to be five identical boxes carrying an icon, a word
 * and a bare count. Two problems, and the second is the interesting one.
 *
 * THEY ALL WEIGHED THE SAME. "Verified 2" and "Conflict 2" are not the same
 * news, and nothing on the tile said so. Weight now follows what the number
 * MEANS: a reading at zero recedes to reference ink, because a case with no
 * contradictions should not spend the same attention as one with two.
 *
 * THE COUNT HAD NO SCALE. "Quarantined 9" is a crisis in a twelve-artifact case
 * and a footnote in a five-hundred-artifact one, and the tile could not tell
 * you which. Every reading that is a share of a stated whole now carries its
 * denominator and a rule whose LENGTH is that share -- the same instrument the
 * evidence ledger already uses for a confidence, so the two surfaces read as
 * one product rather than two dashboards.
 *
 * Hue lives on the icon and the rule, never on the numeral. That is not a
 * preference; it is the rule the ledger settled on ("ink, never the tier
 * colour: the bar's LENGTH already says how big the number is") and the tiles
 * were the last surface still colouring a figure by its value.
 */
export function Vital({
  icon: Icon,
  label,
  value,
  of,
  share,
  state,
  sub,
  onClick,
  title,
}: {
  icon: LucideIcon;
  label: string;
  /** The headline reading. A count, a ratio, or a formatted duration. */
  value: string | number;
  /** The whole `value` is a share of. Renders as a denominator beside it. */
  of?: number | null;
  /** 0..1. Omit when the reading is not a share of anything (a duration). */
  share?: number | null;
  /** Drives the icon and the rule. Omitted for a reading with no verdict. */
  state?: AuthorityState;
  sub?: string;
  onClick?: () => void;
  title?: string;
}) {
  const Tag = onClick ? "button" : "div";
  // A numeric zero is the only value that recedes. A duration or a ratio string
  // is a reading either way, and dimming "0/3 failed" would hide good news
  // rather than rank it.
  const dormant = typeof value === "number" && value === 0;
  const pct = share == null ? null : Math.max(0, Math.min(1, share));

  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      title={title}
      data-interactive={onClick ? "true" : undefined}
      className={cn(
        "panel stat-tile flex h-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors duration-fast",
        onClick &&
          "hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {/* Two lines reserved, always. "Coverage gaps" wraps at five-across while
          "Conflict" does not, and a bank whose figures sit on two different
          baselines reads as a layout accident rather than an instrument. The
          13px this costs the short labels buys every numeral one baseline at
          every width. Measured: 1.375rem was short by 2px and still left two
          baselines, so it is set from the rendered two-line height, not from
          the arithmetic. */}
      <span
        className={cn(
          "flex min-h-[1.625rem] items-start gap-1.5 text-eyebrow uppercase leading-[1.1] tracking-[0.12em]",
          dormant ? "text-faint-foreground" : "text-subtle-foreground",
        )}
      >
        <Icon
          className="mt-px h-3 w-3 shrink-0"
          style={state && !dormant ? { color: `hsl(var(--authority-${state === "quarantined" ? "quarantine" : state}))` } : undefined}
          strokeWidth={2}
          aria-hidden
        />
        {label}
      </span>

      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn(
            "font-display text-[2rem] font-semibold leading-none tracking-[-0.03em]",
            // Reference ink at zero; the top-lit treatment only for a reading
            // that is actually saying something.
            dormant ? "tabular-nums text-faint-foreground" : "stat-figure",
          )}
        >
          {value}
        </span>
        {of != null && (
          <span className="shrink-0 font-mono text-micro tabular-nums text-faint-foreground">of {of}</span>
        )}
      </span>

      {/* Bottom-aligned, so five tiles of differing content still line their
          rules and captions up across the bank. */}
      <span className="mt-auto flex flex-col gap-1.5 pt-2">
        {pct != null && (
          <span className="stat-rule" aria-hidden>
            <i style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct * 100)}%` }} data-authority={state ?? undefined} />
          </span>
        )}
        {sub && (
          <span
            className={cn(
              "block text-micro leading-snug [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box] overflow-hidden",
              dormant ? "text-faint-foreground" : "text-subtle-foreground",
            )}
          >
            {sub}
          </span>
        )}
      </span>
    </Tag>
  );
}
