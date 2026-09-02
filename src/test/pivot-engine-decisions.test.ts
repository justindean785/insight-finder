/**
 * pivot-engine-decisions.test.ts — analyst decisions reach `computePivots`.
 *
 * BEFORE: `computePivots` took no review input at all. A selector the analyst
 * had marked False stayed a one-click "Run this pivot" card; a Key mark changed
 * nothing about the order; a Recheck was only a chat message. The engine read
 * `metadata.false_positive` and nothing else.
 *
 * THE CONTRACT pinned here:
 *   - rejected (dismissed / wrong / legacy false_positive) → never a pivot, by
 *     artifact id AND by `type:normalizedValue`, from BOTH origins;
 *   - key → outranks every comparable ordinary pivot; confidence UNTOUCHED;
 *   - recheck → a verification task card with the scoped re-verify prompt;
 *   - confirmed-but-quarantined → still blocked (confirmation is not linkage).
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots } from "@/lib/pivot-engine";
import type { RecommendedPivot } from "@/lib/recommended-pivots";

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `d${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 70,
    source: partial.source ?? "tool",
    created_at: partial.created_at ?? `2026-03-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? {},
  };
}

function reportPivot(value: string, type: RecommendedPivot["type"]): RecommendedPivot {
  return {
    label: `Investigate ${value}`, actionLabel: "Review lead", detail: value, reason: "report",
    priority: "medium", prompt: `Run pivot on ${value}`, value, type,
  };
}

const NONE = new Set<string>();
const run = (artifacts: Artifact[], reviews?: Record<string, string>, reportPivots: RecommendedPivot[] = []) =>
  computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE, reviews });

describe("computePivots — rejected selectors disappear", () => {
  it("FAILURE-FIRST: without reviews the rejected selector is still offered (the old bug)", () => {
    const a = art({ id: "bad", kind: "email", value: "wrong@example.com" });
    expect(run([a]).some((p) => p.value === "wrong@example.com")).toBe(true);
  });

  it("a dismissed artifact is removed by id", () => {
    const a = art({ id: "bad", kind: "email", value: "wrong@example.com" });
    const good = art({ kind: "email", value: "good@example.com" });
    const out = run([a, good], { bad: "dismissed" });
    expect(out.some((p) => p.value === "wrong@example.com")).toBe(false);
    expect(out.some((p) => p.value === "good@example.com")).toBe(true);
  });

  it("⛔ a NEW artifact id carrying the same normalized selector is still gone (kind:value)", () => {
    const rejected = art({ id: "bad", kind: "email", value: "Wrong@Example.com" });
    const revived = art({ id: "bad-again", kind: "email", value: "wrong@example.com" });
    const out = run([rejected, revived], { bad: "wrong" });
    expect(out.some((p) => p.value.toLowerCase() === "wrong@example.com")).toBe(false);
  });

  it("a report-recommended pivot for a rejected selector is removed too (both origins)", () => {
    const rejected = art({ id: "bad", kind: "username", value: "ghost_handle" });
    const out = run([rejected], { bad: "dismissed" }, [reportPivot("ghost_handle", "username")]);
    expect(out.some((p) => p.value === "ghost_handle")).toBe(false);
  });

  it("legacy metadata.false_positive reads as the same rejection", () => {
    const a = art({ kind: "email", value: "legacy@example.com", metadata: { false_positive: true } });
    expect(run([a], {}).some((p) => p.value === "legacy@example.com")).toBe(false);
  });

  it("type-keyed: rejecting a USERNAME does not remove a NAME of the same text", () => {
    const handle = art({ id: "h", kind: "username", value: "jordan.vale" });
    const name = art({ id: "n", kind: "name", value: "Jordan Vale" });
    const out = run([handle, name], { h: "dismissed" });
    expect(out.some((p) => p.type === "username")).toBe(false);
    expect(out.some((p) => p.type === "name" && p.value === "Jordan Vale")).toBe(true);
  });

  it("a rejection outranks a Key mark on a duplicate row of the same selector", () => {
    const a = art({ id: "one", kind: "email", value: "dup@example.com" });
    const b = art({ id: "two", kind: "email", value: "dup@example.com" });
    const out = run([a, b], { one: "dismissed", two: "key" });
    expect(out.some((p) => p.value === "dup@example.com")).toBe(false);
  });
});

describe("computePivots — Key changes ORDER, not confidence", () => {
  it("FAILURE-FIRST: without the Key mark the lower-confidence lead sorts last", () => {
    const strong = art({ id: "s", kind: "email", value: "strong@example.com", confidence: 95 });
    const weak = art({ id: "w", kind: "email", value: "weak@example.com", confidence: 40 });
    const out = run([strong, weak]);
    expect(out[0].value).toBe("strong@example.com");
  });

  it("a Key mark lifts the lead to the top", () => {
    const strong = art({ id: "s", kind: "email", value: "strong@example.com", confidence: 95 });
    const weak = art({ id: "w", kind: "email", value: "weak@example.com", confidence: 40 });
    const out = run([strong, weak], { w: "key" });
    expect(out[0].value).toBe("weak@example.com");
    expect(out[0].decision).toBe("key");
    expect(out[0].priority).toBe("high");
  });

  it("⛔ …and leaves the evidence confidence exactly as recorded", () => {
    const weak = art({ id: "w", kind: "email", value: "weak@example.com", confidence: 40 });
    const plain = run([weak]).find((p) => p.value === "weak@example.com")!;
    const keyed = run([weak], { w: "key" }).find((p) => p.value === "weak@example.com")!;
    expect(keyed.confidence).toBe(plain.confidence);
    expect(keyed.confidence).toBe(40);
  });

  it("a Key lead that was already searched still ranks below an unsearched ordinary lead", () => {
    const searchedKey = art({ id: "k", kind: "email", value: "done@example.com", confidence: 90 });
    const fresh = art({ id: "f", kind: "email", value: "fresh@example.com", confidence: 40 });
    const out = computePivots({
      artifacts: [searchedKey, fresh], seedValue: null, reportPivots: [], skipSet: NONE,
      queriedSet: new Set(["done example com"]), reviews: { k: "key" },
    });
    expect(out[0].value).toBe("fresh@example.com");
    expect(out.find((p) => p.value === "done@example.com")?.status).toBe("searched");
  });
});

describe("computePivots — Recheck becomes a verification task", () => {
  it("renders as a re-verify card with the scoped recheck prompt, even if already searched", () => {
    const a = art({ id: "r", kind: "phone", value: "+1 555 123 4567", confidence: 55 });
    const out = computePivots({
      artifacts: [a], seedValue: null, reportPivots: [], skipSet: NONE,
      queriedSet: new Set(["1 555 123 4567"]), reviews: { r: "recheck" },
    });
    const task = out.find((p) => p.value === "+1 555 123 4567");
    expect(task?.decision).toBe("recheck");
    expect(task?.status).toBe("new");
    expect(task?.actionLabel).toBe("Re-verify finding");
    expect(task?.prompt).toMatch(/Re-verify this specific finding/);
    expect(task?.prompt).toContain("+1 555 123 4567");
    expect(task?.confidence).toBe(55);
  });
});

describe("computePivots — confirmation never releases quarantine", () => {
  it("⛔ a confirmed-but-quarantined selector stays blocked", () => {
    const q = art({
      id: "q", kind: "username", value: "stranger_handle",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
    });
    const out = run([q], { q: "confirmed" });
    expect(out.some((p) => p.value === "stranger_handle")).toBe(false);
  });

  it("only an explicit linkage_confirmed releases it (and the confirmation is then carried)", () => {
    const q = art({
      id: "q", kind: "username", value: "stranger_handle",
      metadata: { subject_unlinked: true, linkage_confirmed: true },
    });
    const out = run([q], { q: "confirmed" });
    const p = out.find((x) => x.value === "stranger_handle");
    expect(p).toBeDefined();
    expect(p?.decision).toBe("confirmed");
  });
});
