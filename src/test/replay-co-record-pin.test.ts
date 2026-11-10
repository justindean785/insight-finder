/**
 * replay-co-record-pin.test.ts — keeps the replay harness's copy of the co-record
 * linking fields identical to the frontend's.
 *
 * The L1 replay harness (supabase/tests/osint-agent/replay/) runs in Deno, which
 * cannot import `@/lib`, so `CO_RECORD_FIELDS` and the dump guard are DUPLICATED into
 * replay/co-record-fields.ts — the same duplicate-and-pin seam
 * evidence-record-ladder-pin.test.ts uses. A harness that scored attribution rules
 * against a stale field list would measure the wrong thing silently.
 *
 * Test-only: nothing here ships in the app bundle.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CO_RECORD_FIELDS } from "@/lib/intel";
import {
  CO_RECORD_FIELDS as REPLAY_FIELDS,
  CO_RECORD_MAX_TARGETS_PER_CLASS as REPLAY_MAX,
} from "../../supabase/tests/osint-agent/replay/co-record-fields";

const REPLAY_MODULE = resolve(process.cwd(), "supabase/tests/osint-agent/replay/co-record-fields.ts");
const INTEL = resolve(process.cwd(), "src/lib/intel.ts");

describe("the replay harness's co-record field list", () => {
  it("stays import-free so vitest can load it", () => {
    const imports = readFileSync(REPLAY_MODULE, "utf8")
      .split("\n")
      .filter((line) => /^\s*(import\s|export\s+[*{].*\sfrom\s|const\s+\w+\s*=\s*require\()/.test(line));
    expect(imports).toEqual([]);
  });

  it("mirrors CO_RECORD_FIELDS in src/lib/intel.ts exactly", () => {
    expect(REPLAY_FIELDS).toEqual(CO_RECORD_FIELDS);
  });

  it("mirrors the dump guard (max distinct targets per class)", () => {
    // Not exported from intel.ts, so read the declaration itself.
    const m = readFileSync(INTEL, "utf8").match(/const CO_RECORD_MAX_TARGETS_PER_CLASS\s*=\s*(\d+)\s*;/);
    expect(m).not.toBeNull();
    expect(REPLAY_MAX).toBe(Number(m![1]));
  });

  it("never lists a shared-by-construction field", () => {
    for (const field of Object.keys(REPLAY_FIELDS)) {
      expect(field).not.toMatch(/^(?:.*password.*|ip|ip_.*|.*_ip|.*address.*|dob.*|.*birth.*|device.*|name_in_breach|breach_name.*)$/i);
    }
  });
});
