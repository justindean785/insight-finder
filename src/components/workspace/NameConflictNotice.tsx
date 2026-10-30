import { AlertTriangle, ArrowRight } from "lucide-react";
import { nameConflictParts, type NameConflict } from "@/lib/name-conflict";

/**
 * The analyst-supplied name that record-derived names contradict, as a standing
 * row on the Overview instead of one line in the report. An open question: it
 * lists the variants and picks no surname. Display only — it changes no row,
 * state or verdict.
 */
export function NameConflictNotice({ conflict, onOpen }: { conflict: NameConflict; onOpen: () => void }) {
  const { headline, variants } = nameConflictParts(conflict);
  return (
    <section className="panel panel-flat flex items-start gap-3 px-3 py-2.5" role="note" aria-label="Name conflict" data-testid="name-conflict">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--authority-review))]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-data font-medium text-foreground">Name conflict — open question</p>
        <p className="mt-0.5 text-data text-muted-foreground">{headline}</p>
        <ul className="mt-1 space-y-0.5">
          {variants.map((v) => (
            <li key={v} className="truncate font-mono text-micro text-muted-foreground" title={v}>{v}</li>
          ))}
        </ul>
        <p className="mt-1 text-micro text-faint-foreground">Nothing in this case settles which surname is right. Do not merge identities on a first name alone.</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-micro font-medium text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open Evidence <ArrowRight className="h-3 w-3" aria-hidden />
      </button>
    </section>
  );
}
