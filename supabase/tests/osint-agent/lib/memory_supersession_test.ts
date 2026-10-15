import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANALYST_FALSE_LESSON_RE,
  applyMemorySupersession,
  isAnalystFalseLesson,
  memoryAssertsSelector,
  refuseConflictingMemoryWrites,
  rejectedSelectorsFromRows,
  type MemoryRow,
} from "../../../functions/osint-agent/lib/memory-supersession.ts";

/**
 * The analyst's Wrong → lesson, EXACTLY as src/lib/analyst-decisions.ts
 * `buildFalsePositiveLesson` writes it (and as the production rows from thread
 * b74049ad already read). If this string and the frontend builder ever diverge,
 * src/test/analyst-lesson-wording.test.ts fails on the other side.
 */
function analystLesson(value: string, kind: string): MemoryRow {
  return {
    id: `lesson-${value}`,
    kind: "lesson",
    subject: value.trim().toLowerCase(),
    subject_kind: kind,
    related_values: [],
    content:
      `Analyst marked "${value}" (${kind}) as FALSE / incorrect data. ` +
      `Do NOT re-propose this artifact in future investigations for the same user. ` +
      `Treat as a confirmed false positive even if a tool surfaces it again.`,
    confidence: 95,
    created_at: "2026-09-08T07:00:00Z",
  };
}

// The agent's PRE-review memory, thread b74049ad. Both saved before the analyst
// touched anything; both wrong.
const TRANSFERRED_HANDLE_THEORY: MemoryRow = {
  id: "m-theory", kind: "lesson", subject: "glitterkittens12", subject_kind: "username",
  related_values: ["dgoff1276@gmail.com", "diamond nicole", "104.54.98.171"],
  content: "Breach data shows glitterkittens12 belonged to Diamond Nicole in Springfield MO; the handle was likely transferred to the current Instagram operator.",
  confidence: 74, created_at: "2026-09-08T06:56:00Z",
};
const BREACH_IDENTITY: MemoryRow = {
  id: "m-identity", kind: "identity", subject: "glitterkittens12", subject_kind: "username",
  related_values: ["dgoff1276@gmail.com", "diamond nicole", "springfield, missouri"],
  content: "Instagram @glitterkittens12 links to dgoff1276@gmail.com (Diamond Nicole), Springfield MO, IP 104.54.98.171.",
  confidence: 60, created_at: "2026-09-08T06:56:30Z",
};
// Memory that must SURVIVE — no rejected selector, or a neutral lesson.
const SAC_ARCHIVES: MemoryRow = {
  id: "m-sac", kind: "identity", subject: "glitterkittens12",
  related_values: ["sac archives", "sacramento gang archives"],
  content: "Instagram @glitterkittens12 is 'Sac Archives', a Sacramento crime-commentary account.",
  confidence: 70, created_at: "2026-09-08T07:04:00Z",
};
const NEUTRAL_PATTERN: MemoryRow = {
  id: "m-neutral", kind: "pattern", subject: "oathnet_db",
  related_values: [], content: "oathnet_db breach IPs are from 2015-2016 and usually stale.", confidence: 55,
};

Deno.test("the shipped analyst-lesson wording is recognised (and only it)", () => {
  assert(isAnalystFalseLesson(analystLesson("Diamond Nicole", "name")));
  assert(isAnalystFalseLesson(analystLesson("dgoff1276@gmail.com", "email")));
  // kind-less variant the builder emits when the artifact kind is unknown
  assert(ANALYST_FALSE_LESSON_RE.test(`Analyst marked "x@y.io" as FALSE / incorrect data. Do NOT re-propose`));
  // The agent's own lesson is NOT a ruling, however confident it sounds.
  assertEquals(isAnalystFalseLesson(TRANSFERRED_HANDLE_THEORY), false);
  assertEquals(isAnalystFalseLesson({ kind: "identity", content: `Analyst marked "x" as FALSE / incorrect data` }), false);
});

Deno.test("⛔ the brief's sequence: theory saved → analyst rejects → recall → only the ruling is active", () => {
  // 1-2. positive theories exist; analyst marks name + email Wrong (writes lessons)
  const recalled = [
    TRANSFERRED_HANDLE_THEORY, BREACH_IDENTITY, SAC_ARCHIVES, NEUTRAL_PATTERN,
    analystLesson("Diamond Nicole", "name"), analystLesson("dgoff1276@gmail.com", "email"),
  ];
  // 3. planner recalls memory (no thread review state needed — lessons carry it)
  const { active, superseded } = applyMemorySupersession(recalled, []);
  const activeIds = active.map((r) => r.id);
  const supersededIds = superseded.map((x) => x.row.id);

  // 4. only the analyst rejection is active
  assert(!activeIds.includes("m-theory"), "transferred-handle theory must not be active");
  assert(!activeIds.includes("m-identity"), "breach identity memory must not be active");
  assertEquals(supersededIds.sort(), ["m-identity", "m-theory"]);
  for (const x of superseded) assertEquals(x.source, "analyst_lesson");
  assert(activeIds.includes("lesson-Diamond Nicole"));
  assert(activeIds.includes("lesson-dgoff1276@gmail.com"));
  // ...and nothing unrelated was gutted: the KEPT identity and a neutral pattern survive.
  assert(activeIds.includes("m-sac"), "Sac Archives identity must stay active");
  assert(activeIds.includes("m-neutral"), "neutral pattern must stay active");
  // Retained, not deleted: every input row is in exactly one partition.
  assertEquals(active.length + superseded.length, recalled.length);
});

Deno.test("the CURRENT thread's Wrong/Dismiss supersedes even before a lesson exists", () => {
  const { active, superseded } = applyMemorySupersession(
    [TRANSFERRED_HANDLE_THEORY, SAC_ARCHIVES],
    [{ value: "dgoff1276@gmail.com" }],
  );
  assertEquals(superseded.length, 1);
  assertEquals(superseded[0].row.id, "m-theory");
  assertEquals(superseded[0].source, "thread_review");
  assertEquals(active.map((r) => r.id), ["m-sac"]);
});

Deno.test("⛔ step 5: a later positive write for the rejected relationship is refused; a lesson passes", () => {
  const rejected = rejectedSelectorsFromRows([{ value: "dgoff1276@gmail.com" }, { value: "Diamond Nicole" }]);
  const { toPersist, refused } = refuseConflictingMemoryWrites(
    [
      { kind: "identity", subject: "glitterkittens12", related_values: ["dgoff1276@gmail.com"], content: "still probably Diamond Nicole", confidence: 70 },
      { kind: "connection", subject: "diamond nicole", related_values: [], content: "linked to the handle", confidence: 60 },
      // An agent lesson recording the false lead is fine — it agrees with the analyst.
      { kind: "lesson", subject: "glitterkittens12", related_values: [], content: "dgoff1276@gmail.com was a breach-only false lead; do not chase.", confidence: 60 },
      // Unrelated positive memory is untouched.
      { kind: "identity", subject: "glitterkittens12", related_values: ["sac archives"], content: "Sac Archives operator", confidence: 70 },
    ],
    rejected,
  );
  assertEquals(refused.length, 2);
  assertEquals(refused.map((r) => r.entry.kind).sort(), ["connection", "identity"]);
  for (const r of refused) assert(r.reason.includes("analyst rejection"), r.reason);
  assertEquals(toPersist.map((e) => e.kind), ["lesson", "identity"]);
});

Deno.test("keyspace is lower/trim equality on structured fields — NOT punctuation-collapsed, NOT substring", () => {
  // A rejected `name` "Jordan Vale" must not suppress a memory about the
  // username "jordan.vale" — the collision normalizeTarget would produce.
  const aboutUsername: MemoryRow = { kind: "identity", subject: "jordan.vale", related_values: [], content: "jordan.vale is a dev handle" };
  assertEquals(memoryAssertsSelector(aboutUsername, "Jordan Vale"), false);
  // A NAME mentioned only in free text is not an assertion about it.
  const prose: MemoryRow = { kind: "pattern", subject: "sacramento", related_values: [], content: "posts sometimes mention Diamond Nicole in passing" };
  assertEquals(memoryAssertsSelector(prose, "diamond nicole"), false);
  // An EMAIL in free text IS — emails are unambiguous in prose.
  assertEquals(memoryAssertsSelector(prose, "x@y.io"), false);
  assertEquals(memoryAssertsSelector({ ...prose, content: "reach at dgoff1276@gmail.com" }, "DGoff1276@Gmail.com"), true);
  // Too-short "selectors" never match anything.
  assertEquals(memoryAssertsSelector({ subject: "us", related_values: ["us"], content: "us" }, "us"), false);
  assertEquals(rejectedSelectorsFromRows([{ value: "us" }, { value: "  " }]).size, 0);
});
