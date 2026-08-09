/**
 * DEV-ONLY Supabase stub for the UI harness.
 *
 * Loaded ONLY via `vite.harness.config.ts`, which aliases
 * `@/integrations/supabase/client` to this module. It is never imported by
 * `src/`, so it cannot reach the production bundle.
 *
 * Purpose: render the signed-in workspace (Investigate / Evidence / Tools /
 * Graph / Report) without prod credentials or network access, so UI work can be
 * reviewed visually — with screenshots — before it is merged.
 */
import type { Session, User } from "@supabase/supabase-js";

const THREAD_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "99999999-8888-4777-8666-555555555555";

const iso = (minsAgo: number) => new Date(Date.UTC(2026, 7, 9, 4, 0, 0) - minsAgo * 60_000).toISOString();

const artifacts = [
  { id: "a1", thread_id: THREAD_ID, kind: "email", value: "j.harker@northgate-logistics.com", confidence: 88, confidence_cap_applied: null, source: "hunter_verify", created_at: iso(41), metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, source_class: "verified_provider" } },
  { id: "a2", thread_id: THREAD_ID, kind: "username", value: "jharker88", confidence: 74, confidence_cap_applied: null, source: "deepfind_reverse", created_at: iso(38), metadata: { sources: ["deepfind_reverse"], corroborations: 1, source_class: "provider" } },
  { id: "a3", thread_id: THREAD_ID, kind: "breach_exposure", value: "Wattpad (2020) — email, hashed password", confidence: 60, confidence_cap_applied: 60, source: "oathnet", created_at: iso(33), metadata: { sources: ["oathnet", "leakcheck"], corroborations: 2, source_class: "breach_corpus" } },
  { id: "a4", thread_id: THREAD_ID, kind: "phone", value: "+1 415 555 0142", confidence: 55, confidence_cap_applied: 60, source: "indicia_footprint", created_at: iso(27), metadata: { sources: ["indicia_footprint"], corroborations: 1, source_class: "data_broker" } },
  { id: "a5", thread_id: THREAD_ID, kind: "domain", value: "northgate-logistics.com", confidence: 92, confidence_cap_applied: null, source: "whois_lookup", created_at: iso(22), metadata: { sources: ["whois_lookup", "virustotal"], corroborations: 2, source_class: "authoritative" } },
  { id: "a6", thread_id: THREAD_ID, kind: "location", value: "Oakland, California, US", confidence: 41, confidence_cap_applied: 65, source: "indicia_person", created_at: iso(16), metadata: { sources: ["indicia_person"], corroborations: 1, source_class: "data_broker" } },
  { id: "a7", thread_id: THREAD_ID, kind: "social_profile", value: "linkedin.com/in/james-harker-logistics", confidence: 79, confidence_cap_applied: null, source: "socialfetch", created_at: iso(11), metadata: { sources: ["socialfetch", "exa_search"], corroborations: 2, source_class: "provider" } },
  { id: "a8", thread_id: THREAD_ID, kind: "ip", value: "203.0.113.47", confidence: 34, confidence_cap_applied: null, source: "oathnet", created_at: iso(6), metadata: { sources: ["oathnet"], corroborations: 1, source_class: "breach_corpus" } },
];

/** `messages.parts` is AI-SDK shaped Json, not a plain string body. */
const text = (t: string) => [{ type: "text", text: t }];
const toolPart = (name: string, state: "output-available" | "output-error", out: unknown) => ({
  type: `tool-${name}`, toolCallId: `call_${name}`, state,
  input: { query: "j.harker@northgate-logistics.com" },
  ...(state === "output-error" ? { errorText: String(out) } : { output: out }),
});

const messages = [
  { id: "m1", thread_id: THREAD_ID, user_id: USER_ID, role: "user", created_at: iso(45), parts: text("j.harker@northgate-logistics.com") },
  { id: "m2", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(44), parts: [
    ...text("Starting TRIAGE on the email selector. I'll verify deliverability first, then pivot to reverse-email and breach corpora before touching brokers."),
    toolPart("hunter_verify", "output-available", { result: "deliverable", score: 96 }),
    toolPart("exa_search", "output-available", { results: 6 }),
  ] },
  { id: "m3", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(40), parts: text("**Verified.** `hunter_verify` returns a deliverable corporate mailbox on `northgate-logistics.com`, and `exa_search` independently surfaces the same address on the company's staff directory — two independent origins, so this clears corroboration.\n\nMoving to identity expansion.") },
  { id: "m4", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(32), parts: [
    toolPart("oathnet", "output-available", { records: 2 }),
    toolPart("firecrawl_scrape", "output-error", "timeout after 15000ms"),
    ...text("Breach corpora returned a Wattpad (2020) record. Capped at 60 — breach-corpus rows are single-source by nature and cannot be promoted on their own."),
  ] },
  { id: "m5", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(4), parts: text("## Findings report\n\n**Subject:** James Harker — logistics operations, Northgate Logistics.\n\n### Confirmed\n- Corporate email verified across two independent origins (`hunter_verify`, `exa_search`).\n- Registrant domain `northgate-logistics.com` confirmed authoritative via RDAP.\n\n### Probable\n- Handle `jharker88` reused across two platforms.\n\n### Unresolved\n- Oakland, CA location rests on a single broker record. Not promotable.\n- IP `203.0.113.47` appears only in a breach dump; no independent confirmation.\n\n| Selector | Class | Confidence |\n| --- | --- | --- |\n| j.harker@northgate-logistics.com | verified | 88 |\n| northgate-logistics.com | authoritative | 92 |\n| jharker88 | provider | 74 |\n| +1 415 555 0142 | data broker | 55 (cap 60) |") },
];

const tool = (id: string, name: string, ok: boolean, ms: number, mins: number, err: string | null = null, cached = false) =>
  ({ id, thread_id: THREAD_ID, user_id: USER_ID, tool_name: name, ok, cached, duration_ms: ms, created_at: iso(mins), error_msg: err, status_code: ok ? 200 : 500, cost_micro_usd: 1200, charged_micro_usd: cached ? 0 : 1200, input_json: {} });

const tool_usage_log = [
  tool("t1", "hunter_verify", true, 812, 41),
  tool("t2", "exa_search", true, 2341, 40),
  tool("t3", "deepfind_reverse", true, 1520, 38),
  tool("t4", "oathnet", true, 3204, 33),
  tool("t5", "leakcheck", true, 1105, 31, null, true),
  tool("t6", "firecrawl_scrape", false, 15020, 24, "timeout after 15000ms"),
  tool("t7", "whois_lookup", true, 640, 22),
  tool("t8", "socialfetch", true, 1890, 11),
  tool("t9", "gemini_vision", false, 9100, 8, "document exceeded inline size ceiling"),
];

const FIXTURES: Record<string, unknown[]> = {
  threads: [{
    id: THREAD_ID, user_id: USER_ID, title: "James Harker — logistics", archive_attachments: false,
    seed_value: "j.harker@northgate-logistics.com", seed_type: "email",
    status: "finished", credits_used: 34, cost_micro_usd: 187_400,
    recovered_at: null, recovery_reason: null,
    created_at: iso(46), updated_at: iso(4), last_heartbeat_at: iso(4), run_started_at: iso(45),
  }],
  artifacts,
  messages,
  tool_usage_log,
  evidence_log: artifacts.map((a, i) => ({
    id: `e${i + 1}`, thread_id: THREAD_ID, artifact_id: a.id, action: i === 0 ? "created" : "corroborated",
    actor: "osint-agent", created_at: a.created_at, hash: `sha256:${"0".repeat(56)}${(i + 10).toString(16)}`, prev_hash: null, detail: {},
  })),
  artifact_reviews: [
    { id: "r1", artifact_id: "a1", thread_id: THREAD_ID, verdict: "correct", reviewer_id: USER_ID, created_at: iso(9), note: null },
    { id: "r2", artifact_id: "a6", thread_id: THREAD_ID, verdict: "wrong", reviewer_id: USER_ID, created_at: iso(7), note: "Different James Harker — wrong county." },
  ],
  user_credits: [{ user_id: USER_ID, credits_remaining: 466, credits_total: 500, updated_at: iso(4) }],
  agent_memory: [], investigation_cache: [], client_errors: [],
};

const RPC: Record<string, unknown> = {
  get_case_metrics: [{ thread_id: THREAD_ID, artifact_count: artifacts.length, confirmed_count: 2, tool_call_count: tool_usage_log.length, failed_tool_count: 2 }],
  get_insights_summary: [{ total_threads: 12, total_artifacts: 96, confirmed_artifacts: 24, credits_used: 341 }],
  has_role: false,
  verify_evidence_chain: [{ valid: true, checked: artifacts.length, broken_at: null }],
  record_analyst_feedback: { ok: true },
  save_agent_memories: { ok: true },
};

/** Chainable PostgREST stub: every filter/modifier returns `this`; awaiting it
 *  resolves `{ data, error: null }`. Mirrors the subset the app actually uses. */
function builder(table: string) {
  let rows = [...(FIXTURES[table] ?? [])];
  const self: Record<string, unknown> = {};
  const chain = () => self;

  for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is", "gt", "gte", "lt", "lte", "like", "ilike", "not", "or", "filter", "order", "range", "returns", "abortSignal", "overrideTypes"]) {
    self[m] = chain;
  }
  self.limit = (n: number) => { rows = rows.slice(0, n); return self; };
  self.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  self.maybeSingle = self.single;
  self.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null, count: rows.length, status: 200 }).then(resolve, reject);
  return self;
}

const session = {
  access_token: "harness-token", refresh_token: "harness-refresh",
  expires_in: 3600, expires_at: 4102444800, token_type: "bearer",
  user: { id: USER_ID, email: "analyst@harness.local", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: iso(60_000) } as unknown as User,
} as unknown as Session;

export const SUPABASE_URL = "https://harness.local";
export const hasSupabaseEnv = true;
export const supabaseConfigError = null;

export const supabase = {
  from: (table: string) => builder(table),
  rpc: (name: string) => Promise.resolve({ data: RPC[name] ?? null, error: null }),
  channel: () => { const ch: Record<string, unknown> = {}; ch.on = () => ch; ch.subscribe = () => ch; ch.unsubscribe = () => Promise.resolve("ok"); return ch; },
  removeChannel: () => Promise.resolve("ok"),
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "#" }, error: null }) }) },
  auth: {
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: session.user }, error: null }),
    onAuthStateChange: (cb: (e: string, s: Session | null) => void) => {
      setTimeout(() => cb("SIGNED_IN", session), 0);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    signInWithPassword: () => Promise.resolve({ data: { session }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
  },
} as unknown as typeof import("@/integrations/supabase/client").supabase;

export const HARNESS_THREAD_ID = THREAD_ID;
