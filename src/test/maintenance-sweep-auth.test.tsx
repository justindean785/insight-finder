/**
 * BEHAVIOURAL: the open-case stale-run sweep (`?health=1&maintenance=1`) is
 * sent AS THE SIGNED-IN USER, and not at all without a session.
 *
 * Mounts the real `ChatWindow`; only process boundaries are faked (network,
 * auth, router, toaster). Harness copied from first-send-no-probe.test.tsx.
 *
 * Why: the edge maintenance pass runs stale-run recovery with the service role,
 * for every user, with no authentication. The edge lockdown will scope a
 * token-bearing call to the caller's own threads and treat an anonymous call
 * as liveness only. This side must send the token first, or open-case
 * recovery goes dark the moment the edge stops honouring anonymous calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";

const SYNTHETIC_TOKEN = "synthetic-access-token-for-tests";

const hoisted = vi.hoisted(() => ({
  calls: [] as string[],
  /** Every maintenance sweep request: its URL and its headers. */
  sweeps: [] as Array<{ url: string; headers: Headers }>,
  nextResponse: null as null | (() => Response),
  toastErrors: [] as string[],
  navigations: [] as string[],
  insertedMessages: [] as Record<string, unknown>[],
  heartbeat: null as string | null,
  heartbeatGate: null as null | Promise<void>,
  session: null as null | { access_token: string },
  /** Rows the mount-time message load returns: a stored message makes the thread "active", so the open-case sweep fires on mount. */
  storedMessages: [] as Array<Record<string, unknown>>,
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
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === "messages" ? hoisted.storedMessages : [], error: null });
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
        getSession: async () => ({ data: { session: hoisted.session }, error: null }),
        getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
      storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) },
    },
  };
});

const { ChatWindow } = await import("@/components/ChatWindow");
const { sendMaintenanceSweep, MAINTENANCE_SWEEP_QUERY } = await import("@/lib/maintenance-sweep");

const THREAD = "dddddddd-4444-4444-8444-444444444444";

beforeEach(() => {
  hoisted.calls = [];
  hoisted.sweeps = [];
  hoisted.nextResponse = () => new Response(JSON.stringify({ error: "x", code: "ORCHESTRATOR_FAULT" }), { status: 500 });
  hoisted.toastErrors = [];
  hoisted.navigations = [];
  hoisted.insertedMessages = [];
  hoisted.session = { access_token: SYNTHETIC_TOKEN };
  hoisted.storedMessages = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("health=1")) {
      hoisted.sweeps.push({ url, headers: new Headers(init?.headers) });
      return new Promise<Response>(() => {});
    }
    return Promise.reject(new Error(`unexpected global fetch: ${url}`));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const STORED = [{
  id: "eeeeeeee-5555-4555-8555-555555555555",
  role: "user",
  parts: [{ type: "text", text: "jordan.vale@example.test" }],
  created_at: "2026-01-01T00:00:00.000Z",
}];

describe("ChatWindow maintenance sweep carries the user's token", () => {
  it("on open, sends Authorization: Bearer <access token>, and never puts the token in the URL", async () => {
    hoisted.storedMessages = STORED;
    render(<ChatWindow threadId={THREAD} />);
    await waitFor(() => expect(hoisted.sweeps.length).toBe(1));
    const s = hoisted.sweeps[0];
    expect(s.url.endsWith(MAINTENANCE_SWEEP_QUERY)).toBe(true);
    expect(s.headers.get("Authorization")).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
    expect(s.url).not.toContain(SYNTHETIC_TOKEN);
  });

  it("keeps the cadence when idle: once on open, then 30 s and 90 s later, each with the token", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hoisted.storedMessages = STORED;
    render(<ChatWindow threadId={THREAD} />);
    await waitFor(() => expect(hoisted.sweeps.length).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(hoisted.sweeps.length).toBe(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await waitFor(() => expect(hoisted.sweeps.length).toBe(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(hoisted.sweeps.length).toBe(3);
    for (const s of hoisted.sweeps) expect(s.headers.get("Authorization")).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it("sends no sweep at all when there is no session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hoisted.session = null;
    hoisted.storedMessages = STORED;
    render(<ChatWindow threadId={THREAD} />);
    await waitFor(() => expect(screen.getByLabelText(/investigation request|message this case/i)).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(hoisted.sweeps).toEqual([]);
  });

  it("a blank thread (nothing ever ran) still sends no sweep", async () => {
    render(<ChatWindow threadId={THREAD} />);
    await waitFor(() => expect(screen.getByLabelText(/investigation request|message this case/i)).toBeTruthy());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(hoisted.sweeps).toEqual([]);
  });
});

describe("sendMaintenanceSweep", () => {
  const URL_BASE = "https://functions.example.test/osint-agent";

  it("sends one GET with the bearer header", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const out = await sendMaintenanceSweep(URL_BASE, async () => SYNTHETIC_TOKEN, f as unknown as typeof fetch);
    expect(out).toBe("sent");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}${MAINTENANCE_SWEEP_QUERY}`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it.each([
    ["null session", async () => null],
    ["empty token", async () => ""],
    ["session read throws", async () => { throw new Error("storage unavailable"); }],
  ])("skips without a request on %s", async (_label, getToken) => {
    const f = vi.fn(async () => new Response("{}"));
    const out = await sendMaintenanceSweep(URL_BASE, getToken as () => Promise<string | null>, f as unknown as typeof fetch);
    expect(out).toBe("skipped_no_session");
    expect(f).not.toHaveBeenCalled();
  });

  it("skips without a functions URL", async () => {
    const f = vi.fn(async () => new Response("{}"));
    expect(await sendMaintenanceSweep("", async () => SYNTHETIC_TOKEN, f as unknown as typeof fetch)).toBe("skipped_no_url");
    expect(f).not.toHaveBeenCalled();
  });

  it("swallows a network failure (the sweep is a fire-and-forget trigger)", async () => {
    const f = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(sendMaintenanceSweep(URL_BASE, async () => SYNTHETIC_TOKEN, f as unknown as typeof fetch)).resolves.toBe("sent");
  });
});
