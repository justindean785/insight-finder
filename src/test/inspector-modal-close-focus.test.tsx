import { fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import {
  useOptionalWorkspaceUIState,
} from "@/hooks/useWorkspaceUIState";

/**
 * D-B regression: on the ArtifactDrawer modal path (below xl=1280, where the
 * Workbench inline panel is CSS-hidden), closing the drawer must route through
 * the provider's `clear()` so the opener row regains focus. Previously
 * `handleSelect(null)` cleared local state only, and Radix Sheet left focus on
 * a stray button inside the panel — which disappears on close, dropping focus
 * to <body>.
 *
 * This test reproduces the EXACT handleSelect wiring in ResourcesPanel's
 * EvidenceBoard without the Supabase/graph plumbing: a row click calls
 * `ui.select` + `ui.rememberOpener`, a drawer-close calls `handleSelect(null)`
 * which now also calls `ui.clear()`.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

type MockArtifact = { id: string };

/**
 * Mirrors the shape of EvidenceBoard's handleSelect / drawer wiring in
 * src/components/ResourcesPanel.tsx: a local `selected` for the drawer, plus
 * `ui.clear()` on null to restore focus via the provider's openerElementId.
 */
function DrawerBoard() {
  const [selected, setSelected] = useState<MockArtifact | null>(null);
  const ui = useOptionalWorkspaceUIState();

  const handleSelect = useCallback((a: MockArtifact | null) => {
    setSelected(a);
    if (!ui) return;
    if (a) {
      ui.rememberOpener(`evidence-row-${a.id}`);
      ui.select(a.id);
    } else {
      // D-B fix: route the modal-close path through the provider.
      ui.clear();
    }
  }, [ui]);

  return (
    <div>
      <button
        id="evidence-row-r1"
        onClick={() => handleSelect({ id: "r1" })}
      >
        Row r1
      </button>
      <button
        id="evidence-row-r2"
        onClick={() => handleSelect({ id: "r2" })}
      >
        Row r2
      </button>
      {selected && (
        <div role="dialog" aria-label="Evidence detail">
          <span>Drawer for {selected.id}</span>
          <button aria-label="Close drawer" onClick={() => handleSelect(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

describe("ArtifactDrawer modal-close path — D-B", () => {
  it("closing the drawer returns focus to the opener row (provider path)", async () => {
    render(
      <WorkspaceUIStateProvider>
        <DrawerBoard />
      </WorkspaceUIStateProvider>,
    );

    const row = screen.getByText("Row r1") as HTMLButtonElement;
    row.focus();
    fireEvent.click(row);

    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close drawer"));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Focus restoration deferred one microtask.
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(document.activeElement?.id).toBe("evidence-row-r1");
  });

  it("after switching rows, closing returns focus to the most recent opener", async () => {
    render(
      <WorkspaceUIStateProvider>
        <DrawerBoard />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Row r1"));
    fireEvent.click(screen.getByText("Row r2"));
    expect(screen.getByText("Drawer for r2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close drawer"));
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(document.activeElement?.id).toBe("evidence-row-r2");
  });

  it("standalone render (no provider) is a no-op on close — nothing throws", () => {
    expect(() =>
      render(<DrawerBoard />),
    ).not.toThrow();

    fireEvent.click(screen.getByText("Row r1"));
    fireEvent.click(screen.getByLabelText("Close drawer"));
    // The drawer path works without the provider too (ResourcesPanel also
    // mounts standalone in older surfaces).
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * D-A regression guard: the Sheet width class is already fluid
 * (`w-[min(92vw,460px)]`), so at every supported width the drawer fits.
 * Rather than mount Radix (which depends on real layout the jsdom runtime
 * can't compute), lock the Tailwind class string in a unit test so a future
 * refactor can't silently regress to a fixed width.
 */
describe("ArtifactDrawer width class — D-A guard", () => {
  it("drawer width in ResourcesPanel is viewport-aware (unit-locked)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(
      process.cwd(),
      "src/components/ResourcesPanel.tsx",
    );
    const src = await fs.readFile(file, "utf8");
    // Must include a fluid class capping width — not a bare width.
    expect(src).toContain('w-[min(92vw,460px)]');
    // And must NOT re-introduce a fixed `w-[460px]` that would overflow narrow
    // viewports.
    expect(src).not.toMatch(/\sw-\[460px\]/);
  });
});
