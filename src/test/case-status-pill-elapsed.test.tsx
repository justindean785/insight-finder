import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CaseStatusPill } from "@/components/workspace/CaseStatus";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import type { CaseRunState } from "@/lib/case-snapshot";

function snap(state: CaseRunState, rowState: CaseRunState, startedAt: string | null): CaseSnapshot {
  return {
    hydrated: true,
    run: { state, rowState, label: "Running", terminal: false, recoveryReason: null, recoveredAt: null, startedAt, heartbeatAt: null },
  } as unknown as CaseSnapshot;
}

const PREVIOUS_RUN = "2026-08-09T03:15:00.000Z";

describe("CaseStatusPill elapsed", () => {
  it("does not measure a new stream from the previous run's start (the 1865h bug)", () => {
    render(<CaseStatusPill snapshot={snap("running", "completed", PREVIOUS_RUN)} />);
    const pill = screen.getByText(/Analyzing/);
    expect(pill.textContent).toBe("Analyzing");
  });

  it("shows elapsed once the row itself reports the run as running", () => {
    const startedAt = new Date(Date.now() - 42_000).toISOString();
    render(<CaseStatusPill snapshot={snap("running", "running", startedAt)} />);
    expect(screen.getByText(/Analyzing · \d+s/)).toBeTruthy();
  });

  it("never invents an interval without a start marker", () => {
    render(<CaseStatusPill snapshot={snap("running", "running", null)} />);
    expect(screen.getByText(/Analyzing/).textContent).toBe("Analyzing");
  });
});
