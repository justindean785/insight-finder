// pivot-grounding.test.tsx — action prose must never become a runnable selector.
//
// Measured 2026-10-24: "Link username to real name" produced username `to` and
// "Username sweep" produced `sweep`, both with a Run control. A shape check
// cannot tell those from a handle, so the extractor now says whether a bare
// token was MARKED as a handle, and computePivots confirms unmarked ones against
// the case's own selectors. These tests drive the real pipeline, extractor →
// engine → schema → NextSteps, with offline fixtures.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { computePivots } from "@/lib/pivot-engine";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";
import { pivotEligibility, pivotSuggestionInput, validatePivotSuggestion } from "@/lib/pivot-schema";
import type { Artifact } from "@/hooks/useThreadArtifacts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

const report = (...lines: string[]) => `## Recommended Next Pivots\n${lines.map((l) => `- ${l}`).join("\n")}`;
const art = (o: Partial<Artifact>): Artifact => ({
  id: "a1", kind: "username", value: "x", confidence: 60, source: "t",
  created_at: "2026-06-01T00:00:00Z", metadata: null, ...o,
});

/** Same steps ChatWindow takes: rank, validate, attach eligibility. */
function itemsFor(text: string, artifacts: Artifact[] = [], queried: string[] = []): NextStepItem[] {
  const ranked = computePivots({
    artifacts, seedValue: "seed@example.com", reportPivots: extractRecommendedPivots(text),
    skipSet: new Set(), queriedSet: new Set(queried),
  });
  return ranked.filter((p) => p.status === "new").map((p, i) => {
    const validation = validatePivotSuggestion(pivotSuggestionInput(p));
    return {
      kind: "pivot" as const, key: `k${i}`, validation,
      eligibility: validation.status === "valid"
        ? pivotEligibility(validation.pivot, { artifactsById: new Map(), review: () => "new" })
        : null,
    };
  });
}

const verdicts = (text: string, artifacts?: Artifact[], queried?: string[]) =>
  itemsFor(text, artifacts, queried).map((i) => (i.kind === "pivot" ? i.validation.status : "action"));

describe("extractor marks what it could not ground", () => {
  it.each([
    ["Link username to real name — Search public profiles for corroboration", "to"],
    ["Username sweep — Search the distinctive handles on public platforms", "sweep"],
  ])("%s → candidate %s is ungrounded", (line, candidate) => {
    const [p] = extractRecommendedPivots(report(line));
    expect(p.value).toBe(candidate);
    expect(p.ungrounded).toBe(true);
  });

  it.each([
    ["Corroborate username jd_case_77 across platforms — x", "jd_case_77"],
    ["Corroborate username `jd` across platforms — x", "jd"],
    ["Corroborate username “调查员” across platforms — x", "调查员"],
    ["Corroborate username: jordan — x", "jordan"],
    ["Corroborate @jd — x", "@jd"],
    ["Corroborate username @ab — x", "@ab"],
    ["Corroborate handle sam.cole — x", "sam.cole"],
  ])("%s keeps %s, grounded", (line, value) => {
    const [p] = extractRecommendedPivots(report(line));
    expect(p.value).toBe(value);
    expect(p.ungrounded).toBeUndefined();
  });
});

describe("computePivots + schema: an unmarked token needs the case to know it", () => {
  const sweep = "Username sweep — Search the distinctive handles on public platforms";
  const link = "Link username to real name — Search public profiles for corroboration";

  it("`to` and `sweep` validate as invalid with a choose-a-target reason", () => {
    for (const line of [sweep, link]) {
      const [item] = itemsFor(report(line));
      expect(item.kind === "pivot" && item.validation.status).toBe("invalid");
      if (item.kind === "pivot" && item.validation.status === "invalid") {
        expect(item.validation.problems.join(" ")).toMatch(/choose a target/);
      }
    }
  });

  it("an explicit handle is valid with no case knowledge", () => {
    expect(verdicts(report("Corroborate username jd_case_77 across platforms — Check public profiles"))).toEqual(["valid"]);
  });

  it("a short handle the case does NOT know, unmarked, is not runnable; marked, it is", () => {
    expect(verdicts(report("Corroborate username jd across platforms — Check public profiles"))).toEqual(["invalid"]);
    expect(verdicts(report("Corroborate username `jd` across platforms — Check public profiles"))).toEqual(["valid"]);
  });

  it("an unmarked token the case already holds is accepted on the case's evidence, not a word list", () => {
    // `to` is a legitimate handle if (and only if) the case contains it.
    const held = [art({ id: "u", kind: "username", value: "to" })];
    const status = computePivots({
      artifacts: held, seedValue: "seed@example.com", reportPivots: extractRecommendedPivots(report(link)),
      skipSet: new Set(), queriedSet: new Set(),
    }).find((p) => p.value === "to");
    expect(status?.unconfirmedTarget).toBeUndefined();
  });
});

describe("a handle recorded in another artifact's metadata grounds an unmarked report handle (Codex P2 on #866)", () => {
  it("email row with metadata.handle makes `username jordan` runnable", () => {
    const held = [art({ id: "m", kind: "email", value: "jordan@example.com", metadata: { handle: "jordan" } })];
    const line = report("Corroborate username jordan across platforms — Check public profiles");
    const verdictFor = (artifacts?: Artifact[]) => {
      const it = itemsFor(line, artifacts).find((i) => i.kind === "pivot" && i.validation.status === "valid" ? i.validation.pivot.target === "jordan" : i.kind === "pivot" && i.validation.status === "invalid" && i.validation.target === "jordan");
      return it && it.kind === "pivot" ? it.validation.status : "missing";
    };
    expect(verdictFor(held)).toBe("valid");
    expect(verdictFor()).toBe("invalid");
  });
});

describe("rendered controls and dispatch boundary", () => {
  it("a malformed pivot renders no Run/Preview control and cannot dispatch", () => {
    const onRunPivot = vi.fn();
    const onRunAction = vi.fn();
    render(<NextSteps
      items={itemsFor(report("Link username to real name — Search public profiles for corroboration", "Username sweep — Search the distinctive handles on public platforms"))}
      onRunPivot={onRunPivot}
      onRunAction={onRunAction}
    />);
    expect(screen.queryByRole("button", { name: /^(Run|Preview|Review and run)/ })).toBeNull();
    const disclosure = screen.getByRole("button", { name: /suggestions from the report couldn't be turned into runnable steps/ });
    fireEvent.click(disclosure); // expanding is free of dispatch
    expect(screen.getAllByText(/choose a target/).length).toBe(2);
    expect(screen.queryByRole("button", { name: /^(Run|Preview|Review and run|Start)/ })).toBeNull();
    expect(onRunPivot).not.toHaveBeenCalled();
    expect(onRunAction).not.toHaveBeenCalled();
  });

  it("a real handle renders Preview, previewing never dispatches, Start dispatches once", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps
      items={itemsFor(report("Corroborate username jd_case_77 across platforms — Check public profiles"))}
      onRunPivot={onRunPivot}
      onRunAction={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: /^Preview .* on jd_case_77$/ }));
    expect(onRunPivot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start this pivot" }));
    expect(onRunPivot).toHaveBeenCalledTimes(1);
    expect(onRunPivot.mock.calls[0][0].target).toBe("jd_case_77");
  });
});
