/**
 * superseded-reports.ts — which assistant messages are stale reports.
 *
 * A multi-cycle run writes a COMPLETE report at every finalize, and the
 * transcript used to render every one of them at full length. One observed
 * production thread (seed "Jordan Vale, age 31") carried FOUR full
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

/**
 * The heading the health sweep writes on its interrupted-run notice, and the
 * headings earlier builds wrote. Mirrors RECOVERED_REPORT_HEADING and
 * LEGACY_RECOVERED_REPORT_HEADINGS in supabase/functions/osint-agent/recovery.ts;
 * chat-superseded-reports.test.ts reads that file and fails if these drift.
 * Like the edge list, the legacy list is append-only: notices written before a
 * rename are still sitting in `messages`.
 */
export const RECOVERY_NOTICE_HEADINGS: readonly string[] = [
  "## Interrupted run — recovered evidence",
  "## Findings report — recovered run",
];

/**
 * Is this message the sweep's interrupted-run notice?
 *
 * The notice is a STATUS RECORD: it says the run died and that the rows under
 * it are whatever was already written. It is report-shaped on purpose (the edge
 * relies on that to avoid stacking a second notice), so `hasReportShape` cannot
 * tell it from a report, and a later cycle's report used to collapse it under
 * "Superseded report — a later cycle rewrote this". Nothing rewrote it.
 *
 * The signal is the marker the edge itself emits, never what the prose means.
 * `messages` has no metadata column and the thread's `recovery_reason` is
 * cleared when the next run starts, so the heading is the only signal that
 * survives on the message. It must be the FIRST line: a report that quotes the
 * heading further down is still a report.
 */
export function isRecoveryNoticeMessage(m: UIMessage): boolean {
  const firstLine = assistantText(m).trimStart().split("\n", 1)[0].trimEnd();
  return RECOVERY_NOTICE_HEADINGS.includes(firstLine);
}

/**
 * Is this message a closing REPORT rather than inter-step narration?
 *
 * An interrupted-run notice is not one, in either direction: a later report
 * does not supersede it, and it does not supersede an earlier report.
 */
export function isReportMessage(m: UIMessage): boolean {
  if (isRecoveryNoticeMessage(m)) return false;
  const t = assistantText(m);
  return t.length > 0 && hasReportShape(t);
}

/** Index of the newest report-shaped assistant message, or -1. */
export function findLastReportIndex(list: UIMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (isReportMessage(list[i])) return i;
  return -1;
}
