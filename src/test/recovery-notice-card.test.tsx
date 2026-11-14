// recovery-notice-card.test.tsx — the interrupted-run notice renders as its own
// status card: always open, labelled as an interruption, never as agent
// analysis and never as a superseded report.
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { UIMessage } from "ai";
import { MessageView } from "@/components/ChatWindow";
import { RECOVERY_NOTICE_HEADINGS } from "@/lib/superseded-reports";

afterEach(cleanup);

const assistant = (text: string): UIMessage =>
  ({ id: "m1", role: "assistant", parts: [{ type: "text", text }] } as unknown as UIMessage);

const HEARTBEAT = "Last heartbeat: 2026-10-31T09:14:02.000Z.";
const NOTICE = [
  RECOVERY_NOTICE_HEADINGS[0],
  "",
  "The investigation for **jane@example.com** was interrupted before the agent could write its closing response. **This is not a findings report.** The rows below are whatever was already durably written when the run stopped, presented as-is.",
  HEARTBEAT,
  "",
  "### Recovery summary",
  "0 recovered rows: 0 model-reviewed, 0 unreviewed.",
].join("\n");

const REPORT = "## Findings report\n\n| Finding | Confidence |\n| --- | --- |\n| name | 50 |";

describe("interrupted-run notice card", () => {
  it("renders open, labelled as an interruption, with its wording intact", () => {
    const { container } = render(<MessageView m={assistant(NOTICE)} />);
    const card = container.querySelector("[data-recovery-notice]");
    expect(card).not.toBeNull();
    expect(card!.tagName).not.toBe("DETAILS");
    expect(card!.closest("details")).toBeNull();
    expect(card!.querySelector(".chat-card__header")!.textContent).toContain("Interrupted run");
    expect(card!.textContent).toContain("This is not a findings report.");
    expect(card!.textContent).toContain(HEARTBEAT);
    // It is the sweep's text, not the model's.
    expect(container.textContent).not.toContain("AI analysis");
    expect(container.querySelector('[aria-label="Agent response"]')).toBeNull();
  });

  it("stays that card even if the caller marks it superseded", () => {
    const { container } = render(<MessageView m={assistant(NOTICE)} superseded />);
    expect(container.querySelector("[data-recovery-notice]")).not.toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Superseded report");
  });

  it("still collapses an ordinary superseded report", () => {
    const { container } = render(<MessageView m={assistant(REPORT)} superseded />);
    expect(container.querySelector("[data-recovery-notice]")).toBeNull();
    const details = container.querySelector("details.chat-card");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(details!.textContent).toContain("Superseded report");
  });

  it("re-renders an unchanged report when it becomes superseded", () => {
    const m = assistant(REPORT);
    const { container, rerender } = render(<MessageView m={m} />);
    expect(container.querySelector('[aria-label="Agent response"]')).not.toBeNull();
    rerender(<MessageView m={m} superseded />);
    expect(container.textContent).toContain("Superseded report");
  });
});
