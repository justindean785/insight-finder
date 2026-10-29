import { type ReactNode } from "react";
import {
  ShieldCheck, Server, CheckCircle2, ShieldQuestion, Circle,
  AlertTriangle, XCircle, Unlink, Info, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AUTHORITY_LEGEND, type AuthorityState, type AuthorityView } from "@/lib/authority";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Chip } from "@/components/ui/chip";

/**
 * Shared rendering for the authority ladder (`src/lib/authority.ts`).
 *
 * ONE rule governs everything here: state is never carried by colour alone. Each
 * state has a colour, an icon, and a word, and the two that deny authority carry
 * a texture as well. That is not only an accessibility floor — on a 300-row
 * ledger, hue is the first thing that stops being legible.
 */

const ICON: Record<AuthorityState, LucideIcon> = {
  verified: ShieldCheck,
  infrastructure: Server,
  probable: CheckCircle2,
  review: ShieldQuestion,
  weak: Circle,
  quarantined: Unlink,
  conflict: AlertTriangle,
  failed: XCircle,
};

/** Chip colours. Token-driven so the ladder can be retuned in one place. */
const CHIP: Record<AuthorityState, string> = {
  verified: "text-[hsl(var(--authority-verified))] border-[hsl(var(--authority-verified))]/35 bg-[hsl(var(--authority-verified))]/10",
  infrastructure: "text-[hsl(var(--authority-infrastructure))] border-[hsl(var(--authority-infrastructure))]/35 bg-[hsl(var(--authority-infrastructure))]/10",
  probable: "text-[hsl(var(--authority-probable))] border-[hsl(var(--authority-probable))]/35 bg-[hsl(var(--authority-probable))]/10",
  review: "text-[hsl(var(--authority-review))] border-[hsl(var(--authority-review))]/35 bg-[hsl(var(--authority-review))]/10",
  weak: "text-[hsl(var(--authority-weak))] border-[hsl(var(--authority-weak))]/30 bg-[hsl(var(--authority-weak))]/8",
  // Neutral + hatched, never a confidence hue — see the token comment in index.css.
  quarantined: "text-[hsl(var(--authority-quarantine))] border-[hsl(var(--authority-quarantine))]/45 bg-[hsl(var(--authority-quarantine))]/10",
  conflict: "text-[hsl(var(--authority-conflict))] border-[hsl(var(--authority-conflict))]/40 bg-[hsl(var(--authority-conflict))]/10",
  failed: "text-[hsl(var(--authority-failed))] border-[hsl(var(--authority-failed))]/40 bg-transparent",
};

/**
 * The spine — a 3px authority bar at the head of a row or card.
 *
 * Absolutely positioned, so the parent must be `relative`. Purely decorative in
 * the accessibility tree: the chip beside it carries the same information as
 * text, and announcing both would double every row for a screen-reader user.
 */
export function AuthoritySpine({ state, className }: { state: AuthorityState; className?: string }) {
  return <span aria-hidden className={cn("spine", className)} data-authority={state} />;
}

export function AuthorityChip({
  view,
  size = "sm",
  className,
}: {
  view: Pick<AuthorityView, "state" | "label" | "hint">;
  size?: "sm" | "md";
  className?: string;
}) {
  const Icon = ICON[view.state];
  return (
    <Chip title={view.hint} size={size} tone={CHIP[view.state]} className={className}>
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      {view.label}
    </Chip>
  );
}

/**
 * The caveat line — the recorded reason a row is not stronger.
 *
 * Rendered PERSISTENTLY, never behind a hover or a disclosure triangle. This is
 * the disclosure half of "quarantine is disclosure, not deletion": a quarantined
 * row that looks like an ordinary weak row is the exact defect this whole change
 * exists to fix, and a reason nobody can see is the same defect with extra steps.
 */
export function AuthorityCaveat({
  view,
  className,
}: {
  view: Pick<AuthorityView, "caveatKind" | "caveat">;
  className?: string;
}) {
  if (!view.caveat) return null;
  // Keyed on what the caveat SAYS, not on the row's winning state. A contradicted
  // row's caveat explains the contradiction; rendering it in the quarantine hue
  // behind an unlink mark reads as "linkage unproven" and argues with the
  // Conflict chip and spine beside it. (Cursor review, PR #462.)
  const cordoned = view.caveatKind === "linkage";
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-micro leading-snug",
        cordoned ? "text-[hsl(var(--authority-quarantine))]" : "text-muted-foreground/80",
        className,
      )}
    >
      {cordoned && <Unlink className="mt-px h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />}
      <span className="min-w-0">{view.caveat}</span>
    </p>
  );
}

/**
 * "Underlying: Probable" — the strength a row would have if authority were not
 * withheld. Shown only when the two axes disagree, so an ordinary row never
 * carries a redundant second label.
 *
 * WHY SHOW IT AT ALL. A quarantined row can have genuinely strong evidence that
 * the VALUE is real while having no authority to say it is the SUBJECT'S. Hiding
 * the strength would misrepresent it in the opposite direction, and it is the
 * number an analyst needs in order to decide whether adjudicating the linkage is
 * worth their time.
 */
export function UnderlyingStrength({ view, className }: { view: AuthorityView; className?: string }) {
  if (view.state !== "quarantined") return null;
  return (
    <span
      className={cn("text-muted-foreground/85", className)}
      title="How strong this observation is on its own merits — which is a separate question from whether it belongs to the subject."
    >
      {view.underlyingLabel}
    </span>
  );
}

/** One canonical legend, rendered from `AUTHORITY_LEGEND`, for every surface. */
export function AuthorityLegend({ align = "end", className }: { align?: "start" | "center" | "end"; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Show the evidence authority legend"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data font-medium text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11",
            className,
          )}
        >
          <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Legend
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(92vw,380px)] p-3">
        <div className="mb-2 text-micro font-semibold text-muted-foreground">Evidence authority</div>
        <ul className="space-y-2">
          {AUTHORITY_LEGEND.map((e) => (
            <li key={e.state} className="relative flex flex-col gap-1 pl-3">
              <AuthoritySpine state={e.state} className="rounded-full" />
              <AuthorityChip view={{ state: e.state, label: e.label, hint: "" }} className="self-start" />
              <span className="text-micro leading-snug text-muted-foreground">{e.hint}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** A labelled hairline that opens a ledger section without boxing it. */
export function RuleLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="rule-label">
      <span className="min-w-0 truncate">{children}</span>
      {right && <span className="ml-auto shrink-0 normal-case tracking-normal">{right}</span>}
    </div>
  );
}
