import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRecoveredAssistantText, isStaleActiveThread, needsFinishedReportRefresh, shouldInsertRecoveredAssistant, STALE_RUN_AFTER_MS } from "./recovery.ts";
import { hasReportShape } from "./orchestrator-finalize.ts";

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

Deno.test("buildRecoveredAssistantText: 0 artifacts is NOT report-shaped and does not claim 'no confirmed artifacts'", () => {
  const text = buildRecoveredAssistantText(
    { seed_value: "dustin ploughe rocklin ca", last_heartbeat_at: "2026-07-19T23:01:05Z" },
    [],
  );
  // Must not masquerade as a finished findings report, so the refresh sweep can
  // still complete it once artifacts become durable.
  assertFalse(hasReportShape(text));
  assertStringIncludes(text, "Run interrupted");
  // The misleading definitive claim must be gone.
  assert(!text.includes("No confirmed artifacts were recorded"));
});

Deno.test("needsFinishedReportRefresh: true when artifacts exist but text has no report shape", () => {
  // Checkpoint-style bullet text — real findings but no report shape.
  const checkpointText = "🔎 Progress checkpoint — recorded 11 new findings: name: Dustin Timothy Ploughe; email dustinploughe@live.com";
  assertEquals(needsFinishedReportRefresh(checkpointText, 39), true);
  // The "run interrupted" stub is also refreshable once artifacts land.
  assertEquals(needsFinishedReportRefresh("### Run interrupted\n\nThe investigation stopped.", 12), true);
});

Deno.test("needsFinishedReportRefresh: false when a real report exists or no artifacts", () => {
  const report = buildRecoveredAssistantText(
    { seed_value: "jane@example.com", last_heartbeat_at: "2026-07-15T12:00:00Z" },
    [{ kind: "email", value: "jane@example.com", confidence: 88, source: "oathnet_lookup" }],
  );
  assertEquals(needsFinishedReportRefresh(report, 5), false); // already report-shaped
  assertEquals(needsFinishedReportRefresh("anything at all", 0), false); // nothing to synthesize
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