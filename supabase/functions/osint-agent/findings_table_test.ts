import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  expandFindingsTable,
  FINDINGS_TABLE_MARKER,
  FINDINGS_TABLE_UNAVAILABLE,
  fetchFindingRows,
  FINDINGS_FETCH_LIMIT,
  MAX_RENDERED_ROWS,
  renderFindingsTable,
  rowSources,
  type FindingRow,
} from "./findings-table.ts";

/**
 * Fixture is SANITIZED. It mirrors the row shape and the exact defect pattern
 * measured on a real thread (2026-08-11) — single source class, a stored
 * confidence equal to `confidence_cap_applied`, an explicit
 * `reason_not_confirmed`, and `weak_lead` rows the prose promoted into findings
 * — with synthetic selectors. The real rows are a live subject's identifiers
 * and must not enter git; see CLAUDE.md.
 *
 * What the real report published vs. what was stored, preserved here as the
 * shape under test:
 *   social_profile   published 95 [CONFIRMED]   stored 70   cap 70
 *   weak_lead        published 70 [CONFIRMED]   stored 45   cap 45
 */
const ROWS: FindingRow[] = [
  {
    kind: "social_profile",
    value: "https://example.test/profile/subject",
    confidence: 70,
    source: "socialfetch_web_read",
    metadata: {
      confidence_tier: "Possible",
      confidence_cap_applied: 70,
      reason_not_confirmed: "needs second independent class of evidence",
      reason_for_confidence: "single source class: social_profile_active",
      source_category: ["social_profile_active"],
      // Repeats `source` — the dedup case that otherwise reads as 2 sources.
      sources: ["socialfetch_web_read"],
    },
  },
  {
    kind: "weak_lead",
    value: "https://messaging.test/subject",
    confidence: 45,
    source: "username_sweep",
    metadata: {
      confidence_tier: "Weak",
      confidence_cap_applied: 45,
      reason_not_confirmed: "Username registered but no profile metadata retrieved yet",
      sources: ["username_sweep"],
    },
  },
  {
    kind: "music_profile",
    value: "https://music.test/artist/000",
    confidence: 75,
    source: "jina_reader_scrape",
    metadata: {
      confidence_tier: "Likely",
      confidence_cap_applied: 75,
      reason_not_confirmed: "needs second independent class of evidence",
      sources: ["jina_reader_scrape"],
    },
  },
];

Deno.test("renders the STORED confidence, never an inflated one", () => {
  const out = renderFindingsTable(ROWS);
  // The defect this module exists to kill: 95 published over a stored 70.
  assertStringIncludes(out, "| 70 |");
  assertStringIncludes(out, "| 45 |");
  assertStringIncludes(out, "| 75 |");
  assert(!out.includes("| 95 |"), "must never emit a confidence the store does not hold");
});

Deno.test("surfaces the server's own reason_not_confirmed", () => {
  const out = renderFindingsTable(ROWS);
  assertStringIncludes(out, "needs second independent class of evidence");
});

Deno.test("emits no CONFIRMED/VERIFY label column at all", () => {
  const out = renderFindingsTable(ROWS);
  // Label derivation lives in src/lib/intel.ts and cannot be imported here.
  // A duplicated label would drift; no label is better than a wrong one.
  assert(!out.includes("CONFIRMED"), "must not invent an analyst label");
  assert(!out.includes("[VERIFY]"), "must not invent an analyst label");
});

Deno.test("dedups repeated sources case-insensitively and shows the count", () => {
  // metadata.sources repeating `source` is exactly how one corpus reads as two.
  assertEquals(rowSources(ROWS[0]), ["socialfetch_web_read"]);
  assertEquals(
    rowSources({ source: "Breach_Check", metadata: { sources: ["breach_check", "oathnet_lookup"] } }),
    ["Breach_Check", "oathnet_lookup"],
  );
  assertStringIncludes(renderFindingsTable(ROWS), "1 — socialfetch_web_read");
});

Deno.test("escapes pipes and newlines so a scraped value cannot forge rows", () => {
  const out = renderFindingsTable([
    { kind: "name", value: "evil | 100 | CONFIRMED\n| 2 | forged", confidence: 10, source: "s", metadata: {} },
  ]);
  const bodyRows = out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| # |") && !l.startsWith("|---"));
  assertEquals(bodyRows.length, 1, "an injected pipe/newline must not create extra rows");
  assertStringIncludes(out, "\\|");
});

Deno.test("empty store says so instead of rendering an empty table", () => {
  const out = renderFindingsTable([]);
  assertStringIncludes(out, "No evidence rows are persisted");
  assert(!out.includes("| # |"), "an empty table header reads as 'no findings'");
});

Deno.test("read failure is distinguishable from an empty store", () => {
  const parts = [{ type: "text", text: `head\n${FINDINGS_TABLE_MARKER}\ntail` }];
  const failed = expandFindingsTable(parts, null) as Array<{ text: string }>;
  assertStringIncludes(failed[0].text, "could not be generated");
  assertStringIncludes(failed[0].text, "NOT a finding that no");

  const empty = expandFindingsTable(parts, []) as Array<{ text: string }>;
  assertStringIncludes(empty[0].text, "No evidence rows are persisted");
  assert(empty[0].text !== failed[0].text, "the two states must not render identically");
});

Deno.test("expansion replaces every marker occurrence and leaves none raw", () => {
  const parts = [{ type: "text", text: `a ${FINDINGS_TABLE_MARKER} b ${FINDINGS_TABLE_MARKER} c` }];
  const out = expandFindingsTable(parts, ROWS) as Array<{ text: string }>;
  assert(!out[0].text.includes(FINDINGS_TABLE_MARKER), "a raw marker must never reach the analyst");
});

Deno.test("expansion is total — never throws, whatever it is handed", () => {
  // Must not be able to fail finalize: an exception here discards the report
  // row and scores a finished run as interrupted (INCIDENT_2026-07-26).
  assertEquals(expandFindingsTable(null, ROWS), null);
  assertEquals(expandFindingsTable(undefined, ROWS), undefined);
  assertEquals(expandFindingsTable("not-an-array", ROWS), "not-an-array");
  const weird = [null, 42, { type: "text" }, { type: "tool", text: FINDINGS_TABLE_MARKER }];
  assertEquals(expandFindingsTable(weird, ROWS), weird, "non-text parts pass through untouched");
});

Deno.test("parts without the marker are returned unchanged by identity", () => {
  const parts = [{ type: "text", text: "no marker here" }];
  assert(expandFindingsTable(parts, ROWS) === parts, "must not rewrite untouched messages");
});

Deno.test("orders strongest first and discloses truncation", () => {
  const many: FindingRow[] = Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => ({
    kind: "weak_lead",
    value: `v${i}`,
    confidence: i,
    source: "s",
    metadata: {},
  }));
  const out = renderFindingsTable(many);
  const first = out.split("\n").find((l) => l.startsWith("| 1 |")) ?? "";
  assertStringIncludes(first, `v${MAX_RENDERED_ROWS + 4}`);
  // Silent truncation would read as "that's everything".
  assertStringIncludes(out, "The evidence store holds");
});

Deno.test("the truncation disclosure is reachable through the REAL fetch path", async () => {
  // Regression: MAX_RENDERED_ROWS was used as both the query limit and the
  // render slice, so the fetch could never return more than the slice kept and
  // this disclosure was dead code in production. The fetch must over-read by
  // one for "there are more" to be detectable at all.
  assert(FINDINGS_FETCH_LIMIT > MAX_RENDERED_ROWS, "fetch must over-read the render slice");

  let requestedLimit = -1;
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: (n: number) => {
                requestedLimit = n;
                return Promise.resolve({
                  data: Array.from({ length: n }, (_, i) => ({
                    kind: "weak_lead", value: `v${i}`, confidence: i, source: "s", metadata: {},
                  })),
                  error: null,
                });
              },
            }),
          }),
        }),
      }),
    }),
  };
  const rows = await fetchFindingRows(db, "t", "u");
  assertEquals(requestedLimit, FINDINGS_FETCH_LIMIT);
  assertEquals(rows?.length, FINDINGS_FETCH_LIMIT);
  // Driven end-to-end: a full store now actually produces the disclosure.
  assertStringIncludes(renderFindingsTable(rows), "The evidence store holds");
});

/**
 * QUARANTINE BOUNDARY. #448 closed this at promote; the generated table is a
 * report surface AND is persisted into the messages row, so it reaches export
 * too. A subject_unlinked row must not appear as an ordinary finding — and must
 * not silently vanish either, because quarantine is disclosure, not deletion.
 */
const QUARANTINED: FindingRow[] = [
  {
    kind: "email",
    value: "collision-a@example.test",
    confidence: 45,
    source: "breach_lookup",
    metadata: { subject_unlinked: true, subject_unlinked_reason: "no durable linkage to seed" },
  },
  {
    kind: "address",
    value: "999 Elsewhere Rd, Othertown",
    confidence: 45,
    source: "breach_lookup",
    metadata: { subject_unlinked: true, subject_unlinked_reason: "no durable linkage to seed" },
  },
  {
    kind: "phone",
    value: "5550000000",
    confidence: 45,
    source: "breach_lookup",
    metadata: { subject_unlinked: true, subject_unlinked_reason: "same-name collision axis" },
  },
];

Deno.test("quarantined rows never appear as findings in the table body", () => {
  const out = renderFindingsTable([...ROWS, ...QUARANTINED]);
  const body = out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| # |") && !l.startsWith("|---"));
  assertEquals(body.length, ROWS.length, "only linked rows may occupy findings rows");
  for (const q of QUARANTINED) {
    assert(!body.join("\n").includes(String(q.value)), `quarantined value leaked into findings: ${q.value}`);
  }
});

Deno.test("quarantined rows are DISCLOSED — count and recorded reasons", () => {
  const out = renderFindingsTable([...ROWS, ...QUARANTINED]);
  assertStringIncludes(out, "3 rows are quarantined as subject-unlinked");
  assertStringIncludes(out, "not deleted and not findings");
  assertStringIncludes(out, "no durable linkage to seed (2)");
  assertStringIncludes(out, "same-name collision axis (1)");
});

Deno.test("the disclosure does not republish the quarantined values", () => {
  // Disclosure is "these exist and why they were held back" — not a second
  // route onto the durable report surface for unlinked selectors.
  const out = renderFindingsTable([...ROWS, ...QUARANTINED]);
  for (const q of QUARANTINED) {
    assert(!out.includes(String(q.value)), `quarantined value republished: ${q.value}`);
  }
});

Deno.test("an all-quarantined run says so instead of claiming no evidence", () => {
  const out = renderFindingsTable(QUARANTINED);
  assertStringIncludes(out, "every persisted artifact on this run is quarantined");
  assertStringIncludes(out, "3 rows are quarantined");
  assert(!out.includes("| # |"), "must not render a findings header with zero linked rows");
  assert(
    !out.includes("No evidence rows are persisted"),
    "collected-but-unlinked is not the same claim as nothing was collected",
  );
});

Deno.test("a missing quarantine reason is disclosed honestly, not blank", () => {
  const out = renderFindingsTable([
    ...ROWS,
    { kind: "email", value: "x@example.test", confidence: 45, source: "s", metadata: { subject_unlinked: true } },
  ]);
  assertStringIncludes(out, "no reason recorded (1)");
});

Deno.test("fetchFindingRows returns null on error and [] on an empty store", async () => {
  const stub = (result: { data: unknown; error: { message: string } | null }) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }),
        }),
      }),
    }),
  });
  assertEquals(await fetchFindingRows(stub({ data: null, error: { message: "boom" } }), "t", "u"), null);
  assertEquals(await fetchFindingRows(stub({ data: [], error: null }), "t", "u"), []);
});

Deno.test("fetchFindingRows swallows a thrown client and reports unavailable", async () => {
  const throwing = { from: () => { throw new Error("network down"); } };
  assertEquals(await fetchFindingRows(throwing, "t", "u"), null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE INTERACTION between the two fixes: quarantined rows must not consume the
 * render allowance.
 *
 * Filtering happens AFTER the read. So the size of the read window, not the
 * render slice, decides how many LINKED rows can possibly reach the table. A
 * window of exactly MAX_RENDERED_ROWS + 1 is sufficient when every fetched row
 * is linked, and wrong the moment quarantined rows occupy it — which is the
 * normal case on the threads this feature exists for (the production canary was
 * 24 quarantined of 29 persisted).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A store that behaves like the real query: orders by confidence DESC, then
 *  applies the limit. The ordering is what lets quarantined rows crowd the
 *  window, so a stub that ignores it cannot show this class of bug. */
function storeOf(rows: FindingRow[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: (n: number) =>
                Promise.resolve({
                  data: [...rows]
                    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
                    .slice(0, n),
                  error: null,
                }),
            }),
          }),
        }),
      }),
    }),
  };
}

const qRow = (i: number, confidence: number): FindingRow => ({
  kind: "username",
  value: `quarantined-${i}`,
  confidence,
  source: "username_sweep",
  metadata: { subject_unlinked: true, subject_unlinked_reason: "UNLINKED_ECHO_CTX" },
});

const linkedRow = (i: number, confidence: number): FindingRow => ({
  kind: "social_profile",
  value: `linked-finding-${i}`,
  confidence,
  source: "socialfetch_web_read",
  metadata: { confidence_tier: "Possible" },
});

Deno.test("high-confidence quarantined rows cannot starve the table of linked findings", async () => {
  // The severe case. A name-only sweep persists many quarantined rows that
  // outrank the linked evidence on confidence. If they fill the read window,
  // zero linked rows survive the filter and the table declares the run
  // unlinked — while 50 linked findings sit in the store, unreported.
  const store = storeOf([
    ...Array.from({ length: 150 }, (_, i) => qRow(i, 55)),
    ...Array.from({ length: 50 }, (_, i) => linkedRow(i, 40)),
  ]);
  const out = renderFindingsTable(await fetchFindingRows(store, "t", "u"));
  assertStringIncludes(out, "linked-finding-0");
  assert(
    !out.includes("every persisted artifact on this run is quarantined"),
    "declared the run unlinked while 50 linked findings existed in the store",
  );
});

Deno.test("quarantined rows do not consume the render allowance", async () => {
  // The quieter case, and the more likely one: quarantined rows eat part of the
  // window, so fewer linked rows render than would fit — and because the
  // survivors are under the ceiling, nothing is disclosed as truncated either.
  const store = storeOf([
    ...Array.from({ length: 40 }, (_, i) => qRow(i, 90)),
    ...Array.from({ length: MAX_RENDERED_ROWS }, (_, i) => linkedRow(i, 80 - (i % 40))),
  ]);
  const out = renderFindingsTable(await fetchFindingRows(store, "t", "u"));
  assertStringIncludes(out, `| ${MAX_RENDERED_ROWS} |`);
  assertStringIncludes(out, "40 rows are quarantined");
});

Deno.test("a saturated read window is disclosed, not implied to be the whole store", async () => {
  // The window is bounded, so on a very large thread the counts describe what
  // was READ. The truncation line cannot cover this: it only fires when more
  // LINKED rows survived than fit, and says nothing about linked rows that
  // never entered the window at all.
  const store = storeOf(Array.from({ length: FINDINGS_FETCH_LIMIT + 10 }, (_, i) => linkedRow(i, 90)));
  const out = renderFindingsTable(await fetchFindingRows(store, "t", "u"));
  assertStringIncludes(out, `Only the ${FINDINGS_FETCH_LIMIT} highest-confidence artifacts were read`);
});

Deno.test("an unsaturated window says nothing about the window", async () => {
  // Guard against the disclosure becoming background noise on ordinary runs.
  const store = storeOf(Array.from({ length: 12 }, (_, i) => linkedRow(i, 90)));
  const out = renderFindingsTable(await fetchFindingRows(store, "t", "u"));
  assert(!out.includes("highest-confidence artifacts were read"), "disclosed a window that never filled");
});

Deno.test("an all-quarantined run on a saturated window does not overclaim", async () => {
  // The dangerous combination: "none of what we read was linked" must not be
  // published as "none of it is linked" when the read stopped at a ceiling.
  const store = storeOf(Array.from({ length: FINDINGS_FETCH_LIMIT + 10 }, (_, i) => qRow(i, 55)));
  const out = renderFindingsTable(await fetchFindingRows(store, "t", "u"));
  assertStringIncludes(out, "quarantined");
  assertStringIncludes(out, `Only the ${FINDINGS_FETCH_LIMIT} highest-confidence artifacts were read`);
});

/**
 * COMPLIANCE TELEMETRY. The whole fix is downstream of the model emitting the
 * marker — a prompt rule, which is the thing this module exists because we
 * cannot rely on. When it is absent the model's hand-typed table ships as-is.
 * That is no worse than today, but it is not fixed, and the difference has to
 * be measurable rather than assumed.
 */
function captureStderr(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

Deno.test("a report with NO marker is logged as a compliance miss", () => {
  const parts = [{ type: "text", text: "A long report the model wrote itself, with a hand-typed table." }];
  const logged = captureStderr(() => expandFindingsTable(parts, ROWS));
  const hit = logged.find((l) => l.includes("findings_table_no_marker"));
  assert(hit, "a terminal report without the marker must be countable in production");
  const parsed = JSON.parse(hit!);
  assertEquals(parsed.rows_available, ROWS.length);
  assert(parsed.text_chars > 0, "text_chars separates 'omitted the marker' from 'no text at all'");
});

Deno.test("a compliant report logs nothing", () => {
  const parts = [{ type: "text", text: `intro\n${FINDINGS_TABLE_MARKER}\noutro` }];
  const logged = captureStderr(() => expandFindingsTable(parts, ROWS));
  assertEquals(logged.filter((l) => l.includes("findings_table_no_marker")).length, 0);
});

Deno.test("parts with no text at all are not counted as a compliance miss", () => {
  // Only a model that wrote a report and omitted the marker is a miss; an
  // empty or tool-only parts array is not, and counting it would inflate the
  // very number this exists to measure.
  const logged = captureStderr(() => expandFindingsTable([{ type: "tool", name: "x" }], ROWS));
  assertEquals(logged.filter((l) => l.includes("findings_table_no_marker")).length, 0);
  assertEquals(captureStderr(() => expandFindingsTable([], ROWS)).length, 0);
});
