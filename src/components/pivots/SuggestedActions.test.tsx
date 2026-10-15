import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuggestedActions } from "./SuggestedActions";

describe("suggested actions workspace tray", () => {
  it("requires opening, then previewing, then explicit dispatch", () => {
    const onRunAction = vi.fn();
    render(<SuggestedActions items={[{ kind: "action", key: "summary", title: "Summarize findings", detail: "Review the case", prompt: "Summarize this case" }]} onRunAction={onRunAction} onRunPivot={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Next steps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Suggested actions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run Summarize findings" }));
    expect(onRunAction).not.toHaveBeenCalled();
    expect(screen.getByText("This starts a new agent run on the case")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onRunAction).toHaveBeenCalledExactlyOnceWith("Summarize this case");
    expect(screen.queryByRole("region", { name: "Next steps" })).toBeNull();
  });
});
