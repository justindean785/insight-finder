// lib/memory_save_test.ts — C-2 acceptance: memory_save must never write a merged
// identity claim that C-1 clustering wouldn't itself support, and must cap confidence
// to what the underlying artifacts justify. Fixture: the REAL e29aa8c9 artifact set
// (lib/fixtures/e29aa8c9-artifacts.csv) plus the REAL historical memory_save entry that
// caused the bug (confidence 98, "confirmed primary subject across both
// taciocero@me.com AND nicole@bay2pacificre.com" — verbatim from tool_usage_log).
// If these fail, STOP and re-plan — do not patch forward.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { parseArtifactsCsv, clusterArtifacts } from "./cluster.ts";
import { reviewMemoryEntry, reviewMemoryBatch, describeConflict, buildTokenIndex, type MemoryEntry } from "./memory_consolidate.ts";
import { collectKnownHandles } from "./cluster.ts";

const ARTS = parseArtifactsCsv(Deno.readTextFileSync(new URL("./fixtures/e29aa8c9-artifacts.csv", import.meta.url)));

// The REAL historical entry (tool_usage_log, run e29aa8c9, immediately after
// minimax_correlate timed out at 12,143ms). Verbatim content + related_values.
const REAL_BUG_ENTRY: MemoryEntry = {
  kind: "identity",
  subject: "anastacio \"tosh\" ben cero",
  subject_kind: "name",
  confidence: 98,
  content:
    "anastacio 'tosh' ben cero is the confirmed primary subject across both taciocero@me.com and " +
    "nicole@bay2pacificre.com. dob 1983-12-06, ca area codes 925 (brentwood/oakley), active venmo " +
    "bencaleb83. fraud case c25-00559 in contra costa superior court involving $50k solicitation via " +
    "ben caleb investments llc.",
  related_values: [
    "taciocero@me.com", "tosh@bencaleb.com", "tosh@traceroelectric.com", "taciocero@icloud.com",
    "toshceroabm@gmail.com", "anatacio.cero@yahoo.com", "amply@taciocero.com", "bencaleb83",
    "9258139308", "dob 1983-12-06", "511 lake park ct oakley ca 94561", "526 coconut pl brentwood ca 94513",
  ],
};

Deno.test("C-2: parses the real 46-artifact e29aa8c9 export", () => {
  assertEquals(ARTS.length, 46);
});

Deno.test("C-2: the real 98-confidence merged claim is BLOCKED, never written as-is", () => {
  const review = reviewMemoryEntry(REAL_BUG_ENTRY, ARTS, true);
  assertEquals(review.verdict, "blocked");
  assert(review.subjectIds.length >= 2, "must resolve to 2+ distinct C-1 subjects");
  assert(review.reason && review.reason.length > 0, "a blocked entry always carries a reason");
});

Deno.test("C-2: the false cross-selector claim specifically implicates BOTH emails' subjects", () => {
  const { members } = clusterArtifacts(ARTS);
  const taciocero = members.find((m) => m.value === "taciocero@me.com");
  const nicole = members.find((m) => m.value === "nicole@bay2pacificre.com");
  assert(taciocero?.subject_id && nicole?.subject_id, "both emails must be clustered");
  assert(taciocero!.subject_id !== nicole!.subject_id, "the two emails must NOT share a subject");
  const review = reviewMemoryEntry(REAL_BUG_ENTRY, ARTS, true);
  assert(review.subjectIds.includes(taciocero!.subject_id!), "taciocero's subject is flagged");
  assert(review.subjectIds.includes(nicole!.subject_id!), "nicole/Sheena's subject is flagged — the false claim caught");
});

Deno.test("C-2: describeConflict names the first-name conflict (Anastacio vs Sheena)", () => {
  const knownHandles = collectKnownHandles(ARTS);
  const { members } = clusterArtifacts(ARTS);
  const index = buildTokenIndex(members, knownHandles);
  const anastacioNameSubject = members.find((m) => m.kind === "name" && m.value === "Anastacio Cero")?.subject_id;
  const sheenaNameSubject = members.find((m) => m.kind === "name" && m.value === "sheena Cero")?.subject_id;
  assert(anastacioNameSubject && sheenaNameSubject, "both name artifacts must be clustered");
  const reason = describeConflict([anastacioNameSubject!, sheenaNameSubject!], index);
  assert(/first-name conflict/i.test(reason), `expected a first-name-conflict reason, got: ${reason}`);
  assert(/anastacio/i.test(reason) && /sheena/i.test(reason), `reason must name both first names: ${reason}`);
});

Deno.test("C-2: Jordan Galen is never attached to the taciocero/Cero subjects", () => {
  const { members } = clusterArtifacts(ARTS);
  const jordanHandle = members.find((m) => m.kind === "username" && m.value === "jordangalen")?.subject_id;
  const taciocero = members.find((m) => m.value === "taciocero@me.com")?.subject_id;
  const nicole = members.find((m) => m.value === "nicole@bay2pacificre.com")?.subject_id;
  assert(jordanHandle && taciocero && nicole, "all three anchor selectors must be clustered");
  assert(jordanHandle !== taciocero && jordanHandle !== nicole, "Jordan Galen must be a separate subject");

  // A memory_save entry that (wrongly) tries to co-mingle Jordan with Anastacio in
  // prose must also be blocked — the scope guard applies to content, not just
  // related_values (mirrors how the real bug's false claim lived only in prose).
  const badEntry: MemoryEntry = {
    kind: "identity", subject: "test co-mingling", confidence: 90,
    content: "Same person as taciocero@me.com, also goes by jordan.galen@yahoo.com in some records.",
    related_values: ["taciocero@me.com"],
  };
  const review = reviewMemoryEntry(badEntry, ARTS, false);
  assertEquals(review.verdict, "blocked");
});

Deno.test("C-2: a legitimate single-subject entry is ALLOWED, confidence capped to that subject's ceiling", () => {
  const { members } = clusterArtifacts(ARTS);
  const taciocero = members.find((m) => m.value === "taciocero@me.com")!;
  const entry: MemoryEntry = {
    kind: "identity", subject: "taciocero", confidence: 99, // deliberately over-claimed
    content: "taciocero@me.com is a confirmed breach-exposed identity.",
    related_values: ["taciocero@me.com"],
  };
  const review = reviewMemoryEntry(entry, ARTS, false);
  assertEquals(review.verdict, "allow");
  assertEquals(review.subjectIds, [taciocero.subject_id]);
  assert(review.entry.confidence <= 99, "capped, never silently raised");
  assert(review.entry.confidence <= 95, "must not exceed the subject's own promoted ceiling");
});

Deno.test("C-2: no strong join key caps an ungrounded entry at 74 (never reaches Likely/75)", () => {
  const entry: MemoryEntry = {
    kind: "pattern", subject: "generic-lesson", confidence: 100,
    content: "This is a general OSINT lesson with no selectors attached.",
  };
  const review = reviewMemoryEntry(entry, ARTS, false);
  assertEquals(review.verdict, "allow");
  assertEquals(review.subjectIds, []);
  assert(review.entry.confidence <= 74, `expected ≤74 without a strong key, got ${review.entry.confidence}`);
});

Deno.test("C-2: correlate-failure guard forces 'unresolved' for an unverifiable cross-selector claim", () => {
  const entry: MemoryEntry = {
    kind: "connection", subject: "unverified-link", confidence: 85,
    content: "not-a-real-selector-aaa@nowhere.test appears linked to not-a-real-selector-bbb@nowhere.test.",
    related_values: ["not-a-real-selector-aaa@nowhere.test", "not-a-real-selector-bbb@nowhere.test"],
  };
  const failed = reviewMemoryEntry(entry, ARTS, true);
  assertEquals(failed.verdict, "unresolved");
  assert(failed.entry.confidence <= 40, "unresolved claims are capped low");
  assert(/unresolved — correlation failed/i.test(failed.entry.content), "content is prefixed, not silently dropped");

  // Same entry, correlate did NOT fail this cycle — falls through to the ordinary
  // no-evidence path (allow, capped ≤74), not forced-unresolved. The guard is
  // specifically tied to correlate failure, not a blanket rule.
  const notFailed = reviewMemoryEntry(entry, ARTS, false);
  assertEquals(notFailed.verdict, "allow");
});

Deno.test("C-2: batch review — blocked entries are logged as candidates, never silently dropped", () => {
  const legit: MemoryEntry = {
    kind: "identity", subject: "taciocero", confidence: 90,
    content: "taciocero@me.com breach-confirmed.", related_values: ["taciocero@me.com"],
  };
  const { toPersist, candidates } = reviewMemoryBatch([REAL_BUG_ENTRY, legit], ARTS, true);
  assertEquals(toPersist.length, 1, "only the legitimate entry is persisted as-is");
  assertEquals(toPersist[0].subject, "taciocero");
  assertEquals(candidates.length, 1, "the blocked entry is logged as a candidate, not dropped");
  assertEquals(candidates[0].entry.subject, REAL_BUG_ENTRY.subject);
  assert(candidates[0].reason.length > 0);
});

Deno.test("C-2: three distinct people (Anastacio, Sheena, Jordan) never share a subject_id", () => {
  const { members } = clusterArtifacts(ARTS);
  const anastacio = members.find((m) => m.value === "taciocero@me.com")!.subject_id;
  const sheena = members.find((m) => m.value === "nicole@bay2pacificre.com")!.subject_id;
  const jordan = members.find((m) => m.kind === "username" && m.value === "jordangalen")!.subject_id;
  const ids = new Set([anastacio, sheena, jordan]);
  assertEquals(ids.size, 3, "all three people resolve to three DISTINCT C-1 subjects");
});
