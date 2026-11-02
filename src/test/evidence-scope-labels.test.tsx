// evidence-scope-labels.test.tsx — the three evidence figures on one screen name their scope.
//
// Production 2026-10-29, one case: header "17 evidence logged", sheet "14 items", report
// "15 artifacts were collected". All three were correct — chain-of-custody entries, deduped
// artifacts, raw rows — and only the header said which. Stage 1 real-case finding F-1: the
// header's authority counts (all case artifacts) and the footer's "no authoritative finding
// rows" (this run's record_finding calls) are different scopes shown side by side unlabeled,
// so an analyst reads "no scoring happened".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { tallyAuthority } from "@/lib/authority";
import { buildCaseSheet } from "@/lib/case-sheet";
import { CaseSheetView } from "@/components/workspace/CaseSheet";
import { MessageView } from "@/components/ChatWindow";

afterEach(cleanup);

let n = 0;
const art = (kind: string, value: string): Artifact => {
  n += 1;
  return { id: `s${n}`, kind, value, confidence: 60, source: "fixture", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, metadata: {} };
};
const assistant = (text: string): UIMessage =>
  ({ id: "m1", role: "assistant", parts: [{ type: "text", text }] } as unknown as UIMessage);

describe("the sheet's evidence figure names its population", () => {
  it("counts deduped case artifacts and says so, never a bare 'items'", () => {
    const items = [art("email", "a@example.test"), art("username", "example_user")];
    render(<CaseSheetView model={buildCaseSheet(items, {}, tallyAuthority(items, () => "new"))} hydrated />);
    const bar = screen.getByRole("region", { name: "Evidence" });
    expect(bar.textContent).toContain("2 artifacts");
    expect(bar.textContent).not.toMatch(/\bitems?\b/);
    const figure = bar.querySelector("[title]");
    expect(figure?.getAttribute("title")).toMatch(/chain-of-custody/i);
  });

  it("uses the singular for one artifact", () => {
    const items = [art("email", "a@example.test")];
    render(<CaseSheetView model={buildCaseSheet(items, {}, tallyAuthority(items, () => "new"))} hydrated />);
    expect(screen.getByRole("region", { name: "Evidence" }).textContent).toMatch(/1 artifact(?!s)/);
  });
});

describe("an unadjudicated narrative separates this run's findings from case authority", () => {
  const prose = [
    "## Findings Table",
    "- [CONFIRMED] Roblox account exists.",
    "",
    "## Evidence Record — authoritative",
    "_No authoritative finding rows were recorded for this run._ 15 artifacts were collected.",
  ].join("\n");

  it("names the run scope as zero model-adjudicated findings and keeps case authority in view", () => {
    const { container } = render(<MessageView m={assistant(prose)} />);
    const note = container.querySelector("[data-narrative-notice]");
    expect(note?.textContent).toMatch(/Model-adjudicated findings this run: 0/);
    expect(note?.textContent).toMatch(/record_finding/);
    expect(note?.textContent).toMatch(/Case-artifact authority/);
    // Stated once, above the prose — the footer no longer repeats it (2026-11-02, JD: the
    // two copies filled a phone screen).
    expect(note?.tagName).toBe("DETAILS");
    expect(note?.querySelector("summary")?.textContent).toMatch(/Unscored/);
    const footer = container.querySelector(".chat-card__footer");
    expect(footer?.textContent).not.toMatch(/Model-adjudicated/);
  });

  it("an adjudicated narrative keeps the plain wording", () => {
    const { container } = render(<MessageView m={assistant("- [CONFIRMED] Something the agent asserted.")} />);
    expect(container.querySelector("[data-narrative-notice]")?.textContent).not.toMatch(/Model-adjudicated/);
  });
});
