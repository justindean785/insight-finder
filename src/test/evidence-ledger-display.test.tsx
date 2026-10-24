// evidence-ledger-display.test.tsx — what the Evidence ledger PRINTS, never what it scores.
// Synthetic fixtures only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { splitUrlDescriptor } from "@/lib/evidence-bands";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

vi.mock("@/integrations/supabase/client", () => {
  const empty = { data: [], error: null, count: 0 };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(empty) : chain),
    apply: () => chain,
  });
  return { supabase: { from: () => chain, channel: () => chain, removeChannel: () => Promise.resolve(), auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) } } };
});

import { ArtifactRow } from "@/components/ResourcesPanel";
import { displayConfidence } from "@/lib/display-confidence";
import { authorityFor } from "@/lib/authority";

const art = (value: string, kind = "url", confidence = 65): Artifact => ({
  id: "a1", kind, value, confidence, source: "fixture", created_at: "2026-01-01T00:00:00Z", metadata: null,
});
const review = { get: () => "new", map: {} } as never;
const row = (a: Artifact, hideProv = true) => render(<ArtifactRow a={a} onSelect={() => {}} review={review} hideProv={hideProv} />);

const AVATAR = "https://img.example.test/profile_images/15655233336676/DX5Ai936_200x200.jpg — X/Twitter avatar for @someone";

describe("splitUrlDescriptor", () => {
  it("splits a link from its descriptor on a spaced dash, losing neither half", () => {
    expect(splitUrlDescriptor(AVATAR)).toEqual({
      url: "https://img.example.test/profile_images/15655233336676/DX5Ai936_200x200.jpg",
      descriptor: "X/Twitter avatar for @someone",
    });
    expect(splitUrlDescriptor("http://a.test/x – en dash form")?.descriptor).toBe("en dash form");
  });
  it("leaves everything else alone", () => {
    for (const v of ["https://a.test/x", "https://a.test/x-y-z", "https://a.test/x—nospaces", "someone@example.test", "plain words — not a url", ""]) {
      expect(splitUrlDescriptor(v), v).toBeNull();
    }
  });
});

describe("ledger row value", () => {
  it("shows the descriptor in the reading face and the URL in mono, and still copies the WHOLE recorded value", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = row(art(AVATAR));
    const mono = container.querySelector(".mono-value")!;
    expect(mono.textContent).toBe("https://img.example.test/profile_images/15655233336676/DX5Ai936_200x200.jpg");
    expect(container.textContent).toContain("X/Twitter avatar for @someone");
    expect(container.querySelector(".mono-value")!.className).not.toMatch(/font-sans/);
    expect(container.querySelector('[title="' + AVATAR + '"]')).toBeTruthy(); // the full value stays one hover away
    fireEvent.click(screen.getByRole("button", { name: `Copy ${AVATAR}` }));
    expect(writeText).toHaveBeenCalledWith(AVATAR);
    // The row's accessible name carries the full recorded value, as before.
    expect(container.querySelector('[role="button"][data-density-row]')!.getAttribute("aria-label")).toContain(AVATAR);
  });

  it("a plain selector keeps the mono single-line treatment", () => {
    const { container } = row(art("someone@example.test", "email"));
    expect(container.querySelector(".mono-value")!.textContent).toBe("someone@example.test");
  });

  it("secondary text is the legible .ledger-meta label, not 10px mono", () => {
    const { container } = row(art("someone@example.test", "email"));
    const basis = container.querySelector('[data-ledger-col="status"] .ledger-meta');
    expect(basis).toBeTruthy();
    expect(basis!.className).not.toMatch(/font-mono|text-eyebrow/);
  });

  it("the figure and the authority are exactly what the engine computes (display only)", () => {
    const a = art("someone@example.test", "email", 65);
    const { container } = row(a);
    const shown = displayConfidence(a);
    expect(container.querySelector(".conf-figure")!.textContent).toBe(String(shown.effective ?? 0));
    expect(container.querySelector(".spine")!.getAttribute("data-authority")).toBe(authorityFor(a, "new").state);
  });
});

describe("ledger stylesheet contract", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

  it("rows own the SAME column gap as the head, against the density rule that overrode it", () => {
    expect(css).toMatch(/\.ledger-row\[data-density-row\]\s*\{\s*column-gap:\s*0\.75rem;/);
    expect(css).toMatch(/\.ledger-head\s*\{[^}]*column-gap:\s*0\.75rem/s);
  });
  it("drops the Source column only when no row prints a source (and only where :has() exists)", () => {
    expect(css).toMatch(/\.ledger:not\(:has\(\.ledger-row \[data-ledger-col="source"\]:not\(:empty\)\)\)/);
    expect(css).toMatch(/--ledger-cols:\s*minmax\(0, 1fr\) 15rem 4\.5rem;/);
  });
  it("a row with no source lets its authority line use that cell (per-row, :has() only)", () => {
    expect(css).toMatch(/\.ledger-row \[data-ledger-col="source"\]:empty\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/\.ledger-row \[data-ledger-col="status"\]:has\(\+ \[data-ledger-col="source"\]:empty\)\s*\{\s*grid-column:\s*span 2;/);
  });
  it("the three-column layout resets the per-row authority span (Codex P2 on #870)", () => {
    expect(css).toMatch(/\.ledger:not\(:has\(\.ledger-row \[data-ledger-col="source"\]:not\(:empty\)\)\) \.ledger-row \[data-ledger-col="status"\]\s*\{\s*grid-column:\s*auto;/);
    // ...and it must come AFTER the span rule so it wins at equal-or-higher specificity.
    expect(css.indexOf('[data-ledger-col="status"]:has(+')).toBeLessThan(css.lastIndexOf("grid-column: auto;"));
  });
  it("the ledger confidence figure is a plain 15px/600 tabular figure; the global serif figure is untouched", () => {
    expect(css).toMatch(/\.ledger-row \.conf-figure\s*\{[^}]*font-weight:\s*600;[^}]*font-size:\s*15px;/s);
    expect(css).toMatch(/\.conf-figure\s*\{\s*font-family:\s*"Newsreader"/);
  });
});
