/**
 * BEHAVIOURAL: the first Send goes straight to the investigation POST, and a
 * pre-stream HTTP failure names its status.
 *
 * Mounts the real `ChatWindow`, the real `useChat` and the real
 * `DefaultChatTransport`; only the process boundaries are faked (network, auth,
 * router, toaster).
 *
 * WHAT WAS WRONG (audit 2026-09-30, F5b / Q5 / Q10):
 *
 *   1. `send()` awaited `GET ?health=1` with a 5 s timeout before the first
 *      POST on every mount. `/health` makes paid LLM pings; one sample measured
 *      6.7 s TTFB — past the timeout — so a HEALTHY backend could refuse the
 *      first Send with "cold-starting. Retry in a few seconds."
 *   2. The SDK keeps only a failed response's body, and the osint-agent's error
 *      bodies never carry the number, so every pre-stream failure read as the
 *      generic "Scan request failed before the stream started", the 401 →
 *      /auth redirect could never fire, and the failure card's headline — cut
 *      at the first colon of the raw JSON — read `{"error"`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({
  /** Every network call, in order: "health" or "post". */
  calls: [] as string[],
  /** What the investigation POST answers. */
  nextResponse: null as null | (() => Response),
  toastErrors: [] as string[],
  navigations: [] as string[],
  // Read by the shared Supabase mock below (copied from network-drop-suppression).
  insertedMessages: [] as Record<string, unknown>[],
  heartbeat: null as string | null,
  heartbeatGate: null as null | Promise<void>,
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
  useNavigate: () => (to: string) => { hoisted.navigations.push(to); },
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: (m: unknown) => { hoisted.toastErrors.push(String(m)); },
    warning: () => {},
    success: () => {},
    message: () => {},
    info: () => {},
    dismiss: () => {},
  }),
}));

// The transport's fetch: the investigation POST.
vi.mock("@/lib/fetch-retry", () => ({
  fetchWithRetry: async () => {
    hoisted.calls.push("post");
    return hoisted.nextResponse ? hoisted.nextResponse() : new Response("", { status: 500 });
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

const { ChatWindow } = await import("@/components/ChatWindow");

const THREAD = "cccccccc-3333-4333-8333-333333333333";

function json(status: number, body: Record<string, string>): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function startCase(seed: string) {
  await waitFor(() => expect(screen.getByLabelText(/investigation request|message this case/i)).toBeTruthy());
  const box = screen.getByLabelText(/investigation request|message this case/i) as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(box, { target: { value: seed } });
  });
  const send = screen.getByRole("button", { name: /^(start investigation|send)$/i }) as HTMLButtonElement;
  expect(send.disabled, "send button disabled — the seed never reached the composer").toBe(false);
  await act(async () => {
    send.click();
  });
}

beforeEach(() => {
  hoisted.calls = [];
  hoisted.nextResponse = null;
  hoisted.toastErrors = [];
  hoisted.navigations = [];
  hoisted.insertedMessages = [];
  // `/health` NEVER answers — the worst case of the 6.7 s measured. Anything
  // that awaits it before the POST never reaches the transport at all.
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    if (String(input).includes("health=1")) {
      hoisted.calls.push("health");
      return new Promise<Response>(() => {});
    }
    return Promise.reject(new Error(`unexpected global fetch: ${String(input)}`));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("first Send — no pre-send /health probe", () => {
  it("reaches the investigation POST while /health has not answered", async () => {
    hoisted.nextResponse = json(500, { error: "Internal Server Error", code: "ORCHESTRATOR_FAULT", detail: "engine fault" });
    render(<ChatWindow threadId={THREAD} />);
    await startCase("jordan.vale@example.test");

    await waitFor(() => expect(hoisted.calls).toContain("post"));
    expect(hoisted.calls[0], `network order was ${hoisted.calls.join(" → ")}`).toBe("post");
    expect(hoisted.toastErrors.join(" | ")).not.toMatch(/cold-starting/i);
  });
});

describe("pre-stream HTTP failures name their status", () => {
  const CASES: Array<{ status: number; body: Record<string, string>; says: RegExp; headline: string }> = [
    { status: 403, body: { error: "Forbidden", code: "THREAD_ACCESS_DENIED", detail: "This thread does not exist or does not belong to your account." }, says: /Access denied/, headline: "HTTP 403 Forbidden (THREAD_ACCESS_DENIED)" },
    { status: 404, body: { code: "NOT_FOUND", message: "Requested function was not found" }, says: /Edge function not deployed/, headline: "HTTP 404 (NOT_FOUND)" },
    { status: 402, body: { error: "Out of credits", code: "INSUFFICIENT_CREDITS", detail: "No credits remaining." }, says: /Out of beta credits/, headline: "HTTP 402 Out of credits (INSUFFICIENT_CREDITS)" },
    { status: 413, body: { error: "Payload Too Large", code: "BODY_TOO_LARGE", detail: "Request body exceeds the 2000000 byte limit." }, says: /Request too large/, headline: "HTTP 413 Payload Too Large (BODY_TOO_LARGE)" },
    { status: 429, body: { error: "Too Many Requests", code: "RATE_LIMITED", detail: "Slow down. Retry in 42s." }, says: /Rate limited/, headline: "HTTP 429 Too Many Requests (RATE_LIMITED)" },
  ];

  it.each(CASES)("HTTP $status: toast and card say what happened", async ({ status, body, says, headline }) => {
    hoisted.nextResponse = json(status, body);
    render(<ChatWindow threadId={THREAD} />);
    await startCase("jordan.vale@example.test");

    await waitFor(() => expect(hoisted.toastErrors.some((m) => m.startsWith("Investigation run failed:"))).toBe(true));
    const toast = hoisted.toastErrors.find((m) => m.startsWith("Investigation run failed:")) ?? "";
    expect(toast).toMatch(says);
    expect(toast).not.toMatch(/failed before the stream started/);
    // The card's headline is cut at the first colon; it used to read `{"error"`.
    await waitFor(() => expect(screen.getByText(headline)).toBeTruthy());
    expect(screen.queryByText('{"error"')).toBeNull();
  });

  it("HTTP 401 routes to sign-in, which it could never do before", async () => {
    hoisted.nextResponse = json(401, { error: "Unauthorized", code: "INVALID_SESSION", detail: "Session is invalid or expired. Sign in again." });
    render(<ChatWindow threadId={THREAD} />);
    await startCase("jordan.vale@example.test");

    await waitFor(() => expect(hoisted.navigations).toContain("/auth"));
    expect(hoisted.toastErrors.join(" | ")).toMatch(/Session expired/);
  });
});
