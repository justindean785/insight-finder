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
    expect(SRC).toContain("setNetworkDropWhileAlive(false)");
  });
});
