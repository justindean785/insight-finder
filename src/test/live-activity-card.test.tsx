// live-activity-card.test.tsx — the firehose is collapsed, not discarded.
//
// The complaint this answers: during a run, every tool invocation rendered as its
// own card, faster than an analyst could read them. Worse, the cards could not
// even be grouped while live — `deriveToolRuntime` reads `stage`/`cycle_id` off a
// tool part's OUTPUT, and a pending call has none, so every in-flight call lands
// in the same bucket.
//
// These assert the two halves that make the fix trustworthy: the summary line says
// who is working on what, and NOTHING is hidden — the detail is one click away.
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { UIMessage } from "ai";
import { LiveActivityCard, MessageView } from "@/components/ChatWindow";

afterEach(cleanup);

const toolPart = (name: string, state: string, output?: unknown) => ({
  type: `tool-${name}`,
  state,
  input: {},
  ...(output === undefined ? {} : { output }),
});

const msg = (parts: unknown[]): UIMessage =>
  ({ id: "m1", role: "assistant", parts } as unknown as UIMessage);

describe("LiveActivityCard", () => {
  it("names the role and action of the call still in flight", () => {
    // A settled call followed by a pending one: the label must track the PENDING
    // work, or it narrates something that already finished.
    const { container } = render(
      <LiveActivityCard
        message={msg([
          toolPart("minimax_web_search", "output-available", { ok: true }),
          toolPart("minimax_correlate", "input-available"),
        ])}
        elapsedLabel="2:14"
      />,
    );
    const summary = container.querySelector("summary")!;
    expect(summary.textContent).toContain("Lead Analyst");
    expect(summary.textContent).toContain("Correlating");
    expect(summary.textContent).not.toContain("Gathering public-source leads");
  });

  it("falls back to the last call so the label never blanks between steps", () => {
    // Between a result landing and the next call starting there is no in-flight
    // part. Blanking there makes the run look stalled when it is not.
    const { container } = render(
      <LiveActivityCard
        message={msg([toolPart("minimax_web_search", "output-available", { ok: true })])}
        elapsedLabel="0:31"
      />,
    );
    expect(container.querySelector("summary")!.textContent).toContain("Data Hunter");
  });

  it("reads as working with no tool call yet, rather than as empty", () => {
    const { container } = render(<LiveActivityCard message={msg([])} elapsedLabel="0:02" />);
    const summary = container.querySelector("summary")!;
    expect(summary.textContent).toContain("Analyst");
    expect(summary.textContent).toContain("0:02");
    // No tool count is claimed when there are no tools.
    expect(summary.textContent).not.toMatch(/\b0 tools?\b/);
  });

  it("counts the tools and shows elapsed time on one line", () => {
    const { container } = render(
      <LiveActivityCard
        message={msg([
          toolPart("minimax_web_search", "output-available", { ok: true }),
          toolPart("username_sweep", "output-available", { ok: true }),
          toolPart("breach_check", "input-available"),
        ])}
        elapsedLabel="1:07"
      />,
    );
    const summary = container.querySelector("summary")!.textContent ?? "";
    expect(summary).toContain("3 tools");
    expect(summary).toContain("1:07");
  });

  it("is COLLAPSED by default — that is the whole point", () => {
    const { container } = render(
      <LiveActivityCard
        message={msg([toolPart("breach_check", "input-available")])}
        elapsedLabel="0:10"
      />,
    );
    expect(container.querySelector("details")!.hasAttribute("open")).toBe(false);
  });

  it("hides nothing — the detail is present and reachable", () => {
    // Collapsing must not mean discarding. jsdom renders <details> children
    // regardless of `open`, so asserting their presence proves the expanded view
    // carries the same cards rather than a summary that dropped them.
    const { container } = render(
      <LiveActivityCard
        message={msg([
          toolPart("minimax_web_search", "output-available", { ok: true }),
          toolPart("username_sweep", "output-available", { ok: true }),
        ])}
        elapsedLabel="0:44"
      />,
    );
    const body = container.querySelector(".chat-card__body") as HTMLElement;
    expect(body).toBeTruthy();
    // Both calls are still accounted for, by count AND by name — a summary that
    // silently dropped one would still render a plausible-looking row.
    const text = body.textContent ?? "";
    expect(text).toContain("2 calls");
    expect(text).toContain("2 completed");
    // Named by the cycle's purpose line (run-timeline.ts describeCycle): the
    // concise label for each tool, never a raw tool id.
    expect(text).toContain("public-source search");
    expect(text).toContain("username sweep");
    expect(text).not.toMatch(/minimax_web_search|username_sweep/);
  });

  it("keeps the live region on the one-line label, never around the body", () => {
    // A live region wrapping the expandable body would re-announce the entire
    // tool list on every streamed part. And it must not be role="region": the
    // case-integrity e2e asserts no run-named region exists during a run.
    const { container } = render(
      <LiveActivityCard
        message={msg([toolPart("breach_check", "input-available")])}
        elapsedLabel="0:05"
      />,
    );
    const status = container.querySelector('[role="status"]')!;
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.closest("summary")).toBeTruthy();
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it("survives a null message without throwing", () => {
    const { container } = render(<LiveActivityCard message={null} elapsedLabel="0:00" />);
    expect(container.querySelector("summary")!.textContent).toContain("Analyst");
  });
});

describe("MessageView — the streaming message defers ALL its tool cards", () => {
  // Codex review, PR #587. The grouped block was suppressed while live, but a
  // SECOND render path — the fallback for a message whose groups were all
  // filtered as noise — had no live check. An all-skipped streaming cycle makes
  // `visibleToolGroups` empty, so the individual cards came back beside the
  // summary row, in exactly the case where the noise is highest.
  const skipped = (name: string) => ({
    type: `tool-${name}`,
    state: "output-available",
    input: {},
    output: { skipped: true, ok: false, error: "burst limit" },
  });

  const message = (parts: unknown[]): UIMessage =>
    ({ id: "m9", role: "assistant", parts } as unknown as UIMessage);

  it("renders no individual tool cards while live, even when every group is noise", () => {
    const parts = [skipped("socialfetch_lookup"), skipped("leakcheck_lookup")];
    const { container } = render(<MessageView m={message(parts)} live />);
    // The fallback renders a .chat-card per tool part; the live card is not in
    // this component at all, so anything here is the firehose coming back.
    expect(container.querySelectorAll(".chat-card").length).toBe(0);
  });

  it("still renders them once the run settles, so history is not lost", () => {
    const parts = [skipped("socialfetch_lookup"), skipped("leakcheck_lookup")];
    const { container } = render(<MessageView m={message(parts)} />);
    expect(container.querySelectorAll(".chat-card").length).toBeGreaterThan(0);
  });
});
