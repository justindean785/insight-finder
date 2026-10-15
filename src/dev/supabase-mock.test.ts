import { describe, expect, it } from "vitest";
import { supabase } from "./supabase-mock";

describe("synthetic case isolation", () => {
  it("keeps the never-started case free of populated-case evidence", async () => {
    const draft = "22222222-3333-4444-8555-666666666666";
    const populated = "11111111-2222-4333-8444-555555555555";
    const empty = await supabase.from("evidence_log").select("id", { count: "exact", head: true }).eq("thread_id", draft);
    const existing = await supabase.from("evidence_log").select("id", { count: "exact", head: true }).eq("thread_id", populated);
    const verdict = await supabase.rpc("verify_evidence_chain", { _thread_id: draft });
    expect(empty.count).toBe(0);
    expect(existing.count).toBeGreaterThan(0);
    expect(verdict.data).toEqual([{ ok: true, total: 0, first_break: null }]);
  });
});
