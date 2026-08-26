import { describe, it, expect } from "vitest";
import { isReportMessage, findLastReportIndex } from "@/lib/superseded-reports";
import type { UIMessage } from "ai";

/**
 * Regression from a live production thread (seed "Jesus Acosta, age 31").
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
  "## Investigation Report: Jesus Acosta, Age 31",
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
      msg("user", "Jesus Acosta, age 31"),
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
