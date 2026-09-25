// stated-label-authority.test.tsx — a sentence the agent typed must never look
// like a number the engine computed.
//
// WHY THIS EXISTS. `record_finding` derives confidence server-side and caps it
// (`countIndependentClasses`), and those values reach the screen through
// ui/confidence.tsx and ui/authority.tsx as FILLED chips. The agent also types
// bare `[CONFIRMED]` / `[VERIFY]` markers into its report prose, and until
// 2026-09-22 those were painted with the same tokens, the same border alpha and
// the same fill — so a stated verdict was indistinguishable from a measured one.
// A run audited that day published "Confirmed (95)" and "Confirmed (90)" in
// prose while the engine held zero finding rows and a maximum confidence of 65.
//
// The two properties that keep them apart, both asserted here against what the
// component actually renders rather than against a description of it:
//   1. a stated chip is HOLLOW — the fill belongs to a computed value;
//   2. a stated chip never borrows the confidence ramp — that ladder belongs to
//      the thing that computes confidence, and a second copy of it in prose is
//      the drifting second source of truth this codebase warns about elsewhere.
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UIMessage } from "ai";
import { MessageView } from "@/components/ChatWindow";

afterEach(cleanup);

const LABELS = ["CONFIRMED", "CORRELATED", "INFERRED", "VERIFY", "FAILED", "LOW", "CONFLICT"] as const;

const assistant = (text: string): UIMessage =>
  ({ id: "m1", role: "assistant", parts: [{ type: "text", text }] } as unknown as UIMessage);

/** Every label at once, in the list shape a real findings report uses. */
const allLabels = LABELS.map((l) => `- [${l}] Something the agent asserted.`).join("\n");

function chipsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".chat-label-chip"));
}

describe("agent-stated labels in report prose", () => {
  it("renders one chip per label in the vocabulary", () => {
    const { container } = render(<MessageView m={assistant(allLabels)} />);
    const chips = chipsOf(container);
    expect(chips.map((c) => c.textContent)).toEqual([...LABELS]);
  });

  it("never fills a stated chip — the fill is what a computed value looks like", () => {
    const { container } = render(<MessageView m={assistant(allLabels)} />);
    for (const chip of chipsOf(container)) {
      // Any `bg-*` utility would paint a fill straight back on and erase the one
      // difference between this and a ConfidenceTag.
      const filled = chip.className.split(/\s+/).filter((c) => /^bg-/.test(c));
      expect(filled, `${chip.textContent} must not carry a fill utility`).toEqual([]);
    }
  });

  it("never borrows the engine's confidence ramp", () => {
    const { container } = render(<MessageView m={assistant(allLabels)} />);
    for (const chip of chipsOf(container)) {
      expect(
        chip.className,
        `${chip.textContent} must not reference a --conf-* or --confidence-* token`,
      ).not.toMatch(/--conf(idence)?-/);
    }
  });

  it("says who wrote the label, on every one of them", () => {
    const { container } = render(<MessageView m={assistant(allLabels)} />);
    for (const chip of chipsOf(container)) {
      expect(chip.getAttribute("title"), `${chip.textContent} needs a title`).toBeTruthy();
    }
  });

  it("states it in the footer too, because a hover title reaches no touch device", () => {
    const { container } = render(<MessageView m={assistant(allLabels)} />);
    const footer = container.querySelector(".chat-card__footer")!;
    expect(footer.textContent).toMatch(/agent/i);
    expect(footer.textContent).toMatch(/Evidence/);
  });

  it("stays quiet when the agent stated nothing", () => {
    // The note is chrome for a specific hazard, not a standing disclaimer. Prose
    // with no stated label has nothing to disclaim.
    const { container } = render(
      <MessageView m={assistant("Moving to identity expansion. Nothing to report yet.")} />,
    );
    expect(chipsOf(container)).toHaveLength(0);
    expect(container.querySelector(".chat-card__footer")!.textContent).not.toMatch(/agent.s wording/i);
  });
});

describe("the stated-chip stylesheet", () => {
  // The fill can also be restored in CSS, where no render assertion would see
  // it. This reads the shipped stylesheet, in the same spirit as the edge
  // suite's source-level wiring tests.
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
  const rule = css.slice(css.indexOf(".chat-label-chip {"));
  const body = rule.slice(0, rule.indexOf("}"));

  it("keeps the chip hollow", () => {
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).not.toMatch(/background(-color)?:\s*hsl/);
  });

  it("keeps the dashed edge — texture, not colour alone", () => {
    expect(body).toMatch(/border:\s*1px dashed/);
  });
});
