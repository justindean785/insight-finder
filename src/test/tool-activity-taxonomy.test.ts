import { describe, it, expect } from "vitest";
import { classifyActivityRow } from "@/hooks/useThreadToolActivity";

/**
 * Activity and Health ran two different classifiers over the same tool_usage_log
 * rows, so one call read FAILED in the Activity feed and Degraded/Denied in the
 * Health panel beside it. Observed in production on thread "goran kvothe":
 * Activity reported "Failed 5" while Health reported "Needs attention 0".
 *
 * Cause: `classifyActivityRow` consulted GATED_RE/DEGRADED_RE only when the
 * outcome was exactly "skipped". Everything else fell through to `failed`,
 * including rows whose own text says they are not provider faults.
 *
 * The strings below are verbatim from production.
 */
describe("classifyActivityRow — Activity/Health taxonomy parity", () => {
  const c = (err: string, outcome = "failed") => classifyActivityRow(outcome, false, err).status;

  it("treats our own paid-call cap as degraded, not failed", () => {
    expect(c("internal paid-call cap reached (12 this run) — internal throttle, not a provider limit")).toBe("degraded");
  });

  it("treats the per-investigation run cap as degraded, not failed", () => {
    expect(c("internal run cap reached (30 calls this investigation) — internal throttle, not a provider limit")).toBe("degraded");
  });

  it("treats an upstream refusal as degraded (Health calls this Denied)", () => {
    expect(c("reddit request failed (403)")).toBe("degraded");
  });

  it("treats rate limiting and timeouts as degraded", () => {
    expect(c("429 Too Many Requests")).toBe("degraded");
    expect(c("timeout after 15000ms")).toBe("degraded");
    expect(c("request timed out")).toBe("degraded");
  });

  it("still classifies a missing key as gated", () => {
    expect(c("SERUS_API_KEY not configured")).toBe("gated");
    expect(c("provider disabled")).toBe("gated");
  });

  it("still reports a genuine provider fault as failed", () => {
    // No throttle/denial/timeout marker — this is what "Needs attention" is for.
    expect(c("Internal Server Error (500)")).toBe("failed");
    expect(c("unexpected token < in JSON at position 0")).toBe("failed");
    expect(c("")).toBe("failed");
  });

  it("leaves successful and empty outcomes untouched", () => {
    expect(classifyActivityRow("ok", true, null).status).toBe("succeeded");
    expect(classifyActivityRow("empty", true, null).status).toBe("succeeded");
  });

  it("keeps a bare skipped row skipped when nothing else matches", () => {
    expect(classifyActivityRow("skipped", false, "deduplicated no-op").status).toBe("skipped");
  });

  it("reproduces the production run: 5 'failures' resolve to 0 genuine faults", () => {
    // The five rows Activity labelled FAILED on thread "goran kvothe".
    const rows = [
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
      "internal run cap reached (30 calls this investigation) — internal throttle, not a provider limit",
      "reddit request failed (403)",
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
    ];
    const statuses = rows.map((r) => c(r));
    expect(statuses.filter((s) => s === "failed")).toHaveLength(0);
    expect(statuses.every((s) => s === "degraded")).toBe(true);
  });
});
