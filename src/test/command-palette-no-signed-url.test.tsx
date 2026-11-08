import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The command palette printed `threads.seed_value` as each case's hint. For a case
 * started from an upload that value is the composer's "Attached files:" markdown,
 * whose link is a 7-day SIGNED storage URL — a capability URL with its token — so
 * the token landed in the palette's DOM on a surface that is screenshotted and
 * screen-shared. (#983 claims "no token= anywhere on the page".) Values are synthetic.
 */

const SIGNED = "https://proj.storage.example/storage/v1/object/sign/attachments/u1/c1/scan-notes.pdf?token=SYNTHETICTOKEN123";
const ATTACHMENT_ONLY = `Attached files:\n- [scan-notes.pdf](${SIGNED}) (application/pdf, 40 KB)`;
const TEXT_PLUS_UPLOAD = `Check handle ghostfox_42\n\nAttached files:\n- [scan-notes.pdf](${SIGNED}) (application/pdf, 40 KB)`;

let rows: { id: string; title: string; seed_value: string | null; updated_at: string }[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }),
    }),
  },
}));

import { CommandPalette } from "@/components/CommandPalette";

async function openPalette(): Promise<string> {
  render(<MemoryRouter><CommandPalette /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Untitled|Attachment|Case (Bravo|Charlie)/i));
  return document.body.innerHTML + "\n" + document.body.textContent;
}

// jsdom has no scrollIntoView; cmdk calls it when an item is selected.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => { rows = []; });

describe("command palette hint never carries a signed storage URL", () => {
  it("upload-only case: label names the file; no token or storage path anywhere in the palette", async () => {
    rows = [{ id: "t1", title: ATTACHMENT_ONLY.slice(0, 80), seed_value: ATTACHMENT_ONLY, updated_at: "2026-11-07T00:00:00Z" }];
    const out = await openPalette();
    expect(out).toContain("Attachment: scan-notes.pdf");
    expect(out).not.toContain("token=");
    expect(out).not.toContain("storage/v1");
    expect(out).not.toContain("SYNTHETICTOKEN123");
  });

  it("typed text above an upload: the hint is the typed text, not the signed link", async () => {
    rows = [{ id: "t2", title: "Case Bravo", seed_value: TEXT_PLUS_UPLOAD, updated_at: "2026-11-07T00:00:00Z" }];
    const out = await openPalette();
    expect(out).toContain("ghostfox_42");
    expect(out).not.toContain("token=");
    expect(out).not.toContain("storage/v1");
  });

  it("an ordinary seed still shows as the hint (behaviour that must not change)", async () => {
    rows = [{ id: "t3", title: "Case Charlie", seed_value: "subject@mail.example", updated_at: "2026-11-07T00:00:00Z" }];
    const out = await openPalette();
    expect(screen.getByRole("dialog").textContent).toContain("subject@mail.example");
    expect(out).toContain("Case Charlie"); // the title alone must not be what satisfies the line above
  });
});
