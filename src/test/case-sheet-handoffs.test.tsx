// case-sheet-handoffs.test.tsx — every figure on the sheet leads somewhere.
//
// Production, 2026-10-26: the subject read "Needs review" and the bar read
// "Review 28", and neither could be clicked; right under them "Needs your call 0"
// read as a contradiction. The sheet stays read-only (no verdict is written
// here), but each count now opens Evidence on the rows it counts.
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { tallyAuthority } from "@/lib/authority";
import { buildCaseSheet } from "@/lib/case-sheet";
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
const model = (items: Artifact[]) => buildCaseSheet(items, {}, tallyAuthority(items, () => "new"));

function navigations(run: () => void): unknown[] {
  const seen: unknown[] = [];
  const onNav = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener("swarmbot:navigate", onNav);
  try { run(); } finally { window.removeEventListener("swarmbot:navigate", onNav); }
  return seen;
}

describe("case sheet handoffs", () => {
  it("each count in the Evidence bar opens Evidence on that authority state", () => {
    const m = model([art("email", "a@example.test"), art("email", "b@example.test")]);
    const first = m.distribution[0];
    render(<CaseSheetView model={m} hydrated />);
    const bar = screen.getByRole("region", { name: "Evidence" });
    const seen = navigations(() => fireEvent.click(within(bar).getByRole("button", { name: new RegExp(`Show ${first.n} ${first.short}`) })));
    expect(seen).toEqual([{ tab: "artifacts", authorityState: first.state }]);
  });

  it("the subject's chip opens the subject row", () => {
    const name = art("name", "Alex Example", { source_class: ["registry", "social"] }, 80);
    const m = model([name, art("email", "alex@example.test")]);
    render(<CaseSheetView model={m} hydrated />);
    const subject = screen.getByRole("region", { name: "Subject" });
    const seen = navigations(() => fireEvent.click(within(subject).getByRole("button", { name: /in Evidence/ })));
    expect(seen).toEqual([{ tab: "artifacts", artifactId: m.subject!.artifact.id }]);
  });

  it("an empty decision queue still points at the review rows, and says they are a different queue", () => {
    const m = model([art("email", "solo@example.test")]);
    const reviewN = m.distribution.find((d) => d.state === "review")?.n ?? 0;
    expect(reviewN, "fixture must yield review rows, or this test proves nothing").toBeGreaterThan(0);
    expect(m.queueTotal).toBe(0);
    render(<CaseSheetView model={m} hydrated />);
    const queue = screen.getByRole("region", { name: "Needs your call" });
    const link = within(queue).getByRole("button", { name: /a second source, not a decision/ });
    const seen = navigations(() => fireEvent.click(link));
    expect(seen).toEqual([{ tab: "artifacts", authorityState: "review" }]);
    expect(link.getAttribute("aria-label")).toMatch(/also lists Conflict rows/);
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
