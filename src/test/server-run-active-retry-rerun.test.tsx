/**
 * BEHAVIOURAL: while the SERVER still reports a live run on this case, neither
 * "Retry investigation" nor "Re-run" may start another one.
 *
 * The composer and the pivot rail already refuse with `server_running`
 * (`submitRefusal(status, lock, serverRunActiveRef.current)`). Retry and Re-run
 * checked only this tab's stream status, so a second tab, a dropped stream or a
 * stale failure card started a second billed run on top of the live one: the
 * edge run lease is disabled (RUN_LEASE_DISABLED) and the server rejects no
 * overlaps.
 *
 * Mounts the real ChatWindow with the real useChat; only the process boundaries
 * are faked (network, auth, router, toaster, Supabase). The case snapshot is the
 * real context, published with `run.state = "running"` — what CaseSnapshotProvider
 * derives from a live heartbeat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({
  posts: 0,
  deletes: [] as string[],
  infos: [] as string[],
  errors: [] as string[],
  runState: "running" as string,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "analyst@test.local" }, session: { access_token: "t" }, loading: false, error: null }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: (m: unknown) => { hoisted.errors.push(String(m)); },
    warning: () => {},
    success: () => {},
    message: () => {},
    info: (m: unknown) => { hoisted.infos.push(String(m)); },
    dismiss: () => {},
  }),
}));

vi.mock("@/lib/fetch-retry", () => ({
  fetchWithRetry: async () => {
    hoisted.posts++;
    return new Response("", { status: 500 });
  },
}));

const SEED = "jordan.vale@example.test";
const MESSAGES = [
  { id: "m-user", role: "user", parts: [{ type: "text", text: SEED }], created_at: "2026-10-18T09:00:00Z" },
  { id: "m-fail", role: "assistant", parts: [{ type: "text", text: "__STATUS__:failed:provider stream dropped" }], created_at: "2026-10-18T09:01:00Z" },
];

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["eq", "in", "order", "limit", "gt", "lt", "gte", "lte", "neq", "is", "not", "or", "filter", "match", "contains", "range"]) {
      chain[m] = self;
    }
    chain.select = () => chain;
    chain.maybeSingle = async () => (table === "threads" ? { data: { id: "t", last_heartbeat_at: new Date().toISOString() }, error: null } : { data: null, error: null });
    chain.single = chain.maybeSingle;
    chain.insert = async () => ({ data: null, error: null });
    chain.update = () => chain;
    chain.upsert = async () => ({ data: null, error: null });
    chain.delete = () => { hoisted.deletes.push(table); return chain; };
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === "messages" ? MESSAGES : [], error: null });
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
const { CaseSnapshotContext } = await import("@/hooks/useCaseSnapshot");

const THREAD = "dddddddd-4444-4444-8444-444444444444";

function renderWithServerRun() {
  const api = {
    snapshot: { run: { state: hoisted.runState } } as never,
    refresh: async () => {},
  };
  return render(
    <CaseSnapshotContext.Provider value={api}>
      <ChatWindow threadId={THREAD} />
    </CaseSnapshotContext.Provider>,
  );
}

beforeEach(() => {
  hoisted.posts = 0;
  hoisted.deletes = [];
  hoisted.infos = [];
  hoisted.errors = [];
  hoisted.runState = "running";
  // /health never answers; nothing in these paths may wait on it.
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    String(input).includes("health=1")
      ? new Promise<Response>(() => {})
      : Promise.reject(new Error(`unexpected global fetch: ${String(input)}`)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SERVER_RUNNING = /still working on the server/i;

describe("a live server run blocks Retry and Re-run", () => {
  it("Retry investigation does not start a second run while the server run is live", async () => {
    renderWithServerRun();
    const retry = await screen.findByRole("button", { name: /retry investigation/i });
    await act(async () => { fireEvent.click(retry); });
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.posts).toBe(0);
    expect([...hoisted.infos, ...hoisted.errors].join(" | ")).toMatch(SERVER_RUNNING);
  });

  it("Re-run (command palette) does not delete or start anything while the server run is live", async () => {
    renderWithServerRun();
    await screen.findByRole("button", { name: /retry investigation/i });
    await act(async () => { window.dispatchEvent(new Event("swarmbot:rerun")); });
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.posts).toBe(0);
    expect(hoisted.deletes).toEqual([]);
    expect([...hoisted.infos, ...hoisted.errors].join(" | ")).toMatch(SERVER_RUNNING);
  });

  it("control: with no live server run, Retry does reach the investigation POST", async () => {
    hoisted.runState = "interrupted";
    renderWithServerRun();
    const retry = await screen.findByRole("button", { name: /retry investigation/i });
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(hoisted.posts).toBeGreaterThan(0));
  });
});
