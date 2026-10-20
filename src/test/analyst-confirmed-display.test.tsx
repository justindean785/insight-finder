import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { explainConfidence } from "@/lib/confidence";
import { displayConfidence } from "@/lib/display-confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { labelForArtifact } from "@/lib/intel";
import {
  ANALYST_CONFIRMED_TEXT,
  analystConfirmedLabel,
  isAnalystConfirmed,
  machineScoreText,
} from "@/lib/analyst-confirmed";

/**
 * "Analyst-confirmed" in the confidence slot — the DISPLAY of an analyst decision.
 *
 * The operator marks a row Confirmed / Key and the number beside it never moves.
 * That is by design (`labelForArtifact` gives the decision its own rung, ATTESTED,
 * which never touches the figure), but a machine 50 beside the analyst's own
 * Confirm reads as if the product ignored them. The approved change is display
 * only: an ATTESTED row's slot reads "Analyst-confirmed", the bar goes, and the
 * machine score stays reachable in the slot's accessible name and the ⓘ popover.
 *
 * These tests DRIVE the shipped components — the Evidence board's `ArtifactRow`
 * and the Evidence table's `EvidenceMatrixTab` — rather than re-describing the
 * predicate. The mutation they must kill is reverting the slot to always render
 * the figure: every "Analyst-confirmed" assertion below then goes red.
 */

// Hermetic: nothing here may reach a network. Every chain resolves empty.
vi.mock("@/integrations/supabase/client", () => {
  const empty = Promise.resolve({ data: [], error: null, count: 0 });
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return empty.then.bind(empty);
        return () => chain;
      },
    },
  );
  return {
    supabase: {
      from: () => chain,
      channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
      removeChannel: () => {},
      auth: { getUser: () => Promise.resolve({ data: { user: null } }), getSession: () => Promise.resolve({ data: { session: null } }) },
    },
  };
});

// The Evidence table reads verdicts through the hook; the board row takes them
// as a prop. Both are fed from the same per-test map.
const mocks = vi.hoisted(() => ({ reviews: {} as Record<string, string> }));
vi.mock("@/lib/review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/review")>();
  return {
    ...actual,
    useReviewStates: () => ({
      get: (id: string) => (mocks.reviews[id] ?? "new") as ReviewState,
      getOwn: (id: string) => (mocks.reviews[id] ?? "new") as ReviewState,
      // The fixture rows have no same-value siblings, so nothing is ever inherited (#593).
      isInherited: () => false,
      getNote: () => "",
      set: vi.fn(),
      setNote: vi.fn(),
      availability: "ready",
      revision: 0,
    }),
  };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted regardless, but
// keeping the order legible makes the dependency obvious).
import { ArtifactRow } from "@/components/ResourcesPanel";
import { EvidenceMatrixTab } from "@/components/panel/EvidenceMatrixTab";

afterEach(() => {
  cleanup();
  mocks.reviews = {};
});

let seq = 0;
function art(over: Partial<Artifact> & { metadata?: Record<string, unknown> } = {}): Artifact {
  seq += 1;
  return {
    id: `acd${seq}`,
    thread_id: "t-acd",
    kind: "email",
    value: `row${seq}@example.com`,
    confidence: 50,
    source: "hunter_verify",
    created_at: "2026-09-01T00:00:00.000Z",
    // A recorded cap equal to the stored value: the popover line must name both.
    metadata: { confidence_cap_applied: 50, sources: ["hunter_verify"], source_category: ["official_profile_match"] },
    ...over,
  } as Artifact;
}

/** A row whose EVIDENCE clears CONFIRMED on its own: two independent classes, 90. */
function corroborated(): Artifact {
  return art({
    confidence: 90,
    metadata: {
      sources: ["hunter_verify", "whois_lookup"],
      source_category: ["official_profile_match", "infra_registry"],
    },
  });
}

function quarantined(): Artifact {
  return art({
    metadata: {
      confidence_cap_applied: 50,
      sources: ["hunter_verify"],
      source_category: ["official_profile_match"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — linkage to the subject is unproven",
    },
  });
}

function possibleMinor(): Artifact {
  return art({
    metadata: { confidence_cap_applied: 50, sources: ["hunter_verify"], source_category: ["official_profile_match"], possible_minor: true },
  });
}

function renderRow(a: Artifact, state?: ReviewState) {
  const review = { get: () => (state ?? "new") as ReviewState } as unknown as Parameters<typeof ArtifactRow>[0]["review"];
  const { container } = render(<ArtifactRow a={a} onSelect={() => {}} review={review} hideProv={false} />);
  const row = container.querySelector<HTMLElement>(".ledger-row")!;
  const slot = container.querySelector<HTMLElement>('[data-ledger-col="confidence"]')!;
  return { row, slot };
}

/** Open the ⓘ popover inside `scope` (it portals to document.body). */
function openInfo(scope: HTMLElement) {
  fireEvent.click(within(scope).getByRole("button", { name: /^Why is this/ }));
  expect(screen.getByText("Why this score?")).toBeInTheDocument();
}

// ─── The predicate is the label ladder's ATTESTED rung, nothing else ──────────

describe("isAnalystConfirmed — one source of truth", () => {
  it("is exactly labelForArtifact(...) === 'ATTESTED' across every review state", () => {
    const rows = [art(), corroborated(), quarantined(), possibleMinor()];
    const states: (ReviewState | undefined)[] = [undefined, "new", "confirmed", "key", "recheck", "dismissed", "wrong"];
    for (const a of rows) {
      for (const s of states) {
        expect(isAnalystConfirmed(a, s), `${a.id} / ${s}`).toBe(labelForArtifact(a, s) === "ATTESTED");
      }
    }
  });

  it("covers both analyst verdicts, and a persisted metadata.reviewed", () => {
    expect(isAnalystConfirmed(art(), "confirmed")).toBe(true);
    expect(isAnalystConfirmed(art(), "key")).toBe(true);
    expect(isAnalystConfirmed(art({ metadata: { confidence_cap_applied: 50, reviewed: true } }))).toBe(true);
    expect(isAnalystConfirmed(art())).toBe(false);
    expect(isAnalystConfirmed(art(), "recheck")).toBe(false);
  });

  it("never fires for evidence-CONFIRMED, quarantined or possible-minor rows", () => {
    expect(labelForArtifact(corroborated(), "confirmed")).toBe("CONFIRMED");
    expect(isAnalystConfirmed(corroborated(), "confirmed")).toBe(false);
    expect(isAnalystConfirmed(quarantined(), "key")).toBe(false);
    expect(isAnalystConfirmed(possibleMinor(), "key")).toBe(false);
  });

  it("names the machine score, with the cap only when one was recorded (0 included)", () => {
    expect(machineScoreText({ effective: 50, cap: 50 })).toBe("Machine score: 50 (cap 50)");
    expect(machineScoreText({ effective: 72, cap: null })).toBe("Machine score: 72");
    expect(machineScoreText({ effective: 0, cap: 0 })).toBe("Machine score: 0 (cap 0)");
    expect(analystConfirmedLabel({ effective: 50, cap: 50 })).toBe("Analyst-confirmed (machine score 50)");
  });
});

// ─── Evidence board row (ResourcesPanel ArtifactRow) ──────────────────────────

describe("Evidence board row — the confidence slot", () => {
  it("(1) a plain row shows its number and rule, not the analyst label", () => {
    const { row, slot } = renderRow(art());
    expect(slot.querySelector(".conf-figure")?.textContent).toBe("50");
    expect(slot.querySelector(".conf-rule")).not.toBeNull();
    expect(slot.textContent).not.toContain(ANALYST_CONFIRMED_TEXT);
    expect(row.getAttribute("aria-label")).toContain("50% confidence");
  });

  for (const verdict of ["confirmed", "key"] as const) {
    it(`(2) an analyst-confirmed row (${verdict}, single source) shows "Analyst-confirmed", not the number`, () => {
      const { row, slot } = renderRow(art(), verdict);
      expect(slot.textContent).toContain(ANALYST_CONFIRMED_TEXT);
      expect(slot.querySelector(".conf-figure")).toBeNull();
      expect(slot.querySelector(".conf-rule")).toBeNull();
      expect(slot.textContent).not.toMatch(/\b50\b/);

      // Accessible name of the slot, and of the row (which a screen reader reads
      // as one button name).
      expect(within(slot).getByRole("img", { name: "Analyst-confirmed (machine score 50)" })).toBeInTheDocument();
      expect(row.getAttribute("aria-label")).toContain("Analyst-confirmed (machine score 50)");
      expect(row.getAttribute("aria-label")).not.toContain("50% confidence");

      // The machine score is still one click away, in the ⓘ popover.
      openInfo(slot);
      expect(screen.getByText("Machine score: 50 (cap 50)")).toBeInTheDocument();
    });
  }

  it("(3) a quarantined row with a Key verdict still shows its number", () => {
    const { slot } = renderRow(quarantined(), "key");
    expect(slot.querySelector(".conf-figure")?.textContent).toBe("50");
    expect(slot.textContent).not.toContain(ANALYST_CONFIRMED_TEXT);
  });

  it("a possible-minor row with a Key verdict still shows its number", () => {
    const { slot } = renderRow(possibleMinor(), "key");
    expect(slot.querySelector(".conf-figure")?.textContent).toBe("50");
    expect(slot.textContent).not.toContain(ANALYST_CONFIRMED_TEXT);
  });

  it("a row CONFIRMED by evidence keeps its number even after an analyst Confirm", () => {
    const { slot } = renderRow(corroborated(), "confirmed");
    expect(slot.querySelector(".conf-figure")?.textContent).toBe("90");
    expect(slot.textContent).not.toContain(ANALYST_CONFIRMED_TEXT);
  });

  it("the ⓘ popover names the machine score on a plain row too", () => {
    const { slot } = renderRow(art());
    openInfo(slot);
    expect(screen.getByText("Machine score: 50 (cap 50)")).toBeInTheDocument();
  });

  // Codex on #679: the header printed explainConfidence(...).final, a separate
  // re-derivation, beside the canonical "Machine score" line — two competing
  // numbers in the one place an analyst-confirmed row still shows its score.
  it("the ⓘ popover headline IS the canonical score, never a re-derived total", () => {
    const a = art();
    expect(explainConfidence(a).final).not.toBe(displayConfidence(a).effective);
    const { slot } = renderRow(a, "key");
    openInfo(slot);
    const headline = document.querySelector<HTMLElement>("[data-score-headline]")!;
    expect(headline.textContent).toBe(String(displayConfidence(a).effective));
  });
});

// ─── Evidence table tile (EvidenceMatrixTab) ──────────────────────────────────

describe("Evidence table tile — the score slot", () => {
  function renderTile(a: Artifact, state?: ReviewState) {
    if (state) mocks.reviews[a.id] = state;
    const { container } = render(<EvidenceMatrixTab artifacts={[a]} onLocalUpdate={() => {}} threadId="t-acd" />);
    return container.querySelector<HTMLElement>("li.evidence-tile")!;
  }

  it("a plain tile shows its number", () => {
    const tile = renderTile(art());
    expect(tile.textContent).toContain("/100");
    expect(tile.querySelector("[data-analyst-confirmed]")).toBeNull();
  });

  it("an analyst-confirmed tile shows 'Analyst-confirmed' and the machine score stays in the ⓘ popover", () => {
    const tile = renderTile(art(), "key");
    expect(within(tile).getByRole("img", { name: "Analyst-confirmed (machine score 50)" })).toBeInTheDocument();
    expect(tile.textContent).not.toContain("/100");
    openInfo(tile);
    expect(screen.getByText("Machine score: 50 (cap 50)")).toBeInTheDocument();
  });

  it("a quarantined tile with a Key verdict keeps its number", () => {
    const tile = renderTile(quarantined(), "key");
    expect(tile.textContent).toContain("/100");
    expect(tile.querySelector("[data-analyst-confirmed]")).toBeNull();
  });
});
