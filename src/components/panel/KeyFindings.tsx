import type { Artifact } from "@/hooks/useThreadArtifacts";
import { useReviewStates, REVIEW_CLASS, REVIEW_SHORT } from "@/lib/review";
import { Star, CheckCircle2, Copy } from "lucide-react";
import { toast } from "sonner";

/**
 * Surfaces analyst-confirmed and analyst-pinned ("key") artifacts at the top
 * of the Overview tab so they're immediately visible after reload.
 */
export function KeyFindings({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const review = useReviewStates(threadId);

  const pinned = artifacts
    .map((a) => ({ a, state: review.get(a.id), note: review.getNote(a.id) }))
    .filter((r) => r.state === "key" || r.state === "confirmed")
    .sort((x, y) => {
      // Key first, then confirmed; within group keep highest confidence first.
      const rank = (s: string) => (s === "key" ? 0 : 1);
      if (rank(x.state) !== rank(y.state)) return rank(x.state) - rank(y.state);
      return (y.a.confidence ?? 0) - (x.a.confidence ?? 0);
    });

  if (pinned.length === 0) return null;

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Copy failed"),
    );

  return (
    <section className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider text-primary">
          <Star className="w-3 h-3" /> Key findings
        </div>
        <span className="font-mono text-data text-muted-foreground">{pinned.length}</span>
      </div>
      <ul className="space-y-1.5">
        {pinned.map(({ a, state, note }) => {
          const Icon = state === "key" ? Star : CheckCircle2;
          return (
            <li
              key={a.id}
              className="group rounded-md border border-border/60 bg-card/60 px-2 py-1.5 text-data"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-1.5">
                  <Icon
                    className={
                      "w-3 h-3 mt-0.5 shrink-0 " +
                      (state === "key" ? "text-primary" : "text-[hsl(var(--confidence-high))]")
                    }
                  />
                  <div className="min-w-0">
                    <div className="font-mono text-foreground break-all">{a.value}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                      {a.kind} {a.source ? `· ${a.source}` : ""}
                    </div>
                    {note && (
                      <div className="mt-1 text-data text-muted-foreground italic break-words">
                        “{note}”
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span
                    className={
                      "px-1.5 py-0.5 rounded border font-mono text-[9px] uppercase tracking-wider " +
                      REVIEW_CLASS[state as keyof typeof REVIEW_CLASS]
                    }
                  >
                    {REVIEW_SHORT[state as keyof typeof REVIEW_SHORT]}
                  </span>
                  <button
                    onClick={() => copy(a.value)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                    title="Copy value"
                    aria-label="Copy value"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}