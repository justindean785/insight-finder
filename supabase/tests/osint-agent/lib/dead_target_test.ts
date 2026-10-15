// lib/dead_target_test.ts — the pure half of the dead-target memory.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDeadTargets, deadTargetCount, deadTargetRefusal, describeDeadTargetMemory,
  isDeadTarget, DEAD_TARGET_FLOOR, DEAD_TARGET_REFUSAL_ERROR,
} from "../../../functions/osint-agent/lib/dead-target.ts";
import { classifyToolOutcome } from "../../../functions/osint-agent/tool-outcome.ts";

const normalize = (s: string) => s.trim().toLowerCase();
const selOf = (i: Record<string, unknown>) => normalize(String(i.url ?? i.username ?? i.email ?? i.value ?? ""));

const YT = "https://youtube.com/@lildee808_first";
const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0)).toISOString();

Deno.test("counts FAILED rows per tool+selector, reading both input_json shapes", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(0) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { input: { url: YT.toUpperCase() } }, created_at: at(1) },
    { tool_name: "socialfetch_web_read", outcome: "skipped", input_json: { url: YT }, created_at: at(2) },
    { tool_name: "jina_reader_scrape", outcome: "failed", input_json: { url: YT }, created_at: at(3) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: "https://youtube.com/@other" }, created_at: at(4) },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 2);
  assertEquals(deadTargetCount(map, "jina_reader_scrape", normalize(YT)), 1);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", "https://youtube.com/@other"), 1);
});

Deno.test("a later SUCCESS clears the streak — failure → failure → success is not dead", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(0) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(1) },
    { tool_name: "socialfetch_web_read", outcome: "ok", input_json: { url: YT }, created_at: at(2) },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 0);
  assert(!isDeadTarget(map, "socialfetch_web_read", normalize(YT)));
});

Deno.test("`empty` also clears: a clean negative proves the target is reachable", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(0) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(1) },
    { tool_name: "socialfetch_web_read", outcome: "empty", input_json: { url: YT }, created_at: at(2) },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 0);
});

Deno.test("the streak is counted FROM the last success, so it can go dead again", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(0) },
    { tool_name: "socialfetch_web_read", outcome: "ok", input_json: { url: YT }, created_at: at(1) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(2) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(3) },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 2);
  assert(isDeadTarget(map, "socialfetch_web_read", normalize(YT)));
});

Deno.test("`skipped` neither counts nor clears — our own refusals cannot amplify the gate", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(0) },
    { tool_name: "socialfetch_web_read", outcome: "skipped", input_json: { url: YT }, created_at: at(1) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(2) },
    { tool_name: "socialfetch_web_read", outcome: "skipped", input_json: { url: YT }, created_at: at(3) },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 2);
});

Deno.test("rows are sorted by created_at, so an unordered page cannot invert the answer", () => {
  const newestFirst = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(3) },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT }, created_at: at(2) },
    { tool_name: "socialfetch_web_read", outcome: "ok", input_json: { url: YT }, created_at: at(1) },
  ], selOf);
  assertEquals(deadTargetCount(newestFirst, "socialfetch_web_read", normalize(YT)), 2);
});

Deno.test("the floor is per (tool, selector): a different tool on the same target is not dead", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT } },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT } },
  ], selOf);
  assert(isDeadTarget(map, "socialfetch_web_read", normalize(YT)));
  assert(!isDeadTarget(map, "jina_reader_scrape", normalize(YT)));
  assert(!isDeadTarget(map, "socialfetch_web_read", "https://youtube.com/@other"));
  assertEquals(DEAD_TARGET_FLOOR, 2);
});

Deno.test("rows without a selector or tool are ignored, never thrown on", () => {
  const map = buildDeadTargets([
    { tool_name: "x", outcome: "failed", input_json: null },
    { tool_name: "", outcome: "failed", input_json: { url: YT } },
    { outcome: "failed", input_json: "garbage" },
    { tool_name: "x", outcome: "failed", input_json: { purpose: "default" } },
  ], selOf);
  assertEquals(map.size, 0);
});

Deno.test("the refusal is a governance SKIP with a constant message the outcome classifier reads as skipped", () => {
  const r = deadTargetRefusal("socialfetch_web_read", normalize(YT), 3);
  assertEquals(r.ok, false);
  assertEquals(r.skipped, true);
  assertEquals(r.error, DEAD_TARGET_REFUSAL_ERROR);
  assertEquals(r.prior_failures, 3);
  assertEquals(classifyToolOutcome(r.error, null), "skipped");
});

Deno.test("kill switch is read at call time and reported on /health", () => {
  Deno.env.delete("DEAD_TARGET_MEMORY_DISABLED");
  assertEquals(describeDeadTargetMemory().detail, `enabled, floor=${DEAD_TARGET_FLOOR}`);
  Deno.env.set("DEAD_TARGET_MEMORY_DISABLED", "true");
  try {
    assert(describeDeadTargetMemory().detail.startsWith("disabled"));
  } finally {
    Deno.env.delete("DEAD_TARGET_MEMORY_DISABLED");
  }
});
