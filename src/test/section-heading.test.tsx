import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeading } from "@/components/workspace/SectionHeading";

/** Case desk R6: one heading recipe for Overview, Activity and Report. */
describe("SectionHeading", () => {
  it("renders the title as the section's h2, the subtitle beneath, and the right slot", () => {
    render(<SectionHeading title="Investigation activity" subtitle="Outcomes first." right={<button type="button">Health</button>} />);
    expect(screen.getByRole("heading", { level: 2, name: "Investigation activity" })).toBeTruthy();
    expect(screen.getByText("Outcomes first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Health" })).toBeTruthy();
  });

  it("omits the subtitle line when none is given", () => {
    const { container } = render(<SectionHeading title="Case assessment" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});
