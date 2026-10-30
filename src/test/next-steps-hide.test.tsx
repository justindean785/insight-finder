// next-steps-hide.test.tsx — hide a pivot from the Next list with "−" or its button,
// hide a repeated kind in one click, undo, and show everything again. Drives the real
// pipeline (extractor -> engine with the stored skip set -> schema -> NextSteps), so
// "hidden" means the engine stopped offering it, not that the row was styled away.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useState } from "react";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { computePivots } from "@/lib/pivot-engine";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";
import { pivotEligibility, pivotSuggestionInput, validatePivotSuggestion } from "@/lib/pivot-schema";
import { hidePivots, readPivotSkip, restorePivots, PIVOT_SKIP_EVENT } from "@/lib/pivot-skip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const T = "t-hide";
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const REPORT = [
  "## Recommended Next Pivots",
  "- Corroborate username `alpha_case_1` across platforms — Check public profiles",
  "- Corroborate username `bravo_case_2` across platforms — Check public profiles",
  "- Corroborate username `charlie_case_3` across platforms — Check public profiles",
  "- Check email `one@example.test` — Breach exposure",
].join("\n");

function Harness() {
  const [skip, setSkip] = useState(() => readPivotSkip(T));
  const [last, setLast] = useState<{ label: string; targets: string[] } | null>(null);
  useEffect(() => {
    const f = () => setSkip(readPivotSkip(T));
    window.addEventListener(PIVOT_SKIP_EVENT, f);
    return () => window.removeEventListener(PIVOT_SKIP_EVENT, f);
  }, []);
  const items = useMemo<NextStepItem[]>(
    () =>
      computePivots({ artifacts: [], seedValue: "seed@example.com", reportPivots: extractRecommendedPivots(REPORT), skipSet: skip })
        .filter((p) => p.status === "new")
        .map((p, i) => {
          const validation = validatePivotSuggestion(pivotSuggestionInput(p));
          return {
            kind: "pivot" as const, key: `k${i}-${p.value}`, validation,
            eligibility: validation.status === "valid" ? pivotEligibility(validation.pivot, { artifactsById: new Map(), review: () => "new" }) : null,
          };
        }),
    [skip],
  );
  return (
    <NextSteps
      items={items}
      onRunPivot={vi.fn()}
      onRunAction={vi.fn()}
      onHide={(targets, label) => { hidePivots(T, targets); setLast({ label, targets }); }}
      hiddenCount={skip.size}
      onShowHidden={() => { restorePivots(T); setLast(null); }}
      lastHidden={last ? { label: last.label, count: last.targets.length } : null}
      onUndoHide={() => { if (last) restorePivots(T, last.targets); setLast(null); }}
    />
  );
}

const shown = () => screen.getByRole("region", { name: "Next steps" }).textContent ?? "";

describe("hiding pivots from the Next list", () => {
  it("the Hide button removes that pivot and the engine stops offering it", () => {
    render(<Harness />);
    expect(shown()).toContain("alpha_case_1");
    fireEvent.click(screen.getByRole("button", { name: /^Hide .*alpha_case_1/ }));
    expect(shown()).not.toContain("alpha_case_1");
    expect(shown()).toContain("bravo_case_2");
    expect(readPivotSkip(T).has("alpha case 1")).toBe(true);
  });

  it("'−' on a focused step hides it; modifiers and typing fields are ignored", () => {
    render(<Harness />);
    const hideBtn = screen.getByRole("button", { name: /^Hide .*bravo_case_2/ });
    fireEvent.keyDown(hideBtn, { key: "-", ctrlKey: true });
    fireEvent.keyDown(hideBtn, { key: "-", metaKey: true });
    expect(shown()).toContain("bravo_case_2");
    fireEvent.keyDown(hideBtn, { key: "-" });
    expect(shown()).not.toContain("bravo_case_2");
  });

  it("'Hide all' hides every step of a repeated kind at once", () => {
    render(<Harness />);
    const bar = screen.getByText("Hide all:").parentElement!;
    const before = readPivotSkip(T).size;
    fireEvent.click(within(bar).getAllByRole("button")[0]);
    expect(readPivotSkip(T).size).toBeGreaterThan(before + 1);
  });

  it("Undo brings back the last hide; Show all brings back everything", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Hide .*alpha_case_1/ }));
    expect(shown()).not.toContain("alpha_case_1");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(shown()).toContain("alpha_case_1");
    fireEvent.click(screen.getByRole("button", { name: /^Hide .*bravo_case_2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Hide .*charlie_case_3/ }));
    expect(screen.getByText(/hidden on this device/).textContent).toMatch(/2 hidden/);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(shown()).toContain("bravo_case_2");
    expect(shown()).toContain("charlie_case_3");
    expect(readPivotSkip(T).size).toBe(0);
  });

  it("without onHide there are no hide controls and '−' does nothing", () => {
    const validation = validatePivotSuggestion(pivotSuggestionInput(
      computePivots({ artifacts: [], seedValue: "seed@example.com", reportPivots: extractRecommendedPivots(REPORT), skipSet: new Set() }).filter((p) => p.status === "new")[0],
    ));
    const item: NextStepItem = {
      kind: "pivot", key: "k0", validation,
      eligibility: validation.status === "valid" ? pivotEligibility(validation.pivot, { artifactsById: new Map(), review: () => "new" }) : null,
    };
    const { container } = render(<NextSteps items={[item]} onRunPivot={vi.fn()} onRunAction={vi.fn()} />);
    expect(container.querySelector("[aria-keyshortcuts]")).toBeNull();
    const runBtn = screen.getAllByRole("button")[0];
    fireEvent.keyDown(runBtn, { key: "-" });
    expect(readPivotSkip(T).size).toBe(0);
  });
});

describe("pivot-skip storage", () => {
  it("normalizes like the engine, restores by target, and announces the change", () => {
    const seen = vi.fn();
    window.addEventListener(PIVOT_SKIP_EVENT, seen);
    act(() => { hidePivots(T, ["O'Brien.Case"]); });
    expect(readPivotSkip(T).has("o brien case")).toBe(true);
    act(() => { restorePivots(T, ["o brien case"]); });
    expect(readPivotSkip(T).size).toBe(0);
    expect(seen).toHaveBeenCalledTimes(2);
    window.removeEventListener(PIVOT_SKIP_EVENT, seen);
  });
});
