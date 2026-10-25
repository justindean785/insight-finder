import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { authorityFor, tallyAuthority, type AuthorityState } from "@/lib/authority";
import { buildCaseSheet, initialsOf, ASK_LABEL, CASE_SHEET_QUEUE_LIMIT } from "@/lib/case-sheet";
import { buildIdentityRows } from "@/lib/report-hygiene";
import type { ReviewState } from "@/lib/analyst-decisions";
import { CaseSheetView } from "@/components/workspace/CaseSheet";

// Synthetic fixtures only — no case identifiers.
let n = 0;
function art(kind: string, value: string, metadata: Record<string, unknown> = {}, confidence = 60): Artifact {
  n += 1;
  return { id: `a${n}`, kind, value, confidence, source: "fixture", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, metadata };
}

function model(items: Artifact[], reviews: Record<string, ReviewState> = {}) {
  const tally = tallyAuthority(items, (id) => reviews[id] ?? "new");
  return buildCaseSheet(items, reviews, tally);
}

describe("case sheet — subject", () => {
  it("names the subject by the SAME rule as the report's Real name field", () => {
    const strong = art("name", "Alex Example", { source_class: ["registry", "social"] }, 80);
    const weak = art("name", "A. Example", {}, 40);
    const items = [weak, strong, art("email", "alex@example.test")];
    const reportName = buildIdentityRows(items).find((r) => r.field === "Real name")?.value;
    expect(model(items).subject?.artifact.value).toBe(reportName);
  });

  it("never names a quarantined name", () => {
    const q = art("name", "Pat Namesake", { subject_unlinked: true, subject_unlinked_reason: "name-only match" }, 90);
    expect(authorityFor(q).state).toBe("quarantined");
    expect(model([q]).subject).toBeNull();
  });

  it("never names an analyst-rejected name", () => {
    const rejected = art("name", "Wrong Person", {}, 90);
    expect(model([rejected], { [rejected.id]: "wrong" }).subject).toBeNull();
  });

  it("shows the engine's authority for the subject, not a raw source count", () => {
    const name = art("name", "Alex Example", {}, 55);
    const m = model([name]);
    expect(m.subject?.view).toEqual(authorityFor(name, "new"));
  });

  it("derives initials from the name", () => {
    expect(initialsOf("Alex J. Example")).toBe("AE");
    expect(initialsOf("mononym")).toBe("M");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("case sheet — evidence distribution", () => {
  it("is the snapshot tally, zero states dropped, in ladder order", () => {
    const items = [
      art("email", "a@example.test"),
      art("name", "Pat Namesake", { subject_unlinked: true }),
      art("phone", "+15550100", { conflict: true }),
    ];
    const tally = tallyAuthority(items, () => "new");
    const m = buildCaseSheet(items, {}, tally);
    const expected = (Object.entries(tally) as [AuthorityState, number][]).filter(([, v]) => v > 0);
    expect(m.total).toBe(items.length);
    expect(Object.fromEntries(m.distribution.map((d) => [d.state, d.n]))).toEqual(Object.fromEntries(expected));
    expect(m.distribution.every((d) => d.n > 0)).toBe(true);
  });
});

describe("case sheet — needs your call", () => {
  it("asks LINKAGE of a quarantined row and REVIEW of a plain conflict", () => {
    const q = art("username", "handle_x", { subject_unlinked: true, subject_unlinked_reason: "username match only" });
    const c = art("address", "1 Example St", { conflict: true, reason_not_confirmed: "record names a different resident" });
    expect(authorityFor(q).state).toBe("quarantined");
    expect(authorityFor(c).state).toBe("conflict");
    const byId = Object.fromEntries(model([q, c]).queue.map((x) => [x.artifact.id, x.ask]));
    expect(byId[q.id]).toBe("linkage");
    expect(byId[c.id]).toBe("review");
  });

  it("lists at most the limit but counts every row that needs a call", () => {
    const items = Array.from({ length: CASE_SHEET_QUEUE_LIMIT + 3 }, (_, i) => art("username", `h${i}`, { subject_unlinked: true }));
    const m = model(items);
    expect(m.queue).toHaveLength(CASE_SHEET_QUEUE_LIMIT);
    expect(m.queueTotal).toBe(CASE_SHEET_QUEUE_LIMIT + 3);
  });

  it("never asks linkage of a collision-only row, since no release can retire it", () => {
    // Release is gated on an ACTIVE subject_unlinked quarantine, and a review
    // verdict does not clear collision ineligibility — so a "whose is this?"
    // card for this row would sit in the queue forever.
    const col = art("username", "namesake_h", { possible_collision: true });
    expect(authorityFor(col).state).toBe("quarantined");
    expect(authorityFor(col).caveatKind).toBe("linkage");
    const m = model([col]);
    expect(m.queue).toEqual([]);
    expect(m.queueTotal).toBe(0);
    // Still disclosed in the distribution — withheld from the queue, not hidden.
    expect(m.distribution.find((d) => d.state === "quarantined")?.n).toBe(1);
  });

  it("asks REVIEW of a disputed collision row, not linkage", () => {
    const c = art("phone", "+15550102", { conflict: true, collision: true });
    // Conflict outranks the collision's quarantine, so the row reads Conflict.
    expect(authorityFor(c).state).toBe("conflict");
    expect(model([c]).queue.map((x) => x.ask)).toEqual(["review"]);
  });

  it("puts conflicts before quarantined rows", () => {
    const q = art("username", "h", { subject_unlinked: true });
    const c = art("phone", "+15550101", { conflict: true });
    expect(model([q, c]).queue.map((x) => x.view.state)).toEqual(["conflict", "quarantined"]);
  });
});

describe("case sheet — view", () => {
  it("labels the two asks separately and never offers a bare Confirm", () => {
    const q = art("username", "handle_y", { subject_unlinked: true, subject_unlinked_reason: "username match only" });
    const c = art("address", "2 Example St", { conflict: true });
    render(<CaseSheetView model={model([q, c])} hydrated />);
    const queue = screen.getByRole("region", { name: "Needs your call" });
    expect(within(queue).getByText(ASK_LABEL.linkage)).toBeTruthy();
    expect(within(queue).getByText(ASK_LABEL.review)).toBeTruthy();
    const buttons = within(queue).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(buttons.every((t) => t === "Decide in Evidence")).toBe(true);
    expect(within(queue).queryByText(/^confirm$/i)).toBeNull();
  });

  it("hands the row's id to Evidence so a hidden quarantined row can be opened", () => {
    const q = art("username", "handle_z", { subject_unlinked: true });
    const seen: unknown[] = [];
    const onNav = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("swarmbot:navigate", onNav);
    try {
      render(<CaseSheetView model={model([q])} hydrated />);
      const queue = screen.getByRole("region", { name: "Needs your call" });
      fireEvent.click(within(queue).getByRole("button", { name: /Decide in Evidence/ }));
    } finally {
      window.removeEventListener("swarmbot:navigate", onNav);
    }
    expect(seen).toEqual([{ tab: "artifacts", artifactId: q.id }]);
  });

  it("fails closed on the subject and the queue when review decisions could not load", () => {
    // With the verdict read failed the review map is empty, so the model can
    // name a subject the analyst already REJECTED. The view must not show it.
    const name = art("name", "Rejected Person", {}, 90);
    const q = art("username", "handle_w", { subject_unlinked: true });
    const m = model([name, q]);
    expect(m.subject?.artifact.value).toBe("Rejected Person");
    render(<CaseSheetView model={m} hydrated reviewsUnavailable />);
    expect(screen.queryByText("Rejected Person")).toBeNull();
    expect(screen.queryByText("handle_w")).toBeNull();
    expect(screen.queryByRole("button", { name: /Decide in Evidence/ })).toBeNull();
    expect(screen.getAllByText(/review decisions couldn't be loaded/).length).toBe(2);
  });

  it("prints no figure until the case has hydrated", () => {
    render(<CaseSheetView model={model([art("email", "b@example.test")])} hydrated={false} />);
    expect(screen.queryByText(/item/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
  });
});

describe("case sheet — review availability wiring", () => {
  it("passes an UNAVAILABLE review read to the view instead of treating it as loaded", () => {
    const src = readFileSync(resolve(process.cwd(), "src/hooks/useCaseSheetModel.ts"), "utf8");
    expect(src).toMatch(/reviewsUnavailable: review\.availability === "unavailable"/);
  });
});

describe("case sheet — Evidence handoff wiring", () => {
  it("forwards the artifact id from the navigate event down to the board", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/ChatPage.tsx"), "utf8");
    expect(page).toMatch(/artifactId: detail\?\.artifactId/);
    const tab = readFileSync(resolve(process.cwd(), "src/components/workspace/EvidenceTab.tsx"), "utf8");
    expect(tab).toMatch(/focusRequest=\{viewRequest\?\.artifactId/);
  });
});

describe("case sheet — ChatPage wiring", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/ChatPage.tsx"), "utf8");

  it("renders the sheet LAST in the content container, after every panel", () => {
    const content = src.slice(src.indexOf('<div key="workspace-content"'), src.indexOf("// ONE layout tree"));
    // The column is the Workbench now (its default tab is the case sheet); the placement contract is unchanged.
    expect(content.indexOf("<Workbench")).toBeGreaterThan(content.indexOf('panel("tools"'));
    expect(content.indexOf("<ChatWindow")).toBeLessThan(content.indexOf("<Workbench"));
  });

  it("shows only beside the surfaces that share the Workbench, never on mobile", () => {
    // The Workbench is shared across Investigate (chat), Evidence and Report
    // (JD's "exactly ONE right-hand workbench, shared across Investigate and
    // Evidence" invariant). Overview, Graph and Tools own full width.
    expect(src).toMatch(/const showSheet = !isMobile && \(tab === "chat" \|\| tab === "report" \|\| tab === "evidence"\);/);
  });
});
