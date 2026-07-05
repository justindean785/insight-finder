import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { playbookFor } from "./playbooks.ts";
import {
  enforceNameSeedPriority,
  enforceFallbackToolPolicy,
  NAME_SEED_PLANNER_RULES,
  dorkHarvestPrerequisitesMet,
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

Deno.test("unknown/unclassified seed still labels guessed handles [VERIFY] (conservative, never blocks)", () => {
  const plan = enforceNameSeedPriority({
    proposed_calls: [
      { tool_name: "username_sweep", selector: "domrovai", expected_value: 92, reason: "candidate" },
      { tool_name: "exa_search", selector: "Dom Rovai", expected_value: 70, reason: "name" },
    ],
  }, {
    seedType: "unknown", // misclassified person seed
    alreadyQueried: [],
  });

  const proposed = plan.proposed_calls as Array<Record<string, unknown>>;
  // name-first ordering + [VERIFY] labeling applied even though the seed wasn't
  // classified name/person — the guessed handle is never silently promoted.
  assertEquals(proposed.map((call) => call.tool_name), ["exa_search", "username_sweep"]);
  assertEquals(proposed[1]?.expected_value, 45);
  assertStringIncludes(String(proposed[1]?.reason), "[VERIFY]");
});

Deno.test("malformed (non-object) planner calls are preserved, not silently dropped", () => {
  const plan = enforceNameSeedPriority({
    proposed_calls: [
      "not-an-object",
      null,
      { tool_name: "username_sweep", selector: "domrovai", expected_value: 90, reason: "candidate" },
      { tool_name: "exa_search", selector: "Dom Rovai", expected_value: 70, reason: "name" },
    ],
  }, {
    seedType: "person",
    alreadyQueried: [],
  });

  const proposed = plan.proposed_calls as Array<unknown>;
  assertEquals(proposed.length, 4); // every entry survives — none dropped
  assertEquals(proposed.includes("not-an-object"), true);
  assertEquals(proposed.includes(null), true);
});

Deno.test("known non-name seeds (e.g. email) are returned unchanged", () => {
  const input = {
    proposed_calls: [
      { tool_name: "username_sweep", selector: "x", expected_value: 90, reason: "r" },
      { tool_name: "exa_search", selector: "y", expected_value: 70, reason: "r" },
    ],
  };
  const plan = enforceNameSeedPriority(input, { seedType: "email", alreadyQueried: [] });
  // no name-first reordering or [VERIFY] labeling for non-name identifiers
  assertEquals(plan, input);
});

Deno.test("gemini_deep_dork is demoted until dork_harvest/google_dorks have run", () => {
  const plan = enforceFallbackToolPolicy({
    proposed_calls: [
      { tool_name: "gemini_deep_dork", selector: "x@y.com", expected_value: 80, reason: "deep dork" },
      { tool_name: "dork_harvest", selector: "x@y.com", expected_value: 70, reason: "harvest" },
    ],
  }, { alreadyQueried: [] });
  const proposed = plan.proposed_calls as Array<Record<string, unknown>>;
  assertEquals(proposed[0]?.expected_value, 35);
  assertStringIncludes(String(proposed[0]?.reason), "[FALLBACK");
});

Deno.test("gemini_deep_dork demotion lifts after dork_harvest runs", () => {
  const input = {
    proposed_calls: [
      { tool_name: "gemini_deep_dork", selector: "x@y.com", expected_value: 80, reason: "deep dork" },
    ],
  };
  const plan = enforceFallbackToolPolicy(input, { alreadyQueried: ["dork_harvest::email::x@y.com"] });
  assertEquals(plan, input);
});

Deno.test("dorkHarvestPrerequisitesMet detects google_dorks or dork_harvest", () => {
  assertEquals(dorkHarvestPrerequisitesMet([]), false);
  assertEquals(dorkHarvestPrerequisitesMet(["google_dorks::domain::example.com"]), true);
  assertEquals(dorkHarvestPrerequisitesMet(["dork_harvest::email::x@y.com"]), true);
});
