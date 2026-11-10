import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isReportMessage,
  findLastReportIndex,
  isRecoveryNoticeMessage,
  RECOVERY_NOTICE_HEADINGS,
  startsNewExchange,
  supersededFlags,
} from "@/lib/superseded-reports";
import { CONTINUE_PROMPT, REPORT_PROMPT } from "@/lib/run-controls";
import { hasReportShape } from "@/lib/report-shape";
import { dedupeCheckpoints } from "@/lib/chat-checkpoints";
import type { UIMessage } from "ai";

/**
 * Regression from a live production thread (seed "Jordan Vale, age 31").
 *
 * A multi-cycle run writes a COMPLETE report at every finalize, and the
 * transcript rendered every one of them at full length. The exported thread
 * carried FOUR full "Investigation Report" documents and SEVEN blocks headed
 * "## Evidence Record — authoritative" — a label only one of them can
 * truthfully hold, stacked in one scroll.
 *
 * Only the newest report should present as current. The rest stay in the
 * thread, collapsed: a superseded report is still the record of what the run
 * believed at that point, so it must never be dropped.
 */

const msg = (role: "user" | "assistant", text: string, id = Math.random().toString(36)): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as unknown as UIMessage;

const REPORT = [
  "## Investigation Report: Jordan Vale, Age 31",
  "",
  "| Finding | Confidence |",
  "| --- | --- |",
  "| name | 50 |",
  "",
  "## Evidence Record — authoritative",
].join("\n");

const NARRATION = "Let me recall memory from prior cycles and run the remaining address pivots.";

describe("superseded report detection", () => {
  it("recognises a report and not inter-step narration", () => {
    expect(isReportMessage(msg("assistant", REPORT))).toBe(true);
    expect(isReportMessage(msg("assistant", NARRATION))).toBe(false);
  });

  it("never treats a user message as a report", () => {
    // A user could paste a report-shaped document; it is still not the agent's
    // closing report and must not supersede one.
    expect(isReportMessage(msg("user", REPORT))).toBe(false);
  });

  it("points at the LAST report in a multi-cycle thread", () => {
    const thread = [
      msg("user", "Jordan Vale, age 31"),
      msg("assistant", NARRATION),
      msg("assistant", REPORT), // cycle 1
      msg("assistant", NARRATION),
      msg("assistant", REPORT), // cycle 2
      msg("assistant", REPORT), // cycle 3 — the current one
    ];
    expect(findLastReportIndex(thread)).toBe(5);
  });

  it("returns -1 when the run has produced no report yet", () => {
    expect(findLastReportIndex([msg("user", "seed"), msg("assistant", NARRATION)])).toBe(-1);
  });

  it("leaves a single-report thread fully expanded", () => {
    const thread = [msg("user", "seed"), msg("assistant", NARRATION), msg("assistant", REPORT)];
    const last = findLastReportIndex(thread);
    // Nothing before the only report is itself a report, so nothing collapses.
    const supersededCount = thread.filter((m, i) => i < last && isReportMessage(m)).length;
    expect(supersededCount).toBe(0);
  });

  it("collapses exactly the earlier reports, never the narration between them", () => {
    const thread = [
      msg("assistant", REPORT),    // 0 — superseded
      msg("assistant", NARRATION), // 1 — untouched
      msg("assistant", REPORT),    // 2 — superseded
      msg("assistant", NARRATION), // 3 — untouched
      msg("assistant", REPORT),    // 4 — current
    ];
    const last = findLastReportIndex(thread);
    const collapsed = thread.map((m, i) => last >= 0 && i < last && isReportMessage(m));
    expect(collapsed).toEqual([true, false, true, false, false]);
  });
});

/**
 * The interrupted-run notice is a status record, not a report.
 *
 * Observed in production on 2026-10-31: a run died, the health sweep posted
 * its notice, and a later cycle then wrote a report. The transcript collapsed
 * the notice under "Superseded report — a later cycle rewrote this", so the
 * analyst lost the signal that the run had died and that the rows under it
 * were only what had already been written.
 */

/** Shape of recovery.ts buildRecoveredAssistantText, synthetic values. */
const noticeText = (heading = RECOVERY_NOTICE_HEADINGS[0]) => [
  heading,
  "",
  "The investigation for **jane@example.com** was interrupted before the agent could write its closing response. **This is not a findings report.** The rows below are whatever was already durably written when the run stopped, presented as-is.",
  "Last heartbeat: 2026-10-31T09:14:02.000Z.",
  "",
  "### Model-reviewed findings",
  "| # | Kind | Value | Confidence | Status | Source |",
  "|---:|---|---|---:|---|---|",
  "| 1 | email | jane@example.com | 60 | verified | hunter_verify |",
  "",
  "### Recovery summary",
  "1 recovered row: 1 model-reviewed, 0 unreviewed.",
].join("\n");

/** The predicate ChatWindow applies, over the list it applies it to. */
const collapsedFlags = (thread: UIMessage[]) => supersededFlags(dedupeCheckpoints(thread));

describe("interrupted-run notice and supersession", () => {
  it("mirrors the headings the edge recovery path writes and recognises", () => {
    const edge = readFileSync(resolve(__dirname, "../../supabase/functions/osint-agent/recovery.ts"), "utf8");
    const current = /export const RECOVERED_REPORT_HEADING = "([^"]+)";/.exec(edge)?.[1];
    const legacyBlock = /export const LEGACY_RECOVERED_REPORT_HEADINGS[^=]*=\s*\[([\s\S]*?)\];/.exec(edge)?.[1] ?? "";
    const legacy = [...legacyBlock.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(current).toBeTruthy();
    expect(legacy.length).toBeGreaterThan(0);
    expect([...RECOVERY_NOTICE_HEADINGS]).toEqual([current, ...legacy]);
  });

  it("is report-shaped, which is why the shape gate alone collapsed it", () => {
    expect(hasReportShape(noticeText())).toBe(true);
  });

  it("recognises the notice under its current and its legacy heading", () => {
    for (const h of RECOVERY_NOTICE_HEADINGS) {
      expect(isRecoveryNoticeMessage(msg("assistant", noticeText(h)))).toBe(true);
      expect(isReportMessage(msg("assistant", noticeText(h)))).toBe(false);
    }
  });

  it("does not take a report that quotes the heading for a notice", () => {
    const quoting = `${REPORT}\n\nAn earlier run ended with this notice:\n\n${RECOVERY_NOTICE_HEADINGS[0]}\n`;
    expect(isRecoveryNoticeMessage(msg("assistant", quoting))).toBe(false);
    expect(isReportMessage(msg("assistant", quoting))).toBe(true);
    // A longer heading that merely starts the same way is not the marker either.
    expect(isRecoveryNoticeMessage(msg("assistant", `${RECOVERY_NOTICE_HEADINGS[0]} and analysis\n\n${REPORT}`))).toBe(false);
  });

  it("never treats a user message as a notice", () => {
    expect(isRecoveryNoticeMessage(msg("user", noticeText()))).toBe(false);
  });

  it("keeps the notice open when a later cycle writes a report", () => {
    const thread = [
      msg("user", "jane@example.com"),
      msg("assistant", noticeText()), // run 1 died
      msg("user", "continue"),
      msg("assistant", REPORT),       // run 2 finished
    ];
    expect(collapsedFlags(thread)).toEqual([false, false, false, false]);
  });

  it("still collapses an ordinary earlier report around a notice", () => {
    const thread = [
      msg("assistant", REPORT),       // 0 — superseded by 3
      msg("assistant", noticeText()), // 1 — status record, stays open
      msg("assistant", NARRATION),    // 2
      msg("assistant", REPORT),       // 3 — current
    ];
    expect(collapsedFlags(thread)).toEqual([true, false, false, false]);
  });

  it("does not let a notice supersede the report before it", () => {
    // No later cycle rewrote that report: the run after it died.
    const thread = [msg("assistant", REPORT), msg("user", "continue"), msg("assistant", noticeText())];
    expect(findLastReportIndex(thread)).toBe(0);
    expect(collapsedFlags(thread)).toEqual([false, false, false]);
  });
});

/**
 * Supersession is scoped to an exchange.
 *
 * Observed in production on 2026-11-10: 12 of 13 agent replies on one case were
 * folded as "Superseded report". Three separate pivot answers were among them,
 * and so was the full closing report, folded by a later pivot's short answer.
 * A reply is only rewritten by a later report that answers the same request.
 */
describe("supersession is scoped to an exchange", () => {
  const PIVOT = "Investigate phone +1 555 0100. Does this number belong to the subject?";
  const flags = (thread: UIMessage[]) => supersededFlags(dedupeCheckpoints(thread));

  it("opens an exchange on every analyst message except Write report", () => {
    expect(startsNewExchange(msg("user", "jane@example.com"))).toBe(true);
    expect(startsNewExchange(msg("user", PIVOT))).toBe(true);
    expect(startsNewExchange(msg("user", CONTINUE_PROMPT))).toBe(true);
    expect(startsNewExchange(msg("user", REPORT_PROMPT))).toBe(false);
    expect(startsNewExchange(msg("user", `  ${REPORT_PROMPT}\n`))).toBe(false);
    expect(startsNewExchange(msg("assistant", REPORT))).toBe(false);
  });

  it("keeps the answer to each pivot open", () => {
    const thread = [
      msg("user", "jane@example.com"), msg("assistant", REPORT),
      msg("user", PIVOT), msg("assistant", REPORT),
      msg("user", PIVOT), msg("assistant", REPORT),
    ];
    expect(flags(thread)).toEqual([false, false, false, false, false, false]);
  });

  it("does not let a later pivot answer fold the closing report", () => {
    const thread = [
      msg("user", "jane@example.com"), msg("assistant", REPORT),
      msg("user", REPORT_PROMPT), msg("assistant", REPORT), // the closing report
      msg("user", PIVOT), msg("assistant", REPORT),
    ];
    // Only the report the closing report rewrote is folded.
    expect(flags(thread)).toEqual([false, true, false, false, false, false]);
  });

  it("folds the report a Write report answer rewrites, and nothing older", () => {
    const thread = [
      msg("user", "jane@example.com"), msg("assistant", REPORT), // 1 — older exchange, stays open
      msg("user", PIVOT), msg("assistant", REPORT),              // 3 — rewritten by 5
      msg("user", REPORT_PROMPT), msg("assistant", REPORT),      // 5 — current
    ];
    expect(flags(thread)).toEqual([false, false, false, true, false, false]);
  });

  it("still folds earlier reports inside one exchange, never the narration", () => {
    const thread = [
      msg("user", "jane@example.com"),
      msg("assistant", REPORT), msg("assistant", NARRATION), msg("assistant", REPORT),
    ];
    expect(flags(thread)).toEqual([false, true, false, false]);
  });

  it("matches the thread-wide rule when no analyst message intervenes", () => {
    const thread = [msg("assistant", REPORT), msg("assistant", NARRATION), msg("assistant", REPORT)];
    expect(flags(thread)).toEqual([true, false, false]);
  });

  it("keeps an interrupted-run notice out of it in both directions", () => {
    const thread = [
      msg("user", "jane@example.com"),
      msg("assistant", REPORT), msg("assistant", noticeText()), msg("assistant", REPORT),
    ];
    expect(flags(thread)).toEqual([false, true, false, false]);
    expect(flags([msg("user", "seed"), msg("assistant", REPORT), msg("assistant", noticeText())]))
      .toEqual([false, false, false]);
  });
});
