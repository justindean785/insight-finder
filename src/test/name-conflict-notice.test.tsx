import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NameConflictNotice } from "@/components/workspace/NameConflictNotice";
import { detectNameConflict, nameConflictParts } from "@/lib/name-conflict";

afterEach(cleanup);

const rows = [
  { kind: "name", value: "Jordan Vale", source: "user_provided", metadata: null },
  { kind: "name", value: "Jordan Ames", source: "oathnet_lookup", metadata: null },
  { kind: "name", value: "Jordan Ames", source: "rapidapi_breach_search", metadata: null },
  { kind: "name", value: "Jordan Q. Vale Jr.", source: "exa_search", metadata: null },
];

describe("NameConflictNotice", () => {
  const conflict = detectNameConflict(rows)!;

  it("lists the contradicting variants and picks no surname", () => {
    render(<NameConflictNotice conflict={conflict} onOpen={vi.fn()} />);
    const el = screen.getByTestId("name-conflict");
    expect(el.textContent).toContain("You supplied “Jordan Vale”");
    expect(el.textContent).toContain("“Jordan Ames” · 2 rows · oathnet_lookup, rapidapi_breach_search");
    expect(el.textContent).toContain("Nothing in this case settles which surname is right");
    // The matching-surname row is not a conflict, so it must not be listed.
    expect(el.textContent).not.toContain("Q. Vale");
  });

  it("opens the Evidence tab on click", () => {
    const onOpen = vi.fn();
    render(<NameConflictNotice conflict={conflict} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Open Evidence/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("nameConflictParts pluralises and never says 'different people'", () => {
    const parts = nameConflictParts(conflict);
    expect(parts.headline).toContain("A record gives");
    expect(JSON.stringify(parts).toLowerCase()).not.toContain("different people");
  });

  it("no notice when no analyst-supplied name anchors a conflict", () => {
    expect(detectNameConflict(rows.slice(1))).toBeNull();
  });
});
