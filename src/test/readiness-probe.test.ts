import { describe, expect, it } from "vitest";
import { interpretReadinessProbe } from "@/lib/readiness-probe";

describe("interpretReadinessProbe", () => {
  it("200 + ok:true → let the scan through", () => {
    expect(interpretReadinessProbe(200, { ok: true })).toEqual({ block: false });
  });

  it("503 + orchestrator failing → surfaces the orchestrator detail", () => {
    const decision = interpretReadinessProbe(503, {
      ok: false,
      checks: { orchestrator: { ok: false, detail: "MINIMAX_API_KEY not set" } },
    });
    expect(decision).toEqual({ block: true, message: "Scan backend is not ready: MINIMAX_API_KEY not set" });
  });

  it("503 + only core failing (e.g. missing anon key) → surfaces the core detail, not a generic message", () => {
    const decision = interpretReadinessProbe(503, {
      ok: false,
      checks: {
        orchestrator: { ok: true },
        core: { ok: false, detail: "SUPABASE_ANON_KEY is not set in the edge function secrets." },
      },
    });
    expect(decision).toEqual({
      block: true,
      message: "Scan backend is not ready: SUPABASE_ANON_KEY is not set in the edge function secrets.",
    });
  });

  it("both orchestrator and core failing → orchestrator takes precedence", () => {
    const decision = interpretReadinessProbe(503, {
      ok: false,
      checks: {
        orchestrator: { ok: false, detail: "orchestrator missing" },
        core: { ok: false, detail: "core missing" },
      },
    });
    expect(decision).toEqual({ block: true, message: "Scan backend is not ready: orchestrator missing" });
  });

  it("ok:false with no detail on either check → generic fallback message", () => {
    const decision = interpretReadinessProbe(503, { ok: false, checks: {} });
    expect(decision).toEqual({ block: true, message: "Scan backend is not ready (required secret missing)." });
  });

  it("503 with an unparseable body → blocks with the generic message (status alone is a definitive signal)", () => {
    expect(interpretReadinessProbe(503, null)).toEqual({
      block: true,
      message: "Scan backend is not ready (required secret missing).",
    });
  });

  it("200 with an unparseable/unknown-shape body → lets the scan through (unchanged prior behavior)", () => {
    expect(interpretReadinessProbe(200, null)).toEqual({ block: false });
  });
});
