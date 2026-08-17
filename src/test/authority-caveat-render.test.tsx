import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AuthorityCaveat } from "@/components/ui/authority";

/**
 * The caveat line's chrome must match what the caveat SAYS.
 *
 * `AuthorityCaveat` renders the recorded reason a row is not stronger. Two very
 * different statements arrive here:
 *
 *   linkage — "we cannot show this belongs to the subject" (quarantine or a name
 *             collision). A cordon: neutral hue, unlink mark.
 *   status  — "this is contradicted / uncorroborated, and here is why". Not a
 *             cordon at all.
 *
 * It keyed on the row's winning STATE, so every contradicted row's explanation
 * of its contradiction was dressed as an unproven-linkage cordon — arguing with
 * the red Conflict chip and spine on the same row. (Cursor review, PR #462.)
 *
 * Asserted against the real component, not its source: a source grep would pass
 * on a component that throws on mount or never renders the icon.
 *
 * NOTE ON THE STRONGEST GUARANTEE HERE, which is not a test. `AuthorityCaveat`
 * no longer accepts `state` at all — its props are `caveatKind | caveat`. The
 * old bug is therefore unrepresentable rather than merely unasserted: keying on
 * the winning state again would not compile. These tests cover what the type
 * cannot, namely that the right kind produces the right chrome.
 */

const CORDON_CLASS = "text-[hsl(var(--authority-quarantine))]";

afterEach(cleanup);

function renderCaveat(view: Parameters<typeof AuthorityCaveat>[0]["view"]) {
  const { container } = render(<AuthorityCaveat view={view} />);
  const p = container.querySelector("p");
  return {
    p,
    cordoned: p?.className.includes(CORDON_CLASS) ?? false,
    hasUnlinkMark: !!container.querySelector("svg"),
  };
}

describe("AuthorityCaveat chrome follows the caveat kind", () => {
  it("a withheld-authority caveat renders as a cordon", () => {
    const r = renderCaveat({
      caveatKind: "linkage",
      caveat: "harvested from a name-only query — linkage to the subject is unproven",
    });
    expect(r.cordoned).toBe(true);
    expect(r.hasUnlinkMark).toBe(true);
  });

  it("a contradicted row's explanation is NOT dressed as a linkage cordon", () => {
    // The regression. This row's state is "conflict"; its caveat explains the
    // contradiction. Neutral grey + an unlink mark would tell the analyst the
    // opposite of what the Conflict chip beside it says.
    const r = renderCaveat({
      caveatKind: "status",
      caveat: "contradicts the seed's registered country",
    });
    expect(r.cordoned).toBe(false);
    expect(r.hasUnlinkMark).toBe(false);
    expect(r.p?.textContent).toContain("contradicts the seed");
  });

  it("renders nothing when there is no caveat", () => {
    const { container } = render(<AuthorityCaveat view={{ caveatKind: null, caveat: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it("the caveat text is always visible, never behind a disclosure", () => {
    // Disclosure, not deletion: a reason nobody can see is the original defect
    // with extra steps. No hidden/collapsed container, no title-only tooltip.
    const { container } = render(
      <AuthorityCaveat view={{ caveatKind: "linkage", caveat: "unproven linkage" }} />,
    );
    const p = container.querySelector("p")!;
    expect(p.hidden).toBe(false);
    expect(p.textContent).toContain("unproven linkage");
  });
});
