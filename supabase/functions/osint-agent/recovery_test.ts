import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assistantPartsToText, buildRecoveredAssistantText, hasRunMarker, isStaleActiveThread, RECENT_ASSISTANT_WINDOW_MS, REQUIRE_RUN_MARKER_FOR_RECOVERY, shouldInsertRecoveredAssistant, STALE_RUN_AFTER_MS } from "./recovery.ts";

Deno.test("P0-A: a blank thread that never ran is NEVER recovery-eligible", () => {
  // THE PRODUCTION GHOST (thread 40f8a6eb, 2026-07-26 00:19:10Z). Reproduces the
  // exact row: `WorkspaceHeader.createInvestigation` inserts only user_id, so the
  // thread is born status='active' (column default) with BOTH timestamps null and
  // updated_at == created_at. 92.9s later the ChatWindow +90s trailing health sweep
  // fired and recovery posted "Findings report — recovered run" into a chat the
  // analyst had never typed into. 14 threads in production carry that ghost, and
  // 192 of 264 threads were sitting eligible for it.
  const created = Date.parse("2026-07-26T00:19:10.207Z");
  const blank = {
    id: "40f8a6eb", user_id: "u", status: "active",
    title: "New investigation", seed_value: null,
    run_started_at: null, last_heartbeat_at: null,
    updated_at: new Date(created).toISOString(),
  };
  assertEquals(hasRunMarker(blank), false, "no run marker → never started");
  // The sweep that actually fired, at +92.9s — comfortably past the 75s bar.
  assertEquals(isStaleActiveThread(blank, created + 92_863), false, "the +90s sweep must decline");
  // And it must keep declining forever, not merely early.
  assertEquals(isStaleActiveThread(blank, created + 86_400_000), false, "still not a stale run a day later");
});

Deno.test("P0-A: the gate does NOT weaken recovery of a genuinely dead run", () => {
  const now = Date.parse("2026-07-26T14:00:00Z");
  // A real run: markRunStarted stamped both fields, then the isolate was killed and
  // the heartbeat went silent. This MUST still be reaped.
  const dead = {
    id: "t", user_id: "u", status: "active",
    run_started_at: new Date(now - 200_000).toISOString(),
    last_heartbeat_at: new Date(now - STALE_RUN_AFTER_MS - 1).toISOString(),
    updated_at: new Date(now - STALE_RUN_AFTER_MS - 1).toISOString(),
  };
  assertEquals(hasRunMarker(dead), true);
  assertEquals(isStaleActiveThread(dead, now), true, "a real dead run is still recovered");

  // Legacy safety: rows carrying only a heartbeat (no run_started_at) still count as
  // started. Production has zero such rows today, but the predicate must not
  // silently strand them if one appears.
  assertEquals(hasRunMarker({ run_started_at: null, last_heartbeat_at: new Date(now - 100_000).toISOString() }), true);
});

Deno.test("P0-A: the run-marker gate ships ENABLED", () => {
  assertEquals(REQUIRE_RUN_MARKER_FOR_RECOVERY, true, "kill switch must ship on");
});

Deno.test("isStaleActiveThread: uses heartbeat when present", () => {
  const now = Date.parse("2026-07-15T13:00:00Z");
  assertEquals(isStaleActiveThread({
    id: "t", user_id: "u", status: "active",
    last_heartbeat_at: new Date(now - STALE_RUN_AFTER_MS - 1).toISOString(),
    updated_at: new Date(now).toISOString(),
  }, now), true);
  assertEquals(isStaleActiveThread({
    id: "t", user_id: "u", status: "active",
    last_heartbeat_at: new Date(now - 5_000).toISOString(),
    updated_at: new Date(now - STALE_RUN_AFTER_MS - 1).toISOString(),
  }, now), false);
});

Deno.test("isStaleActiveThread: ignores terminal threads", () => {
  const old = new Date(Date.now() - STALE_RUN_AFTER_MS - 10_000).toISOString();
  assertEquals(isStaleActiveThread({ id: "t", user_id: "u", status: "finished", last_heartbeat_at: old }), false);
  assertEquals(isStaleActiveThread({ id: "t", user_id: "u", status: "stopped", last_heartbeat_at: old }), false);
});

Deno.test("buildRecoveredAssistantText: emits a report-shaped artifact table", () => {
  const text = buildRecoveredAssistantText(
    { seed_value: "jane@example.com", last_heartbeat_at: "2026-07-15T12:00:00Z" },
    [{ kind: "email", value: "jane@example.com", confidence: 88, source: "oathnet_lookup" }],
  );
  assertStringIncludes(text, "Findings report");
  assertStringIncludes(text, "jane@example.com");
  assertStringIncludes(text, "oathnet_lookup");
  assert(text.includes("| # | Kind | Value | Confidence | Source |"));
});

Deno.test("shouldInsertRecoveredAssistant: ignores old assistant from a prior turn", () => {
  const runStarted = "2026-07-15T14:42:54Z";
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: runStarted, last_heartbeat_at: "2026-07-15T14:43:55Z", updated_at: "2026-07-15T14:43:55Z" },
    "2026-07-15T14:30:37Z",
    Date.parse("2026-07-15T14:45:12Z"),
  ), { shouldInsert: true, reason: "assistant_before_run" });
});

Deno.test("shouldInsertRecoveredAssistant: does not duplicate a fresh assistant from this run", () => {
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: "2026-07-15T14:42:54Z", last_heartbeat_at: "2026-07-15T14:43:55Z", updated_at: "2026-07-15T14:43:55Z" },
    "2026-07-15T14:44:30Z",
    Date.parse("2026-07-15T14:45:12Z"),
  ), { shouldInsert: false, reason: "none" });
});

Deno.test("shouldInsertRecoveredAssistant: NEVER stubs over a this-run report even when the sweeper runs long after it", () => {
  // The exact finalize-gate window: report inserted, status flip lost to a tail
  // kill, and a stray heartbeat pulsed AFTER the report so `now - assistantMs`
  // exceeds the recency window — the timing heuristic alone would (wrongly)
  // re-stub. The report-shape guard must veto that.
  const runStarted = "2026-07-15T14:42:54Z";
  const reportText = "## Findings report\n\n| # | Kind | Value |\n|---:|---|---|\n| 1 | email | a@b.com |";
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: runStarted, last_heartbeat_at: "2026-07-15T14:44:40Z", updated_at: "2026-07-15T14:44:40Z" },
    "2026-07-15T14:44:20Z", // report written during the run, before the last heartbeat pulse
    Date.parse("2026-07-15T14:50:00Z"), // sweeper runs 5+ min later → past the 2-min window
    RECENT_ASSISTANT_WINDOW_MS,
    reportText,
  ), { shouldInsert: false, reason: "report_present" });
});

Deno.test("shouldInsertRecoveredAssistant: still stubs when the this-run assistant is mid-run narration, not a report", () => {
  // A this-run assistant part that carries NO report shape (only inter-step
  // narration) must fall through to the staleness heuristics and still recover.
  const runStarted = "2026-07-15T14:42:54Z";
  const narration = "Going deeper into the breach corpora now, checking a few more sources.";
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: runStarted, last_heartbeat_at: "2026-07-15T14:47:00Z", updated_at: "2026-07-15T14:47:00Z" },
    "2026-07-15T14:44:20Z",
    Date.parse("2026-07-15T14:50:00Z"),
    RECENT_ASSISTANT_WINDOW_MS,
    narration,
  ), { shouldInsert: true, reason: "assistant_stale" });
});

Deno.test("shouldInsertRecoveredAssistant: a prior-turn report does NOT suppress a genuine stub", () => {
  // Report-shaped text but the assistant predates run start (a previous turn's
  // report). This run produced nothing → the before-run check must win over the
  // report-shape guard so recovery still stubs.
  const reportText = "## Findings report\n\n[Confirmed] a@b.com\n[Verify] c@d.com";
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: "2026-07-15T14:42:54Z", last_heartbeat_at: "2026-07-15T14:43:55Z", updated_at: "2026-07-15T14:43:55Z" },
    "2026-07-15T14:30:37Z", // before run start
    Date.parse("2026-07-15T14:45:12Z"),
    RECENT_ASSISTANT_WINDOW_MS,
    reportText,
  ), { shouldInsert: true, reason: "assistant_before_run" });
});

Deno.test("shouldInsertRecoveredAssistant: a durable finalize_no_findings decision suppresses the stub", () => {
  // I-2's OTHER terminal outcome. The decision lives in a tool PART, not text, so
  // assistantPartsToText yields "" and the report-shape guard cannot see it. Without
  // the parts-level check this run gets stamped Interrupted despite completing validly.
  const noFindingsParts = [
    { type: "text", text: "No further corroboration was available." },
    { type: "tool-finalize_no_findings", state: "output-available", output: { ok: true, reason: "no additional leads" } },
  ];
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: "2026-07-15T14:42:54Z", last_heartbeat_at: "2026-07-15T14:43:55Z", updated_at: "2026-07-15T14:43:55Z" },
    "2026-07-15T14:43:50Z",
    Date.parse("2026-07-15T14:52:12Z"), // well past the recent-assistant window
    RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(noFindingsParts),
    noFindingsParts,
  ), { shouldInsert: false, reason: "no_findings_present" });
});

Deno.test("shouldInsertRecoveredAssistant: a PRIOR-turn no-findings decision does NOT suppress a genuine stub", () => {
  // Same scoping rule the report-shape guard obeys: a decision from an earlier turn
  // must not mark THIS run terminal, so the before-run check still wins.
  const noFindingsParts = [{ type: "tool-finalize_no_findings", state: "output-available", output: { ok: true } }];
  assertEquals(shouldInsertRecoveredAssistant(
    { run_started_at: "2026-07-15T14:42:54Z", last_heartbeat_at: "2026-07-15T14:43:55Z", updated_at: "2026-07-15T14:43:55Z" },
    "2026-07-15T14:30:37Z", // before run start
    Date.parse("2026-07-15T14:45:12Z"),
    RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(noFindingsParts),
    noFindingsParts,
  ), { shouldInsert: true, reason: "assistant_before_run" });
});

Deno.test("assistantPartsToText: joins text parts, ignores tool/non-text parts and bad input", () => {
  assertEquals(
    assistantPartsToText([{ type: "text", text: "hello" }, { type: "tool-call", toolName: "x" }, { type: "text", text: "world" }]),
    "hello\nworld",
  );
  assertEquals(assistantPartsToText(null), "");
  assertEquals(assistantPartsToText("nope"), "");
  assertEquals(assistantPartsToText([{ type: "text" }]), "");
});