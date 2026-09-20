// lib/dead_target_test.ts — the pure half of the dead-target memory.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDeadTargets, deadTargetCount, deadTargetRefusal, describeDeadTargetMemory,
  isDeadTarget, DEAD_TARGET_FLOOR, DEAD_TARGET_REFUSAL_ERROR,
} from "./dead-target.ts";
import { classifyToolOutcome } from "../tool-outcome.ts";

const normalize = (s: string) => s.trim().toLowerCase();
const selOf = (i: Record<string, unknown>) => normalize(String(i.url ?? i.username ?? i.email ?? i.value ?? ""));

const YT = "https://youtube.com/@lildee808_first";

Deno.test("counts FAILED rows per tool+selector, reading both input_json shapes", () => {
  const map = buildDeadTargets([
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: YT } },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { input: { url: YT.toUpperCase() } } },
    { tool_name: "socialfetch_web_read", outcome: "ok", input_json: { url: YT } },
    { tool_name: "socialfetch_web_read", outcome: "skipped", input_json: { url: YT } },
    { tool_name: "jina_reader_scrape", outcome: "failed", input_json: { url: YT } },
    { tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: "https://youtube.com/@other" } },
  ], selOf);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", normalize(YT)), 2);
  assertEquals(deadTargetCount(map, "jina_reader_scrape", normalize(YT)), 1);
  assertEquals(deadTargetCount(map, "socialfetch_web_read", "https://youtube.com/@other"), 1);
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
