/**
 * Regression guard for the streamed-render throttle in `ChatWindow`.
 *
 * THE DEFECT. `useChat` swaps the streaming message object on EVERY token
 * delta. `messagePropsEqual` compares `prev.m === next.m`, so settled messages
 * are already skipped — but the LIVE message re-renders on every delta, and
 * `MarkdownBlock` is memoized on `content`, which also changes every token. So
 * the growing message re-parses its entire body through ReactMarkdown +
 * remarkGfm once per token: O(n^2) over the message, on the phone's main
 * thread. Measured 2026-09-19 across 663 production steps
 * (`orchestrator_step_metrics`), generation runs at ~13ms per output token
 * (~77 tok/s), so an unthrottled run asks mobile Safari for ~77 full re-parses
 * a second. That is what makes text stop mid-word and then arrive in a burst.
 *
 * WHY THIS FILE IS NOT A TAUTOLOGY. The first case pins the call site, which
 * catches a plain removal. The second is the one that matters: it MEASURES
 * that the installed SDK still consumes the option, rather than assuming it.
 * `experimental_throttle` is experimental and carries no runtime error when it
 * is unknown — the SDK destructures options and ignores what it does not
 * recognise. So an SDK upgrade that renames or drops it turns this fix into a
 * silently inert config key, the stutter returns, and nothing else in the
 * suite notices. That is this repo's documented recurring failure mode
 * (CLAUDE.md, "BUILT AND UNWIRED"), and it is exactly what case two fails on.
 *
 * Measured against `@ai-sdk/react@3.0.199`: `useChat` destructures
 * `experimental_throttle` into `throttleWaitMs`, hands it to
 * `~registerMessagesCallback`, and that wraps the messages-change callback in
 * `throttle()` (backed by `throttleit`). The throttled callback is the one
 * that drives React state, which is why this option and not a debounce in our
 * own code is the correct lever.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useChat } from "@ai-sdk/react";

// Same resolution as `network-drop-wiring.test.ts`, which reads this very file.
const CHAT_WINDOW_SRC = path.resolve(__dirname, "../components/ChatWindow.tsx");

/** Upper bound on the throttle interval. Above ~100ms a reader starts to
 *  perceive the stream as pausing rather than flowing, which would trade one
 *  visible defect for another. */
const MAX_PERCEIVED_CONTINUOUS_MS = 100;

describe("streamed-render throttle", () => {
  it("ChatWindow passes experimental_throttle to useChat, within the perceptual budget", () => {
    const src = fs.readFileSync(CHAT_WINDOW_SRC, "utf8");
    const match = src.match(/^\s*experimental_throttle:\s*(\d+)\s*,/m);

    expect(
      match,
      "ChatWindow must pass experimental_throttle to useChat — without it the live "
        + "message re-parses its whole markdown body once per streamed token",
    ).not.toBeNull();

    const ms = Number(match![1]);
    expect(ms).toBeGreaterThan(0);
    expect(
      ms,
      `a throttle of ${ms}ms is long enough for the analyst to read the stream as stalling`,
    ).toBeLessThanOrEqual(MAX_PERCEIVED_CONTINUOUS_MS);
  });

  it("the installed @ai-sdk/react still CONSUMES experimental_throttle", () => {
    // Function.prototype.toString over the shipped (unminified) build. If a
    // future SDK renames the option, our call site keeps type-checking and
    // keeps passing a key nobody reads — inert, not broken, and invisible.
    const source = useChat.toString();

    expect(
      source.includes("experimental_throttle"),
      "@ai-sdk/react's useChat no longer destructures experimental_throttle — the "
        + "throttle in ChatWindow is now a no-op. Find the option's replacement and "
        + "re-wire it; do not delete this test.",
    ).toBe(true);
  });
});
