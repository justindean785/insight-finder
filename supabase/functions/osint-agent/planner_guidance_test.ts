import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { playbookFor } from "./playbooks.ts";
import {
  enforceNameSeedPriority,
  NAME_SEED_PLANNER_RULES,
} from "./planner-guidance.ts";

Deno.test("person seeds use the name playbook", () => {
  assertEquals(playbookFor("person"), playbookFor("name"));
});

Deno.test("name-seed planner ranks real-name search before guessed-handle sweeps", () => {
  const plan = enforceNameSeedPriority({
    stage: "REVIEW",
    goal: "Investigate Dom Rovai",
    current_findings: [],
    proposed_calls: [
      {
        tool_name: "username_search",
        selector: "domrovai",
        selector_type: "username",
        expected_value: 85,
        cost_tier: "free",
        reason: "Derived likely handle",
      },
      {
        tool_name: "minimax_web_search",
        selector: "Dom Rovai",
        selector_type: "name",
        expected_value: 75,
        cost_tier: "low",
        reason: "Search the real name",
      },
    ],
    calls_rejected: [],
  }, {
    seedType: "person",
    alreadyQueried: [],
  });

  const proposed = plan.proposed_calls as Array<Record<string, unknown>>;
  assertEquals(proposed.map((call) => call.tool_name), ["minimax_web_search", "username_search"]);
  assertEquals(proposed[1]?.expected_value, 45);
  assertStringIncludes(String(proposed[1]?.reason), "[VERIFY]");
});

Deno.test("name-seed planner keeps later username sweeps secondary and VERIFY-only", () => {
  const plan = enforceNameSeedPriority({
    proposed_calls: [
      {
        tool_name: "username_sweep",
        selector: "domrovai",
        selector_type: "username",
        expected_value: 92,
        cost_tier: "free",
        reason: "Check candidate handle",
      },
      {
        tool_name: "exa_search",
        selector: "Dom Rovai",
        selector_type: "name",
        expected_value: 70,
        cost_tier: "low",
        reason: "Resolve candidate identities",
      },
    ],
    calls_rejected: [],
  }, {
    seedType: "name",
    alreadyQueried: ["minimax_web_search::name::Dom Rovai"],
  });

  const proposed = plan.proposed_calls as Array<Record<string, unknown>>;
  assertEquals(proposed.map((call) => call.tool_name), ["exa_search", "username_sweep"]);
  assertEquals(proposed[1]?.expected_value, 55);
  assertStringIncludes(String(proposed[1]?.reason), "[VERIFY]");
});

Deno.test("name-seed planner also handles the extracted pivots response shape", () => {
  const plan = enforceNameSeedPriority({
    pivots: [
      {
        tool: "username_sweep",
        args: { username: "domrovai" },
        priority: 1,
        reason: "Check candidate handle",
      },
      {
        tool: "minimax_web_search",
        args: { query: "Dom Rovai" },
        priority: 3,
        reason: "Search the real name",
      },
    ],
  }, {
    seedType: "person",
    alreadyQueried: [],
  });

  const pivots = plan.pivots as Array<Record<string, unknown>>;
  assertEquals(pivots.map((call) => call.tool), ["minimax_web_search", "username_sweep"]);
  assertEquals(pivots[1]?.priority, 8);
  assertStringIncludes(String(pivots[1]?.reason), "[VERIFY]");
});

Deno.test("planner guidance explicitly forbids username-first name investigations", () => {
  assertStringIncludes(NAME_SEED_PLANNER_RULES, "NAME/PERSON");
  assertStringIncludes(NAME_SEED_PLANNER_RULES, "rank username_sweep or username_search below");
  assertStringIncludes(NAME_SEED_PLANNER_RULES, "[VERIFY]");
});
