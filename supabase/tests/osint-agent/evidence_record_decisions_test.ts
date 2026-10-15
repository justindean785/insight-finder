// evidence_record_decisions_test.ts — the persisted message is the durable
// record that analyst decisions bound on a turn.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEvidenceRecord, EVIDENCE_RECORD_HEADING } from "../../functions/osint-agent/lib/evidence-record.ts";

const base = { rows: [], totalArtifactCount: 12, retrieval: "complete" as const, reviews: "applied" as const, rejectedFindingCount: 0 };

Deno.test("renders the decisions line and the cleared-assignments line", () => {
  const out = buildEvidenceRecord({ ...base, analystDecisions: { confirmed: 2, key: 1, recheck: 0, rejected: 3 }, clusterAssignmentsCleared: 4 });
  assert(out.startsWith(EVIDENCE_RECORD_HEADING));
  assert(out.includes("_Analyst decisions applied this turn: 2 confirmed, 1 key, 0 recheck, 3 dismissed._"), out);
  assert(out.includes("cleared for analyst-rejected rows"), out);
  assert(out.includes(": 4._"), out);
});

Deno.test("silent when there were no decisions and nothing was cleared, and when omitted", () => {
  const zero = buildEvidenceRecord({ ...base, analystDecisions: { confirmed: 0, key: 0, recheck: 0, rejected: 0 }, clusterAssignmentsCleared: 0 });
  assert(!zero.includes("Analyst decisions"));
  const omitted = buildEvidenceRecord(base);
  assertEquals(omitted, zero);
});

Deno.test("a malformed envelope degrades, never throws, and the lines are prose (no table separators)", () => {
  const out = buildEvidenceRecord({ ...base, analystDecisions: "nope" as unknown as { confirmed: number; key: number; recheck: number; rejected: number }, clusterAssignmentsCleared: -3 });
  assert(!out.includes("Analyst decisions"));
  const withLines = buildEvidenceRecord({ ...base, analystDecisions: { confirmed: 1, key: 0, recheck: 0, rejected: 0 } });
  for (const l of withLines.split("\n").filter((l) => l.includes("Analyst decisions"))) assert(!l.includes("|"), l);
});

const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
Deno.test("wiring: finalize passes the turn's decisions into the Evidence Record", () => {
  assert(INDEX.includes("analystDecisions: reviewsUsable"));
  assert(INDEX.includes("clusterAssignmentsCleared: salvageArts"));
});
