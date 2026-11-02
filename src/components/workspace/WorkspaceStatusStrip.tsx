import { cn } from "@/lib/utils";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The 26px bottom status strip (JD's Case-desk prototype, 2026-11-02).
 *
 * Left: custody, stated with its basis. The old case bar printed a bare lock
 * and "55/55" — the share of evidence-log entries whose hash links to the one
 * before, which is a statement about the LOG not having been altered, not about
 * sources having been preserved. The strip says what it measured ("55/55
 * evidence-log entries chained") and the tooltip says what it did not.
 *
 * Why "chained", not "linked": "linked" collides with identity linkage (what
 * Connections counts). Hash-chain integrity is a different relationship — one
 * entry's hash referencing the previous entry's — and the two face each other
 * on the same screen, so the words must be distinct.
 *
 * Right: the two working rules every surface of the case keeps — AI inference
 * is labelled as such, and the analyst directs what runs. Static text, on
 * purpose: nothing here is a number the page could get wrong.
 */
export function WorkspaceStatusStrip({ className }: { className?: string }) {
  const { snapshot } = useCaseSnapshot();
  const hydrated = Boolean(snapshot?.hydrated);
  const integ = hydrated ? snapshot?.integrity ?? null : null;

  let dot = "bg-muted-foreground/50";
  let text = "Reading case…";
  let hint: string | null = null;
  let tone = "text-faint-foreground";
  let label: string | undefined;
  if (hydrated && snapshot) {
    if (!integ) {
      // `integrity` is null only when the chain check did not run (a failed
      // RPC, a malformed row): an empty log still answers ok with total 0. Say
      // so, and never report it as a broken — or a valid — chain.
      text = "Custody not checked";
      hint = "The hash-chain check did not run on this read. Refresh to run it again.";
    } else if (integ.total === 0) {
      text = "No evidence-log entries yet";
      hint = "Chain of custody starts with the first recorded finding.";
    } else if (integ.ok) {
      dot = "bg-[hsl(var(--confidence-high))]";
      text = `Hash chain valid · ${integ.total}/${integ.total} evidence-log entries chained`;
      label = `Hash chain valid, ${integ.total}/${integ.total} evidence-log entries chained`;
      hint = `All ${integ.total} evidence-log entries hash to the one before, so the log has not been altered. This is not identity linkage — see Connections for that. And it does not mean the underlying sources were preserved — see Activity › Custody for hard vs soft entries.`;
    } else {
      const chained = Math.max(0, Number(integ.firstBreak ?? 1) - 1);
      dot = "bg-[hsl(var(--danger))]";
      tone = "text-[hsl(var(--danger))]";
      text = `Chain break at entry #${integ.firstBreak} · ${chained}/${integ.total} evidence-log entries chained`;
      label = `Hash chain broken at entry ${integ.firstBreak}, ${chained}/${integ.total} evidence-log entries chained`;
      hint = "Entries after the break cannot be shown to be unaltered.";
    }
  }

  const left = (
    <span
      tabIndex={hint ? 0 : undefined}
      aria-label={label}
      className={cn("inline-flex min-w-0 items-center gap-2 truncate rounded outline-none focus-visible:ring-2 focus-visible:ring-ring", tone, hint && "cursor-help")}
    >
      <span aria-hidden className={cn("h-1 w-1 shrink-0 rounded-full", dot)} />
      <span className="truncate">{text}</span>
    </span>
  );

  return (
    <footer
      aria-label="Case status strip"
      className={cn(
        "flex h-[26px] shrink-0 items-center justify-between gap-4 border-t border-border-subtle bg-[hsl(var(--surface-0))] px-5 text-[11px] text-faint-foreground",
        className,
      )}
    >
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>{left}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-[320px] text-xs leading-relaxed">{hint}</TooltipContent>
        </Tooltip>
      ) : left}
      <span className="hidden shrink-0 lg:inline">AI inference labelled · Analyst-directed execution</span>
    </footer>
  );
}
