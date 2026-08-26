/**
 * superseded-reports.ts — which assistant messages are stale reports.
 *
 * A multi-cycle run writes a COMPLETE report at every finalize, and the
 * transcript used to render every one of them at full length. One observed
 * production thread (seed "Jesus Acosta, age 31") carried FOUR full
 * "Investigation Report" documents and SEVEN blocks each headed
 * "## Evidence Record — authoritative" — a label only one of them can
 * truthfully hold — stacked in a single scroll.
 *
 * Only the newest report presents as current. The rest stay in the thread,
 * collapsed: a superseded report is still the record of what the run believed
 * at that point, so it is never dropped.
 *
 * Lives in lib/ rather than beside the component because exporting non-component
 * values from a component module breaks react-refresh.
 */
import type { UIMessage } from "ai";
import { hasReportShape, stripReasoningPerPart } from "@/lib/report-shape";

type PartLike = { type?: string; text?: string };

/** Assistant text of a message, reasoning stripped — the same view the report
 *  shape gate uses everywhere else. */
export function assistantText(m: UIMessage): string {
  if (m.role !== "assistant") return "";
  const texts = ((m.parts ?? []) as PartLike[])
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "");
  return stripReasoningPerPart(texts);
}

/** Is this message a closing REPORT rather than inter-step narration? */
export function isReportMessage(m: UIMessage): boolean {
  const t = assistantText(m);
  return t.length > 0 && hasReportShape(t);
}

/** Index of the newest report-shaped assistant message, or -1. */
export function findLastReportIndex(list: UIMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (isReportMessage(list[i])) return i;
  return -1;
}
