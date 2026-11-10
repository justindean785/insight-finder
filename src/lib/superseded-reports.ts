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
import { REPORT_PROMPT } from "@/lib/run-controls";

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

/** Text of an analyst message, as typed or as the app sent it. */
function analystText(m: UIMessage): string {
  if (m.role !== "user") return "";
  return ((m.parts ?? []) as PartLike[])
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * Does this analyst message open a new EXCHANGE?
 *
 * Supersession never crosses an exchange boundary: a reply is only ever
 * "rewritten" by a later report inside the same exchange. Without a boundary,
 * every reply that contains a table collapsed as soon as the next one arrived.
 * Seen in production 2026-11-10: 12 of 13 agent replies on one case were
 * folded as "Superseded report", among them the answers to three separate
 * phone pivots and the full closing report itself, folded by a later pivot's
 * short answer.
 *
 * Every analyst message opens one, with a single exception: the app's own
 * Write report prompt. That request asks for the full closing report over what
 * is already recorded, so its answer really is a rewrite of the report before
 * it and joins that exchange. A typed question, a pivot card and Continue each
 * ask for something new (the Continue prompt says "do not rewrite the full
 * report"), so their answers stand on their own.
 *
 * Decided from STRUCTURE only: the role, and identity with a prompt this app
 * itself sends. Never from what the analyst's words mean.
 */
export function startsNewExchange(m: UIMessage): boolean {
  if (m.role !== "user") return false;
  return analystText(m).trim() !== REPORT_PROMPT;
}

/**
 * Which messages render collapsed as superseded: an earlier report-shaped
 * reply, when a later report exists in the SAME exchange. The newest report of
 * every exchange stays open. Interrupted-run notices are never reports, so they
 * are neither collapsed nor able to collapse anything.
 */
export function supersededFlags(list: UIMessage[]): boolean[] {
  const flags = new Array<boolean>(list.length).fill(false);
  let start = 0;
  const close = (end: number) => {
    let last = -1;
    for (let i = end - 1; i >= start; i--) if (isReportMessage(list[i])) { last = i; break; }
    for (let i = start; i < last; i++) flags[i] = isReportMessage(list[i]);
  };
  for (let i = 0; i < list.length; i++) {
    if (list[i].role === "user" && startsNewExchange(list[i])) { close(i); start = i; }
  }
  close(list.length);
  return flags;
}
