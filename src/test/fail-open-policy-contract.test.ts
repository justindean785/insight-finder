import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf-8");
}

const RUNTIME = read("supabase/functions/osint-agent/runtime-policy.ts");
const GUARD = read("supabase/functions/osint-agent/guard.ts");
const INDEX = read("supabase/functions/osint-agent/index.ts");
const WORKFLOW = read("supabase/functions/osint-agent/workflow_prompt.ts");
const CACHE = read("supabase/functions/osint-agent/cache.ts");
const META_TOOLS = read("supabase/functions/osint-agent/tools/meta.ts");
const EXTRACTED_TOOLS = [
  read("supabase/functions/osint-agent/tools/minimax.ts"),
  read("supabase/functions/osint-agent/tools/osint_navigator.ts"),
  read("supabase/functions/osint-agent/tools/breach.ts"),
].join("\n");
const SYSTEM_PROMPT_SRC = read("supabase/functions/osint-agent/system-prompt.ts");
const CONFIDENCE = read("supabase/functions/osint-agent/confidence.ts");
const BREACH = read("supabase/functions/osint-agent/tools/breach.ts");

describe("fail-open investigation policy", () => {
  it("does not hard-block on planner, expected-value, weak-lead, or triage baselines", () => {
    expect(RUNTIME).not.toMatch(/execution plan required/i);
    expect(RUNTIME).not.toMatch(/expected value \$\{input\.expectedValue\} below/i);
    expect(RUNTIME).not.toMatch(/weak lead blocked/i);
    expect(GUARD).not.toMatch(/gated by triage_seed/i);
    expect(INDEX).not.toMatch(/need >=3 new artifacts/i);
    expect(INDEX).not.toMatch(/need ≥5/i);
    expect(INDEX).not.toMatch(/Stage-2 tools that did NOT clear the gate/i);
    expect(INDEX).not.toMatch(/MANDATORY first step for email or username seeds/i);
    expect(META_TOOLS).not.toMatch(/Stage-2 tools that did NOT clear the gate/i);
    expect(META_TOOLS).not.toMatch(/MANDATORY first step for email or username seeds/i);
    expect(EXTRACTED_TOOLS).not.toMatch(/need >=3 new artifacts/i);
    expect(EXTRACTED_TOOLS).not.toMatch(/need ≥5/i);
  });

  it("documents planner, playbook, and audit helpers as advisory", () => {
    expect(WORKFLOW).toMatch(/ADVISORY WORKFLOW/);
    expect(WORKFLOW).toMatch(/None is required for progress/);
    expect(WORKFLOW).not.toMatch(/WORKFLOW GATE/);
    expect(WORKFLOW).not.toMatch(/run every REQUIRED tool/);
  });
});

describe("cache isolation and confidence contracts", () => {
  it("keeps persistent cache lookup and writes scoped to the authenticated user", () => {
    expect(CACHE).toMatch(/\.eq\("user_id", ctx\.userId\)/);
    expect(CACHE).toMatch(/user_id:\s*ctx\.userId/);
    expect(CACHE).toMatch(/onConflict:\s*"user_id,tool_name,input_hash"/);
  });

  it("keeps transparent cache reuse ineligible for corroboration", () => {
    expect(CACHE).toMatch(/corroboration_eligible:\s*false/);
    expect(CACHE).toMatch(/logUsage\(true, true/);
  });
});

describe("confirmation status is reporting-only, never an execution gate", () => {
  it("the prompt states execution is never gated by confirmation status", () => {
    expect(SYSTEM_PROMPT_SRC).toMatch(/EXECUTION IS NEVER GATED BY CONFIRMATION STATUS/);
    expect(SYSTEM_PROMPT_SRC).toMatch(/reason_not_confirmed/);
    expect(SYSTEM_PROMPT_SRC).toMatch(/Not yet corroborated.*is a label, not a stop sign/);
  });

  it("the prompt no longer phrases corroboration as a precondition to run scans", () => {
    expect(SYSTEM_PROMPT_SRC).not.toMatch(/Do NOT auto-expand weak leads/i);
    expect(SYSTEM_PROMPT_SRC).not.toMatch(/use `socialfetch_lookup` for corroborated handles/i);
    expect(SYSTEM_PROMPT_SRC).not.toMatch(/not single-source weak handles/i);
  });

  it("the runtime gate (startCall) does not consult any confirmation/source label", () => {
    // startCall is the ONLY place the runtime refuses a call. It must not branch
    // on confirmation status, source category, or the confidence cap.
    for (const term of ["reason_not_confirmed", "confidence_cap", "source_category", "confirmed_owner"]) {
      expect(RUNTIME).not.toContain(term);
    }
  });

  it("breach tools have no confirmation/source precondition in their execute path", () => {
    expect(BREACH).not.toMatch(/reason_not_confirmed/);
    expect(BREACH).not.toMatch(/source_category/);
    expect(BREACH).not.toMatch(/needs second independent/i);
    // no early-return skip keyed on confirmation/weakness
    expect(BREACH).not.toMatch(/if\s*\([^)]*confirmed[^)]*\)\s*return/i);
  });

  it("still caps confidence and labels uncorroborated results (report grounding preserved)", () => {
    // The label exists and the cap clamps rawConfidence — labeling/grounding stays.
    expect(CONFIDENCE).toMatch(/needs second independent class of evidence/);
    expect(CONFIDENCE).toMatch(/Math\.min\(input\.rawConfidence/);
    // identity over-claim guards remain
    expect(CONFIDENCE).toMatch(/BIO_CROSS_LINK_NAME_CAP/);
  });
});
