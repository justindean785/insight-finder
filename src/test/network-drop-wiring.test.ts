import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Wiring guard for the network-drop branch in ChatWindow's `useChat.onError`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. The decision itself —
 * `isNetworkDropError(e)` and `isRunHeartbeatAlive(heartbeat)` — is driven
 * behaviourally against real inputs in `transport-errors.test.ts` and
 * `stale-thread.test.ts`. What those cannot reach is the ORDERING and the
 * CHOICE OF COLUMN inside a 2,500-line component: that the branch runs before
 * the messages INSERT rather than after it, and that liveness is read from
 * `last_heartbeat_at` rather than from `status`. Those are the two ways this
 * fix silently becomes wrong again, and both are structural, so they are pinned
 * structurally. This is a source-text assertion, the same approach
 * `catalog-guidance.test.ts` and the edge suite's `reviews_wiring_test.ts` use.
 *
 * The specific regression it guards: reading `status === "active"` as proof of
 * life. That is the column default a blank thread is born with and the state a
 * CPU-killed isolate leaves behind, so a fix built on it tells the analyst a
 * DEAD run is "still running in the background" — trading one lie for another.
 */
const SRC = fs.readFileSync(
  path.resolve(__dirname, "../components/ChatWindow.tsx"),
  "utf8",
);

/**
 * Strip comments. The NEGATIVE assertions below are about what the code DOES,
 * and the code is commented with prose explaining why `status === "active"` is
 * not proof of life — which the raw text would match. Asserting over comments
 * would fail on the explanation of the very rule being enforced.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The body of useChat's onError handler, where the ordering matters. */
function onErrorBody(): string {
  const start = SRC.indexOf("onError: async (e) => {");
  expect(start, "onError handler not found — did the useChat config move?").toBeGreaterThan(-1);
  const insert = SRC.indexOf('await supabase.from("messages").insert({', start);
  expect(insert, "the failed-marker insert not found inside onError").toBeGreaterThan(-1);
  return SRC.slice(start, insert);
}

describe("network-drop branch wiring in ChatWindow.onError", () => {
  it("consults the drop predicate BEFORE persisting the failed-run marker", () => {
    // Everything returned by onErrorBody() precedes the insert by construction.
    expect(onErrorBody()).toContain("isNetworkDropError(e)");
  });

  it("decides liveness from last_heartbeat_at, never from the status column", () => {
    const body = onErrorBody();
    expect(body).toContain("last_heartbeat_at");
    expect(body).toContain("isRunHeartbeatAlive(");
    // The negative half, and the load-bearing one.
    const code = stripComments(body);
    expect(code).not.toMatch(/status\s*===\s*["']active["']/);
    expect(code).not.toContain("isActiveThreadStatus");
  });

  it("returns out of the handler on a live run, so no marker is written", () => {
    const body = onErrorBody();
    const guard = body.indexOf("isRunHeartbeatAlive(");
    expect(body.slice(guard)).toContain("return;");
  });

  it("re-arms the fail guard when it declines to record, so a later real failure still lands", () => {
    const body = onErrorBody();
    const guard = body.indexOf("isRunHeartbeatAlive(");
    expect(body.slice(guard)).toContain("failSavedRef.current = false");
  });

  it("suppresses the live FailedRunCard for a drop over a live run", () => {
    // useChat keeps `error` set for the dropped fetch whatever onError decided,
    // so without this gate the analyst sees a "still running" toast and a red
    // failure card with a Retry that would start a SECOND concurrent run.
    expect(SRC).toContain("!networkDropWhileAlive && !hasPersistedFailure(messages)");
  });

  it("clears the suppression on the next turn", () => {
    expect(SRC).toContain("markDropSuppressed(null)");
  });

  // ── Added with the durability fix. Both are ORDERING facts, which is what a
  // source-level test can see and a render test cannot: the behavioural half
  // lives in `network-drop-suppression.test.tsx`, which drives the real
  // component and kills a mutant for each of these.

  it("claims the suppression BEFORE the liveness read, not after it", () => {
    // The SDK calls onError WITHOUT awaiting it and writes status:"error" on
    // the next line. A suppression claimed after the await therefore lands a
    // whole network round-trip late, and the red card with its Retry paints for
    // that entire window over a run that is still alive.
    const body = onErrorBody();
    const claim = body.indexOf("markDropSuppressed(e)");
    const read = body.indexOf("await supabase");
    expect(claim, "the suppression claim is missing from the drop branch").toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(read);
  });

  it("REMOVES the SDK error on a proven-live run instead of only hiding it", () => {
    // Hiding is only as durable as the component state doing the hiding.
    // Clearing is as durable as the SDK store itself, whatever its lifetime.
    const body = onErrorBody();
    const guard = body.indexOf("isRunHeartbeatAlive(");
    expect(body.slice(guard)).toContain("clearErrorRef.current()");
  });

  it("keys the render gate on the error's IDENTITY, so it cannot outlive it", () => {
    // A bare boolean keeps suppressing after `error` has moved on to a genuine
    // fault. The derived comparison expires the exemption on the very render
    // the error changes or clears.
    const code = stripComments(SRC);
    expect(code).toMatch(
      /const networkDropWhileAlive\s*=\s*\n?\s*suppressedDropError !== null && suppressedDropError === error;/,
    );
  });
});
