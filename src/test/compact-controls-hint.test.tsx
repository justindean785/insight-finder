import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompactFilter } from "@/components/ui/compact-controls";

// An inline chip's hint used to reach only the overflow menu, so a hint written for a chip
// that is shown inline (the Evidence board's "Needs review") was never visible to anyone.
describe("CompactFilter inline chips", () => {
  const options = [
    { key: "a", label: "Alpha", count: 3, hint: "What Alpha counts" },
    { key: "b", label: "Beta", count: 1 },
  ];

  it("exposes an option's hint as the chip's title", () => {
    render(<CompactFilter label="Filter" options={options} primary={["a", "b"]} active="a" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute("title", "What Alpha counts");
  });

  it("leaves a chip without a hint untitled", () => {
    render(<CompactFilter label="Filter" options={options} primary={["a", "b"]} active="a" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Beta/ })).not.toHaveAttribute("title");
  });
});
