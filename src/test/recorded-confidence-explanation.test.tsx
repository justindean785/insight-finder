import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ConfidenceExplain } from "@/components/ConfidenceExplain";
import { displayConfidence } from "@/lib/display-confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";

/**
 * The ⓘ popover beside every Evidence row. It must EXPLAIN the number the row
 * carries — the stored score, the server's recorded cap, the recorded source
 * classes, the authority state — and must not assemble a second opinion from a
 * provider-tier table, corroboration bonuses or recency deltas.
 *
 * These tests drive the shipped component. The mutation they must kill is
 * restoring the arithmetic breakdown: every "no arithmetic" assertion below
 * goes red the moment the popover prints a "+12" or a "Baseline reliability".
 */

afterEach(() => cleanup());

const DAY = 86_400_000;

function art(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "rce-1",
    thread_id: "t-rce",
    kind: "email",
    value: "row@example.com",
    confidence: 80,
    source: "hibp",
    created_at: "2026-09-01T00:00:00.000Z",
    metadata: {
      confidence_cap_applied: 50,
      reason_for_confidence: "only one independent source class",
      sources: ["hibp"],
      source_category: ["breach"],
    },
    ...over,
  } as Artifact;
}

function open(a: Artifact, review?: ReviewState) {
  render(<ConfidenceExplain artifact={a} review={review} />);
  fireEvent.click(screen.getByRole("button", { name: /^Why is this/ }));
  return within(screen.getByRole("dialog"));
}

describe("ConfidenceExplain — explains the recorded score", () => {
  it("the trigger and the headline carry the capped score, and the footer discloses stored → capped", () => {
    const a = art();
    render(<ConfidenceExplain artifact={a} />);
    expect(screen.getByRole("button", { name: "Why is this score 50/100?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Why is this/ }));
    const headline = document.querySelector<HTMLElement>("[data-score-headline]")!;
    expect(headline.textContent).toBe(String(displayConfidence(a).effective));
    expect(headline.textContent).toBe("50");

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Machine score: 50 (cap 50)")).toBeInTheDocument();
    expect(dialog.getByText(/Stored by the server:/).textContent).toBe(
      "Stored by the server: 80, capped to 50 — only one independent source class.",
    );
  });

  it("prints no arithmetic for a row the old breakdown used to decorate with deltas", () => {
    // Old behaviour on this row: provider baseline 92, corroboration ×3 (+12),
    // stale (>30d) −10, false positive −50 — none of it written by the server.
    const a = art({
      created_at: new Date(Date.now() - 40 * DAY).toISOString(),
      metadata: { confidence_cap_applied: 50, sources: ["hibp", "whois", "github"], false_positive: true },
    });
    const dialog = open(a);
    const text = screen.getByRole("dialog").textContent ?? "";
    for (const forbidden of [
      "Baseline reliability",
      "Corroboration ×",
      "Single source",
      "Stale (>30d)",
      "Fresh (<24h)",
      "False positive",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // No signed delta chip anywhere in the dialog.
    const signed = Array.from(screen.getByRole("dialog").querySelectorAll("span"))
      .map((s) => s.textContent?.trim() ?? "")
      .filter((t) => /^[+\-−]\d+$/.test(t));
    expect(signed).toEqual([]);
    // …and the stored score and cap are still shown plainly.
    expect(dialog.getByText("80/100")).toBeInTheDocument();
    expect(dialog.getByText("50/100")).toBeInTheDocument();
  });

  it("labels the score a machine assessment that is not a probability of identity", () => {
    const dialog = open(art());
    expect(
      dialog.getByText(/Machine assessment · uncalibrated\. This score is not a probability of identity\./),
    ).toBeInTheDocument();
    expect(dialog.getByText(/A point-by-point calculation is unavailable in this record view\./)).toBeInTheDocument();
  });

  it("shows an unreadable stored score as unknown, not as 0", () => {
    render(<ConfidenceExplain artifact={art({ confidence: null, metadata: null })} />);
    expect(screen.getByRole("button", { name: "Why is this score unknown?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Why is this/ }));
    expect(document.querySelector("[data-score-headline]")!.textContent).toBe("—");
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Unknown")).toBeInTheDocument();
    expect(dialog.getByText("A usable score was not recorded.")).toBeInTheDocument();
  });

  it("an analyst decision is shown as a state beside the unchanged machine score, never as points", () => {
    const a = art();
    const dialog = open(a, "confirmed");
    expect(document.querySelector("[data-score-headline]")!.textContent).toBe(String(displayConfidence(a).effective));
    const item = dialog.getByText("Analyst confirmed").closest("li")!;
    expect(item.textContent).toMatch(/machine score is unchanged/i);
    expect(item.querySelector(".font-mono")).toBeNull();
  });

  it("says source classes were not recorded rather than counting provider names", () => {
    const dialog = open(art({ metadata: { confidence_cap_applied: 50, sources: ["hibp", "whois", "github"] } }));
    const item = dialog.getByText("Independent source classes").closest("li")!;
    expect(within(item).getByText("Not recorded")).toBeInTheDocument();
    expect(item.textContent).toContain("Provider names alone do not establish independence.");
  });

  it("counts the recorded classes when the row carries them", () => {
    const dialog = open(
      art({ metadata: { confidence_cap_applied: 90, sources: ["hunter_verify", "whois_lookup"], source_category: ["official_profile_match", "infra_registry"] } }),
    );
    const item = dialog.getByText("Independent source classes").closest("li")!;
    expect(within(item).getByText("2")).toBeInTheDocument();
    expect(item.textContent).toContain("This count does not establish identity.");
  });
});
