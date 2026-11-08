import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  ASSOCIATION_LIKELIHOOD_ENABLED,
  AssociationLikelihood,
  LikelyLinksChip,
} from "@/components/workspace/AssociationLikelihood";

// Synthetic values only (reserved domains, TEST-NET IPs): this repository is public.
const T = "2026-11-08T09:00:00Z";
const art = (id: string, kind: string, value: string, metadata: Record<string, unknown> = {}): Artifact =>
  ({ id, kind, value, confidence: 50, source: "test_tool", created_at: T, metadata }) as unknown as Artifact;

const linked = [
  art("u1", "username", "quietfalcon77"),
  art("b1", "breach_exposure", "corpus-a row: pat.sample@example.test / quietfalcon77"),
];

describe("AssociationLikelihood register", () => {
  it("renders a scored pair in the inference register with its label", () => {
    render(<AssociationLikelihood items={linked} seedValue={null} reviews={{}} />);
    const chip = document.querySelector("[data-likelihood-band]") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toMatch(/^(Strong link|Likely linked|Possibly linked) \(\d+%\)$/);
    expect(chip.className).toMatch(/border-dashed/);
    expect(chip.className).toMatch(/intel-violet/);
    expect(screen.getByText(/scored pair/)).toBeInTheDocument();
  });

  it("shows reasons only on expand", () => {
    render(<AssociationLikelihood items={linked} seedValue={null} reviews={{}} />);
    expect(screen.queryByText(/Seen together/)).toBeNull();
    fireEvent.click(document.querySelector("[data-likelihood-band]")!.closest("button")!);
    expect(screen.getByText(/Seen together/)).toBeInTheDocument();
  });

  it("lists a fully quarantined pair as withheld, collapsed and with no figure", () => {
    const items = [
      art("e1", "email", "other.sample@example.test", { subject_unlinked: true }),
      art("u1", "username", "quietfalcon77"),
      art("b1", "breach_exposure", "corpus-b row: other.sample@example.test / quietfalcon77", { subject_unlinked: true }),
    ];
    render(<AssociationLikelihood items={items} seedValue={null} reviews={{}} />);
    expect(document.querySelector("[data-likelihood-band]")).toBeNull();
    expect(document.querySelector("[data-association-withheld]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Withheld — linkage unproven/ }));
    const list = document.querySelector("[data-association-withheld]") as HTMLElement;
    expect(list.textContent).toContain("other.sample@example.test");
    expect(list.textContent).not.toMatch(/\d+%/);
  });

  it("never renders the word confirmed", () => {
    render(<AssociationLikelihood items={linked} seedValue={null} reviews={{ b1: "confirmed" }} />);
    fireEvent.click(document.querySelector("[data-likelihood-band]")!.closest("button")!);
    expect(document.body.textContent).not.toMatch(/confirmed/i);
  });

  it("the Overview chip counts likely-or-strong pairs", () => {
    render(<LikelyLinksChip items={linked} seedValue={null} reviews={{}} />);
    const chip = document.querySelector("[data-likely-links]") as HTMLElement;
    expect(chip.textContent).toMatch(/^Likely links: \d+$/);
  });
});

describe("flag wiring", () => {
  it("is off by default (VITE_ASSOCIATION_LIKELIHOOD unset)", () => {
    expect(ASSOCIATION_LIKELIHOOD_ENABLED).toBe(false);
  });

  it("both mount points are gated by the flag", () => {
    const conn = readFileSync(resolve(__dirname, "../components/workspace/WorkbenchConnections.tsx"), "utf8");
    const over = readFileSync(resolve(__dirname, "../components/workspace/OverviewTab.tsx"), "utf8");
    expect(conn).toMatch(/ASSOCIATION_LIKELIHOOD_ENABLED && <AssociationLikelihood /);
    expect(over).toMatch(/ASSOCIATION_LIKELIHOOD_ENABLED && <LikelyLinksChip /);
  });
});
