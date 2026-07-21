import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRecoveredAssistantText,
  buildRecoveredNextPivots,
  isStaleActiveThread,
  shouldInsertRecoveredAssistant,
  STALE_RUN_AFTER_MS,
} from "./recovery.ts";

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
  assertStringIncludes(text, "## Recommended Next Pivots");
  assertStringIncludes(text, "**email**");
  assertStringIncludes(text, "Investigate jane@example.com");
  assertStringIncludes(text, "### Gaps");
});

Deno.test("buildRecoveredNextPivots: kind groups + memory lines; strips secret memory", () => {
  const lines = buildRecoveredNextPivots(
    [
      { kind: "email", value: "jane@example.com", confidence: 80 },
      { kind: "username", value: "jdoe88", confidence: 60 },
      { kind: "ip", value: "1.2.3.4", confidence: 70 },
    ],
    [
      { kind: "lesson", subject: "jdoe88", content: "Previously seen on GitHub with matching bio" },
      { kind: "lesson", subject: "jane@example.com", content: "password reuse pattern David1!1" },
    ],
  );
  assert(lines.some((l) => l.includes("**email**") && l.includes("consider:")));
  assert(lines.some((l) => l.includes("**username**") && l.includes("consider:")));
  assert(lines.some((l) => l.includes("**ip**") && l.includes("consider:")));
  assert(lines.some((l) => l.includes("Investigate jane@example.com")));
  assert(lines.some((l) => l.includes("[MEMORY]") && l.includes("jdoe88")));
  assertEquals(lines.some((l) => /password/i.test(l)), false, "secret-like memory must not appear");
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