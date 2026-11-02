import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * Case desk R5: the transcript's inline assessment cards read the SAME R2
 * assessment the Finding panel and the ledger show, and selecting a row opens
 * the Finding tab on it. Nothing here is a new score.
 */
const SEED = "j.harker@northgate-logistics.com";
const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "exa_search", created_at: "2026-10-20T09:51:00Z", metadata: {}, ...over,
});
const seedRow = art({ id: "seed", kind: "email", value: SEED, confidence: 88 });
const linked = art({ id: "prof", kind: "social_profile", value: "https://social.example/jharker_ops", confidence: 72, metadata: { email: SEED, handle: "jharker_ops" } });
const conflict = art({ id: "con", kind: "location", value: "Stockton, California, US", confidence: 38, metadata: { conflict: true, conflict_note: "contradicts the Oakland record" } });

const state = vi.hoisted(() => ({ items: [] as Artifact[], selected: [] as string[] }));
vi.mock("@/hooks/useCaseSnapshot", () => {
  const api = () => ({ refresh: async () => {}, snapshot: { hydrated: true, items: state.items, seed: { value: SEED, type: "email", caseTitle: null }, run: { state: "completed" } } });
  return { useCaseSnapshot: api, useOptionalCaseSnapshot: api };
});
vi.mock("@/lib/review", () => ({ useReviewStates: () => ({ map: {}, availability: "ok", get: () => "new" }) }));
vi.mock("@/hooks/useWorkspaceUIState", () => ({
  useOptionalWorkspaceUIState: () => ({ select: (id: string) => { state.selected.push(id); }, rememberOpener: () => {}, clear: () => {}, selectedArtifactId: null, getDraft: () => "", setDraft: () => {}, clearDraft: () => {} }),
}));

const { AgentAssessmentCards } = await import("@/components/chat/AgentAssessmentCards");

describe("AgentAssessmentCards", () => {
  it("lists the rows the engine links to the subject with their linkage, and a click selects the row", () => {
    state.items = [seedRow, linked, conflict]; state.selected = [];
    render(<AgentAssessmentCards threadId="t" />);
    const card = screen.getByRole("region", { name: "Connections identified" });
    const row = card.querySelector("button[id='chat-connection-prof']")!;
    expect(row.textContent).toContain("https://social.example/jharker_ops");
    expect(row.textContent).toMatch(/\d+% linkage/);
    // The seed itself is not a "connection".
    expect(card.querySelector("button[id='chat-connection-seed']")).toBeNull();
    fireEvent.click(row);
    expect(state.selected).toEqual(["prof"]);
  });

  it("shows the first contradiction with the engine's own note", () => {
    state.items = [seedRow, linked, conflict];
    render(<AgentAssessmentCards threadId="t" />);
    const note = screen.getByRole("note", { name: "Contradiction" });
    expect(note.textContent).toContain("Stockton, California, US");
    expect(note.textContent).toContain("contradicts the Oakland record");
  });

  it("renders nothing when the engine links nothing and nothing conflicts", () => {
    state.items = [seedRow];
    const { container } = render(<AgentAssessmentCards threadId="t" />);
    expect(container.querySelector("[data-assessment-cards]")).toBeNull();
  });
});
