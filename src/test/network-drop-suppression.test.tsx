/**
 * BEHAVIOURAL lifecycle regression for the network-drop suppression in
 * `ChatWindow`. Mounts the real component, drives the real `useChat` store and
 * the real `DefaultChatTransport`, and asserts on what the analyst can actually
 * see and click.
 *
 * Why this file exists alongside `network-drop-wiring.test.ts`: that one is a
 * source-text assertion. It pins the ORDERING and the CHOICE OF COLUMN, and it
 * cannot observe a single frame of what renders. The two defects this file
 * covers are both invisible to it —
 *
 *   1. the failure card painting during the async liveness read, and
 *   2. an error outliving the component state that was hiding it
 *
 * — because in source both look exactly like a correct implementation.
 *
 * MEASURED SDK BEHAVIOUR, 2026-09-07, `@ai-sdk/react@3.0.199`. `useChat`
 * constructs its `Chat` in a `useRef`, so the store — messages, status AND
 * error — is per-mount and dies with the component. There is no module-level
 * store keyed by `id`. The comment in `ChatWindow` describing a surviving store
 * dates from an older SDK. `sdk store lifetime` below MEASURES this rather than
 * assuming it, so an SDK upgrade that reintroduces a shared store fails here
 * loudly instead of silently restoring the defect.
 *
 * That measurement is also why suppression is not enough on its own and the fix
 * calls `clearError()`: hiding an error is only as durable as the thing doing
 * the hiding, whereas removing it from the SDK's own store is as durable as
 * that store, whatever lifetime a future version gives it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";

// ── Test doubles ────────────────────────────────────────────────────────────
// Only the process boundaries are faked: the network, the auth session, the
// router and the toaster. Every decision under test — the drop predicate, the
// heartbeat bar, the suppression, the render gate — runs as shipped.

const hoisted = vi.hoisted(() => ({
  /** What the next stream attempt throws. */
  nextTransportError: null as Error | null,
  /** What `threads.last_heartbeat_at` reports for the liveness read. */
  heartbeat: null as string | null,
  /** Rows written to `messages` — a persisted `__STATUS__:failed:` marker here
   *  is the durable half of the defect #545 fixed. */
  insertedMessages: [] as Record<string, unknown>[],
  /** Live `error` from the real SDK store, sampled every render. Lets us prove
   *  the error was REMOVED rather than merely hidden. */
  lastSdkError: undefined as Error | undefined,
  clearErrorCalls: 0,
  /** Transport attempts — proves a run actually reached the network. */
  transportCalls: 0,
  /** ChatWindow's own onError, counted on ENTRY and on COMPLETION. The async
   *  liveness read makes those two different moments, and the gap between them
   *  is precisely the window this fix closes. */
  onErrorEntered: 0,
  onErrorSettled: 0,
  /** When set, the last_heartbeat_at read PARKS here until released. Lets the
   *  test look at the screen while the liveness question is still open. */
  heartbeatGate: null as null | Promise<void>,
  releaseHeartbeat: null as null | (() => void),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "analyst@test.local" },
    session: { access_token: "t" },
    loading: false,
    error: null,
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: () => {},
    warning: () => {},
    success: () => {},
    message: () => {},
    info: () => {},
    dismiss: () => {},
  }),
}));

// The transport's fetch. Throwing here is exactly how a dropped connection
// reaches `useChat.onError` in a browser.
vi.mock("@/lib/fetch-retry", () => ({
  fetchWithRetry: async () => {
    hoisted.transportCalls += 1;
    throw hoisted.nextTransportError ?? new Error("Load failed");
  },
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    let columns = "";
    const self = () => chain;
    for (const m of ["eq", "in", "order", "limit", "gt", "lt", "gte", "lte", "neq", "is", "not", "or", "filter", "match", "contains", "range"]) {
      chain[m] = self;
    }
    chain.select = (cols?: string) => {
      if (typeof cols === "string") columns = cols;
      return chain;
    };
    chain.maybeSingle = async () => {
      if (table !== "threads") return { data: null, error: null };
      // Only the LIVENESS read parks. The mount-time existence check
      // (`select("id")`) must not, or the component never finishes loading.
      if (columns.includes("last_heartbeat_at") && hoisted.heartbeatGate) {
        await hoisted.heartbeatGate;
      }
      return { data: { id: "t", last_heartbeat_at: hoisted.heartbeat }, error: null };
    };
    chain.single = chain.maybeSingle;
    chain.insert = async (row: Record<string, unknown>) => {
      if (table === "messages") hoisted.insertedMessages.push(row);
      return { data: null, error: null };
    };
    chain.update = () => chain;
    chain.upsert = async () => ({ data: null, error: null });
    chain.delete = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return chain;
  };
  return {
    SUPABASE_URL: "https://test.local",
    SUPABASE_PROJECT_ID: "test",
    hasSupabaseEnv: true,
    supabaseConfigError: null,
    supabase: {
      from: (table: string) => builder(table),
      rpc: async () => ({ data: null, error: null }),
      channel: () => {
        const ch: Record<string, unknown> = {};
        ch.on = () => ch;
        ch.subscribe = () => ch;
        ch.unsubscribe = () => Promise.resolve("ok");
        return ch;
      },
      removeChannel: () => Promise.resolve("ok"),
      auth: {
        getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }),
        getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
      storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) },
    },
  };
});

/**
 * Observation-only wrapper over the REAL `useChat`. It delegates entirely — the
 * Chat instance, the transport, the onError dispatch and the error state are
 * all the shipped implementation. It exists so the test can read back the SDK's
 * own `error`, which is the only way to tell "hidden" from "removed" (both look
 * identical in the DOM), and to count `clearError` calls.
 */
vi.mock("@ai-sdk/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/react")>();
  return {
    ...actual,
    // `UseChatOptions` is a union: the `{ chat }` arm carries no callbacks, so
    // the shipped `onError` is only reachable on the other arm. ChatWindow uses
    // the `{ id, transport, onError }` arm, which this narrows to.
    useChat: (options: Parameters<typeof actual.useChat>[0] & {
      onError?: (error: Error) => void | Promise<void>;
    }) => {
      const shipped = options?.onError;
      const api = actual.useChat({
        ...options,
        // Delegates to ChatWindow's handler untouched; only brackets it, so the
        // test can wait for the async liveness read to finish instead of
        // guessing a microtask count.
        onError: async (e: Error) => {
          hoisted.onErrorEntered += 1;
          try {
            await shipped?.(e);
          } finally {
            hoisted.onErrorSettled += 1;
          }
        },
      });
      hoisted.lastSdkError = api.error;
      return {
        ...api,
        clearError: () => {
          hoisted.clearErrorCalls += 1;
          api.clearError();
        },
      };
    },
  };
});

const { ChatWindow } = await import("@/components/ChatWindow");

const THREAD_A = "aaaaaaaa-1111-4111-8111-111111111111";
const THREAD_B = "bbbbbbbb-2222-4222-8222-222222222222";

const freshHeartbeat = () => new Date().toISOString();
const staleHeartbeat = () => new Date(Date.now() - 10 * 60_000).toISOString();

/** Everything the analyst must not see while a dropped connection is being
 *  treated as harmless. The Retry button is the dangerous half: it starts a
 *  SECOND concurrent run against a thread the server is still working. */
function failureCardVisible(): boolean {
  return screen.queryByText("Investigation run failed") !== null;
}
function retryVisible(): boolean {
  return screen.queryByRole("button", { name: /retry investigation/i }) !== null;
}

/** ChatWindow gates on an async thread load before the composer exists. */
async function awaitComposer(): Promise<HTMLTextAreaElement> {
  await waitFor(() =>
    expect(
      screen.getByLabelText(/investigation request|message this case/i),
    ).toBeTruthy(),
  );
  return screen.getByLabelText(/investigation request|message this case/i) as HTMLTextAreaElement;
}

/** Drive a real run to its transport failure through the real send path. */
async function runAndFail(seed: string) {
  const box = await awaitComposer();
  await act(async () => {
    fireEvent.change(box, { target: { value: seed } });
  });
  // A first message starts the case; a later one on the same mount is a
  // follow-up, whose primary reads "Send" (lib/composer-primary.ts).
  const send = screen.getByRole("button", { name: /^(start investigation|send)$/i }) as HTMLButtonElement;
  // Guard against a vacuous pass: a disabled button means the composer never
  // took the seed, so no run starts and every "card absent" assertion below
  // would hold for the wrong reason.
  expect(send.disabled, "send button disabled — the seed never reached the composer").toBe(false);
  const wantTransport = hoisted.transportCalls + 1;
  const wantSettled = hoisted.onErrorSettled + 1;
  await act(async () => {
    send.click();
  });
  // Two positive signals, so no assertion below can pass because nothing ran.
  await waitFor(() => expect(hoisted.transportCalls).toBe(wantTransport));
  await waitFor(() => expect(hoisted.onErrorSettled).toBe(wantSettled));
}

beforeEach(() => {
  hoisted.nextTransportError = null;
  hoisted.heartbeat = null;
  hoisted.insertedMessages = [];
  hoisted.lastSdkError = undefined;
  hoisted.clearErrorCalls = 0;
  hoisted.transportCalls = 0;
  hoisted.onErrorEntered = 0;
  hoisted.onErrorSettled = 0;
  hoisted.heartbeatGate = null;
  hoisted.releaseHeartbeat = null;
  // The stuck-run sweeper hits `?health=1` with global fetch directly, not the
  // transport. Answer it "deployed and ready"; the drop under test is produced
  // by the transport mock above.
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => JSON.stringify({ ok: true }),
  }));
});

afterEach(() => {
  cleanup();
});

describe("network-drop suppression — lifecycle", () => {
  it("MEASURES the SDK store lifetime the suppression must match", async () => {
    // Not an assumption — the durability argument rests on this, so it is
    // measured through the real hook. In `@ai-sdk/react@3.0.199` `useChat`
    // builds its `Chat` in a `useRef`, so an error does NOT survive a remount
    // of the same id. If a future SDK reintroduces a module-level store keyed
    // by id, this flips to "ERR:…" and fails loudly — at which point the
    // `clearError()` call below stops being belt-and-braces and becomes the
    // only thing holding the boundary. Either way the behaviour asserted in
    // the rest of this file is what ships.
    hoisted.heartbeat = null;              // dead run ⇒ nothing clears the error
    hoisted.nextTransportError = new Error("Load failed");
    const first = render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");
    await waitFor(() => expect(hoisted.lastSdkError).toBeDefined());

    first.unmount();
    render(<ChatWindow threadId={THREAD_A} />);
    await awaitComposer();

    expect(
      hoisted.lastSdkError,
      "the SDK error survived a remount — useChat now has a shared store, so " +
        "component-state suppression alone would leak the failure card again",
    ).toBeUndefined();
  });

  it("suppresses the failure card and Retry for a drop over a LIVE run, with no failed row", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    await waitFor(() => expect(hoisted.clearErrorCalls).toBeGreaterThan(0));
    expect(failureCardVisible()).toBe(false);
    expect(retryVisible()).toBe(false);
    // #545's durable half: nothing permanent written.
    expect(
      hoisted.insertedMessages.filter((r) =>
        JSON.stringify(r.parts ?? "").includes("__STATUS__:failed:"),
      ),
    ).toHaveLength(0);
  });

  it("never paints the card or Retry WHILE the liveness read is still in flight", async () => {
    // THE REGRESSION THIS FIX EXISTS FOR. The SDK calls onError without
    // awaiting it and writes `status:"error"` on the next line, so a
    // suppression claimed only AFTER the heartbeat round-trip lands late — and
    // for that whole window the analyst sees a red failure card with a Retry
    // that would start a SECOND concurrent run on a thread still working.
    //
    // Measured before the fix: card visible during the read = true.
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    hoisted.heartbeatGate = new Promise<void>((r) => { hoisted.releaseHeartbeat = r; });

    render(<ChatWindow threadId={THREAD_A} />);
    const box = await awaitComposer();
    await act(async () => {
      fireEvent.change(box, { target: { value: "jordan.vale@example.test" } });
    });
    await act(async () => {
      (screen.getByRole("button", { name: /start investigation/i }) as HTMLButtonElement).click();
    });

    // Park inside the liveness read, with the SDK error already written.
    await waitFor(() => expect(hoisted.onErrorEntered).toBe(1));
    await waitFor(() => expect(hoisted.lastSdkError).toBeDefined());

    expect(failureCardVisible(), "failure card painted during the liveness read").toBe(false);
    expect(retryVisible(), "Retry offered while the run may still be alive").toBe(false);

    await act(async () => {
      hoisted.releaseHeartbeat!();
      await hoisted.heartbeatGate;
    });
    await waitFor(() => expect(hoisted.onErrorSettled).toBe(1));
    expect(failureCardVisible()).toBe(false);
  });

  it("REMOVES the error from the SDK store rather than hiding it — the durability property", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    // This is the assertion the whole fix turns on. A suppression that only
    // hides is exactly as durable as the component state doing the hiding; an
    // error REMOVED from the store cannot outlive anything, because it is gone.
    await waitFor(() => expect(hoisted.lastSdkError).toBeUndefined());
  });

  it("keeps the card and Retry absent across unmount and remount of the same thread", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    const first = render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");
    await waitFor(() => expect(hoisted.lastSdkError).toBeUndefined());
    expect(failureCardVisible()).toBe(false);

    first.unmount();
    render(<ChatWindow threadId={THREAD_A} />);

    expect(failureCardVisible()).toBe(false);
    expect(retryVisible()).toBe(false);
    expect(hoisted.lastSdkError).toBeUndefined();
  });

  it("still renders a genuine failure card when the heartbeat is STALE", async () => {
    hoisted.heartbeat = staleHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(retryVisible()).toBe(true);
    expect(hoisted.clearErrorCalls).toBe(0);
  });

  it("still renders a genuine failure card when the heartbeat is MISSING", async () => {
    hoisted.heartbeat = null;
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(retryVisible()).toBe(true);
  });

  it("does not suppress a server-originated stream failure, even with a live heartbeat", async () => {
    // Negative control for requirements 6 and 7. `terminated` arrives over the
    // SSE error channel from the edge and is recorded as
    // `recovery_reason: stream_error` — suppressing it would silence a genuine
    // backend fault behind a "still running" toast.
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("terminated");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(hoisted.clearErrorCalls).toBe(0);
  });

  it("does not suppress an HTTP failure, even with a live heartbeat", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("HTTP 502 Bad Gateway");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(hoisted.clearErrorCalls).toBe(0);
  });

  it("lets a LATER genuine failure render after a suppressed drop", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");
    await waitFor(() => expect(hoisted.lastSdkError).toBeUndefined());
    expect(failureCardVisible()).toBe(false);

    // Second run on the same mount, genuinely broken this time.
    hoisted.nextTransportError = new Error("HTTP 500 Internal Server Error");
    await runAndFail("second seed");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(retryVisible()).toBe(true);
  });

  it("does not leak suppression to another thread", async () => {
    hoisted.heartbeat = freshHeartbeat();
    hoisted.nextTransportError = new Error("Load failed");
    const first = render(<ChatWindow threadId={THREAD_A} />);
    await runAndFail("jordan.vale@example.test");
    await waitFor(() => expect(hoisted.lastSdkError).toBeUndefined());
    first.unmount();

    // Thread B: a genuine failure must render its card, unaffected by A.
    hoisted.heartbeat = null;
    hoisted.nextTransportError = new Error("Load failed");
    render(<ChatWindow threadId={THREAD_B} />);
    await runAndFail("other seed");

    await waitFor(() => expect(failureCardVisible()).toBe(true));
    expect(retryVisible()).toBe(true);
  });
});
