// @vitest-environment jsdom
/**
 * Workspace cleanup (JD, 2026-11-02): pivot runs render as a chip, echoed system
 * markers never reach the transcript, and the narrow-screen pivot block is a
 * compact strip with the full panel one tap away.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { MessageView } from "@/components/ChatWindow";
import { PivotStrip } from "@/components/pivots/PivotStrip";
import type { NextStepItem } from "@/components/pivots/NextSteps";

afterEach(cleanup);

const msg = (role: "user" | "assistant", text: string): UIMessage =>
  ({ id: `${role}-1`, role, parts: [{ type: "text", text }] }) as UIMessage;

describe("analyst pivot messages", () => {
  it("render as a chip with action and target, the full instruction behind a disclosure", () => {
    const text = "Run this pivot.\n\nAction: Review lead\nTarget: Darren Watkins Jr\nType: name\nReason: Name discovered via breach/profile lookup.\n\nUse authorized public-source methods only. Return corroborating sources and how this changes the case.";
    const { container } = render(<MessageView m={msg("user", text)} />);
    const chip = container.querySelector("[data-pivot-run]")!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toMatch(/Review lead/);
    expect(chip.textContent).toMatch(/Darren Watkins Jr/);
    const details = chip.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toMatch(/Use authorized public-source methods only/);
  });

  it("ordinary analyst text is unchanged", () => {
    const { container } = render(<MessageView m={msg("user", "investigate jordan@example.test")} />);
    expect(container.querySelector("[data-pivot-run]")).toBeNull();
    expect(container.textContent).toMatch(/investigate jordan@example.test/);
  });
});

describe("agent replies", () => {
  it("never show the model-facing HISTORICAL MODEL OUTPUT label", () => {
    const label = "[HISTORICAL MODEL OUTPUT — an earlier assistant turn in this conversation. It is not independent evidence: treat its claims as unverified unless a recorded artifact or an analyst decision backs them.]\n\n";
    const { container } = render(<MessageView m={msg("assistant", `${label}Name pivot. Running the name-corpus sweep.`)} />);
    expect(container.textContent).not.toMatch(/HISTORICAL MODEL OUTPUT/);
    expect(container.textContent).toMatch(/Running the name-corpus sweep/);
  });
});

function pivotItem(key: string, target: string, targetType = "username"): NextStepItem {
  return {
    kind: "pivot",
    key,
    validation: {
      status: "valid",
      pivot: {
        id: key, priority: "high", action: "Verify username linkage", target, targetType,
        reason: "r", sourceArtifactIds: [], basis: "artifact", prompt: "p", status: "new",
      },
    },
    eligibility: null,
  } as NextStepItem;
}

describe("PivotStrip", () => {
  const items = [pivotItem("k1", "alpha"), pivotItem("k2", "bravo"), pivotItem("k3", "charlie"), pivotItem("k4", "delta")];

  it("shows at most three compact rows and hides the full panel until asked", () => {
    render(
      <PivotStrip items={items} expanded={false} onExpandedChange={() => {}} onPreview={() => {}}>
        <div data-testid="full-panel" />
      </PivotStrip>,
    );
    expect(screen.getAllByRole("button", { name: /Preview pivot/ })).toHaveLength(3);
    expect(screen.queryByTestId("full-panel")).toBeNull();
    expect(screen.getByText(/Next pivots · 4/)).toBeTruthy();
  });

  it("Preview opens the full panel on that pivot instead of running it", () => {
    const onPreview = vi.fn();
    render(
      <PivotStrip items={items} expanded={false} onExpandedChange={() => {}} onPreview={onPreview}>
        <div />
      </PivotStrip>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Preview pivot: Verify username linkage bravo/ }));
    expect(onPreview).toHaveBeenCalledWith("k2");
  });

  it("renders the full panel when expanded", () => {
    render(
      <PivotStrip items={items} expanded onExpandedChange={() => {}} onPreview={() => {}}>
        <div data-testid="full-panel" />
      </PivotStrip>,
    );
    expect(screen.getByTestId("full-panel")).toBeTruthy();
  });

  it("with nothing runnable, shows one quiet line", () => {
    render(
      <PivotStrip items={[]} expanded={false} onExpandedChange={() => {}} onPreview={() => {}}>
        <div />
      </PivotStrip>,
    );
    expect(screen.getByText("No new pivots to run.")).toBeTruthy();
  });
});
