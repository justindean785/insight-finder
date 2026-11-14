// case-sheet-handoffs.test.tsx — every figure on the sheet leads somewhere.
//
// Production, 2026-10-26: the subject read "Needs review" and the bar read
// "Review 28", and neither could be clicked; right under them "Needs your call 0"
// read as a contradiction. The sheet stays read-only (no verdict is written
// here). Since 2026-11-10 the bar is the agent's assessment, not the authority
// tally, so its handoff is Evidence sorted by linkage.
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { tallyAuthority } from "@/lib/authority";
import { buildCaseSheet } from "@/lib/case-sheet";
import { assessArtifacts } from "@/lib/agent-assessment";
import { buildAssessmentSheet } from "@/lib/assessment-sheet";
import { CaseSheetView } from "@/components/workspace/CaseSheet";
import { STATUS_FILTER_GROUPS, type EvidenceStatusFilter } from "@/components/ResourcesPanel";
import { statusFilterForAuthority as pick } from "@/lib/evidence-status-filter";

const statusFilterForAuthority = (state: string): EvidenceStatusFilter => pick(state, STATUS_FILTER_GROUPS, "all");

afterEach(cleanup);

let n = 0;
function art(kind: string, value: string, metadata: Record<string, unknown> = {}, confidence = 60): Artifact {
  n += 1;
  return { id: `h${n}`, kind, value, confidence, source: "fixture", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, metadata };
}
const model = (items: Artifact[], seed?: string) => buildCaseSheet(items, {}, tallyAuthority(items, () => "new"), seed);

function navigations(run: () => void): unknown[] {
  const seen: unknown[] = [];
  const onNav = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener("swarmbot:navigate", onNav);
  try { run(); } finally { window.removeEventListener("swarmbot:navigate", onNav); }
  return seen;
}

describe("case sheet handoffs", () => {
  it("the assessment section opens Evidence, which sorts by linkage by default", () => {
    const items = [art("email", "a@example.test"), art("email", "b@example.test")];
    render(<CaseSheetView model={model(items)} hydrated assessment={buildAssessmentSheet(assessArtifacts(items, "a@example.test"), items)} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    const seen = navigations(() => fireEvent.click(within(region).getByRole("button", { name: /Open Evidence/ })));
    expect(seen).toEqual([{ tab: "artifacts", artifactId: undefined }]);
  });

  it("the subject's chip opens the subject row", () => {
    const name = art("name", "Alex Example", { source_class: ["registry", "social"] }, 80);
    // The seed names him: a name nothing ties to the seed is not the subject.
    const m = model([name, art("email", "alex@example.test")], "Alex Example");
    render(<CaseSheetView model={m} hydrated />);
    const subject = screen.getByRole("region", { name: "Subject" });
    const seen = navigations(() => fireEvent.click(within(subject).getByRole("button", { name: /in Evidence/ })));
    expect(seen).toEqual([{ tab: "artifacts", artifactId: m.subject!.artifact.id }]);
  });

  it("an empty exception queue says so in one line and asks for nothing", () => {
    const m = model([art("email", "solo@example.test")]);
    expect(m.queueTotal).toBe(0);
    render(<CaseSheetView model={m} hydrated />);
    const queue = screen.getByRole("region", { name: "Optional exception review" });
    expect(queue.textContent).toContain("Nothing disputed or unattributed.");
    expect(within(queue).queryByRole("button")).toBeNull();
  });
});

describe("statusFilterForAuthority", () => {
  it("picks the narrowest board filter that holds the state", () => {
    expect(statusFilterForAuthority("review")).toBe("review");
    // Case desk R4: the Conflicts chip is the narrower home for a conflict row.
    expect(statusFilterForAuthority("conflict")).toBe("conflict");
    expect(statusFilterForAuthority("quarantined")).toBe("quarantined");
    expect(statusFilterForAuthority("weak")).toBe("weak");
    expect(statusFilterForAuthority("failed")).toBe("excluded");
    expect(statusFilterForAuthority("verified")).toBe("strong");
  });

  it("falls back to All for a state no group names", () => {
    expect(statusFilterForAuthority("not-a-state")).toBe("all");
  });

  it("the chosen filter always admits the state (no second mapping to drift)", () => {
    for (const state of ["verified", "infrastructure", "probable", "review", "conflict", "quarantined", "weak", "failed"]) {
      const group = STATUS_FILTER_GROUPS[statusFilterForAuthority(state)];
      expect(group === null || group.has(state), state).toBe(true);
    }
  });
});
