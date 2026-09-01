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
  { id: "a1", thread_id: THREAD_ID, kind: "email", value: "j.harker@northgate-logistics.com", confidence: 88, source: "hunter_verify", created_at: iso(41), metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, source_class: "verified_provider" } },
  { id: "a2", thread_id: THREAD_ID, kind: "username", value: "jharker88", confidence: 74, source: "deepfind_reverse", created_at: iso(38), metadata: { sources: ["deepfind_reverse"], corroborations: 1, source_class: "provider" } },
  { id: "a3", thread_id: THREAD_ID, kind: "breach_exposure", value: "Wattpad (2020) — email, hashed password", confidence: 60, source: "oathnet", created_at: iso(33), metadata: { confidence_cap_applied: 60, sources: ["oathnet", "leakcheck"], corroborations: 2, source_class: "breach_corpus" } },
  { id: "a4", thread_id: THREAD_ID, kind: "phone", value: "+1 415 555 0142", confidence: 55, source: "indicia_footprint", created_at: iso(27), metadata: { confidence_cap_applied: 60, sources: ["indicia_footprint"], corroborations: 1, source_class: "data_broker" } },
  { id: "a5", thread_id: THREAD_ID, kind: "domain", value: "northgate-logistics.com", confidence: 92, source: "whois_lookup", created_at: iso(22), metadata: { sources: ["whois_lookup", "virustotal"], corroborations: 2, source_class: "authoritative" } },
  { id: "a6", thread_id: THREAD_ID, kind: "location", value: "Oakland, California, US", confidence: 41, source: "indicia_person", created_at: iso(16), metadata: { confidence_cap_applied: 65, sources: ["indicia_person"], corroborations: 1, source_class: "data_broker" } },
  { id: "a7", thread_id: THREAD_ID, kind: "social_profile", value: "linkedin.com/in/james-harker-logistics", confidence: 79, source: "socialfetch", created_at: iso(11), metadata: { sources: ["socialfetch", "exa_search"], corroborations: 2, source_class: "provider" } },
  { id: "a8", thread_id: THREAD_ID, kind: "ip", value: "203.0.113.47", confidence: 34, source: "oathnet", created_at: iso(6), metadata: { sources: ["oathnet"], corroborations: 1, source_class: "breach_corpus" } },
  // ── Quarantined: the same-name collision axis ────────────────────────────
  // A name-only sweep on "James Harker" returned a DIFFERENT James Harker's
  // selectors. The backend flags them `subject_unlinked` (#433) and they are
  // persisted on purpose — quarantine is disclosure, not deletion. They must
  // render as evidence with their reason, and must never seed an identity
  // cluster, gain a graph identity edge, or raise a confidence dimension.
  //
  // Without these rows the harness cannot show the promote boundary at all:
  // every other fixture artifact is un-quarantined, so the Graph/Report tabs
  // look identical with the gate on or off. They share a `parent` pointer so
  // they WOULD cluster together if the gate ever regressed — which is what
  // makes them a useful visual canary rather than decoration.
  { id: "a9", thread_id: THREAD_ID, kind: "phone", value: "+1 209 555 0117", confidence: 45, source: "oathnet_lookup", created_at: iso(19), metadata: { confidence_cap_applied: 55, sources: ["oathnet_lookup"], corroborations: 1, source_class: "data_broker", parent: "james harker", subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven" } },
  { id: "a10", thread_id: THREAD_ID, kind: "email", value: "jharker@stocktonfreight.example", confidence: 45, source: "oathnet_lookup", created_at: iso(18), metadata: { confidence_cap_applied: 55, sources: ["oathnet_lookup"], corroborations: 1, source_class: "data_broker", parent: "james harker", subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven" } },

  // ── The RELEASED row — `subject_unlinked` + `linkage_confirmed` ──────────
  // The #448 escape hatch, on the board. It arrived on the collision axis and
  // an analyst then adjudicated the linkage, so it must read as ORDINARY
  // evidence (no quarantine chip, no cordon, full confidence, eligible to
  // cluster and to pivot) while keeping its history in metadata.
  //
  // It is here because it is the state most likely to regress silently: the
  // three predicates that honour release and the two that used to ignore it all
  // render the same on a row with no release, so without this fixture the
  // difference is invisible in every screenshot.
  { id: "a11", thread_id: THREAD_ID, kind: "username", value: "harker.logistics", confidence: 81, source: "socialfetch", created_at: iso(15), metadata: { sources: ["socialfetch", "exa_search"], corroborations: 2, source_class: "provider", parent: "james harker", subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven", linkage_confirmed: true } },

  // ── The COLLISION row — strong evidence, zero subject authority ──────────
  // Deliberately the strongest fixture on the board: two independent source
  // classes and confidence 88, with `possible_collision` and no quarantine flag.
  //
  // That combination used to render "Verified", lead the Overview's strongest
  // findings and count in the header's verified tally — while clustering, the
  // graph, confidence dimensions and the report all treated it as an unrelated
  // namesake, because `isClusterIneligible` covers the collision flags and
  // `evidenceStatus` consults none of them. It is here so the board's answer and
  // the engine's answer can be compared in one screenshot. (Codex review, #462.)
  { id: "a12b", thread_id: THREAD_ID, kind: "email", value: "j.harker@harker-legal.example", confidence: 88, source: "hunter_verify", created_at: iso(14), metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, source_class: "provider", parent: "james harker", possible_collision: true, reason_not_confirmed: "a second James Harker — attorney, Sacramento — matches the queried name but nothing else in the case" } },

  // ── Conflict — contradicts another row, and is NOT quarantined ───────────
  { id: "a12", thread_id: THREAD_ID, kind: "location", value: "Stockton, California, US", confidence: 38, source: "indicia_person", created_at: iso(14), metadata: { sources: ["indicia_person"], corroborations: 1, source_class: "data_broker", conflict: true, conflict_note: "contradicts the Oakland record from the same broker — both cannot be the subject's primary residence" } },

  // ── Failed / excluded — analyst marked a false positive ─────────────────
  { id: "a13", thread_id: THREAD_ID, kind: "email", value: "info@northgate-logistics.com", confidence: 20, source: "exa_search", created_at: iso(13), metadata: { sources: ["exa_search"], corroborations: 1, source_class: "independent_public", false_positive: true } },

  // ── Long identifiers — the truncation / copy path ────────────────────────
  { id: "a14", thread_id: THREAD_ID, kind: "url", value: "https://staff.northgate-logistics.com/directory/operations/james-harker?ref=internal&utm_source=intranet&sid=7f3c19ab-2d44-4e51-9c07-a8be31f0d2c6", confidence: 66, source: "firecrawl_scrape", created_at: iso(12), metadata: { sources: ["firecrawl_scrape"], corroborations: 1, source_class: "independent_public" } },
  { id: "a15", thread_id: THREAD_ID, kind: "crypto_wallet", value: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq9v0x8lm3sq4nzsjhtca8", confidence: 29, source: "oathnet", created_at: iso(10), metadata: { sources: ["oathnet"], corroborations: 1, source_class: "breach" } },

  // ── A finding written into `value` as PROSE, not a selector ─────────────
  //    Real shape from thread `61d1eede`: the single most important row in that
  //    case, rendered by the board as forty truncated monospace characters.
  { id: "a16", thread_id: THREAD_ID, kind: "contradiction", value: "CONTRADICTION: 1110 Sample Ave is NOT linked to James Harker. The reverse-address lookup returned 31 records and the actual residents are the Keith and Plascencia families — Harker appears in none of them.", confidence: 65, source: "indicia_address", created_at: iso(11), metadata: { sources: ["indicia_address", "exa_search"], corroborations: 2, source_class: "data_broker", conflict: true, conflict_note: "the dossier's address claim does not survive the broker record" } },

  // ── Volume, MIXED provenance — the shape that made the board unreadable ──
  //    Production thread `61d1eede` (143 artifacts) rendered ONE `email`
  //    cluster of 34 rows: 21 mailboxes lifted wholesale out of a `psyber.com`
  //    domain-breach corpus, 10 co-residents from a reverse-address lookup, and
  //    3 the analyst uploaded — every row scored 30–50, so no sort or filter
  //    separated them, and exactly one of the thread's 143 rows was quarantined.
  //    Operator verdict: "there's way too many artifacts it's so hard to go
  //    through and see evidence."
  //
  //    The subdomain block below is UNIFORM provenance and must keep rendering
  //    flat (`uniformProv` already hoists its one label). This block is its
  //    counterpart: the crowded cluster that bands. Both paths in one screenshot.
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `bulk${i + 1}`, thread_id: THREAD_ID, kind: "email",
    value: `${["support", "billing", "dbuse", "noreply", "hr", "sales", "webmaster"][i]}@stocktonfreight.example`,
    confidence: 45, source: "oathnet_lookup",
    created_at: iso(17), metadata: { confidence_cap_applied: 60, sources: ["oathnet_lookup"], corroborations: 1, source_class: "breach", reason_for_confidence: "single source class: breach" },
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `resid${i + 1}`, thread_id: THREAD_ID, kind: "email",
    value: `${["m.keith", "a.keith", "r.plascencia", "t.plascencia"][i]}@mail.example`,
    confidence: 50, source: "indicia_address",
    created_at: iso(16), metadata: { confidence_cap_applied: 60, sources: ["indicia_address"], corroborations: 1, source_class: "data_broker", reason_for_confidence: "single source class: data_broker" },
  })),

  // ── Volume — a same-kind cluster past CLUSTER_COLLAPSE_THRESHOLD (4), so
  //    the collapse path and the sticky column head are exercised. Uniform
  //    provenance and near-identical confidence: the "wall of identical rows"
  //    the ledger's column alignment exists to make scannable.
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `sub${i + 1}`, thread_id: THREAD_ID, kind: "subdomain",
    value: `${["mail", "vpn", "portal", "api", "dev", "staging", "cdn", "git", "docs", "status", "smtp", "ns1", "ns2", "legacy"][i]}.northgate-logistics.com`,
    confidence: 70 - (i % 3) * 5, source: "hackertarget",
    created_at: iso(9), metadata: { sources: ["hackertarget"], corroborations: 1, source_class: "infra_dns" },
  })),
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
  // Long tool activity + the full outcome vocabulary, so the Tools tab is
  // reviewed against something other than "mostly succeeded".
  tool("t10", "hackertarget", true, 2210, 9),
  tool("t11", "virustotal", true, 1430, 8, null, true),
  tool("t12", "shodan_host", false, 30010, 7, "upstream rate limit — 429 after 3 retries"),
  tool("t13", "pdl_person_enrich", false, 420, 7, "gated: paid-call budget reached for this run"),
  tool("t14", "ipqualityscore", true, 690, 6),
  tool("t15", "urlscan_submit", false, 12040, 5, "timeout after 12000ms"),
  tool("t16", "ransomwarelive_lookup", true, 980, 5),
  tool("t17", "dehashed_search", false, 310, 4, "skipped: DEHASHED_API_KEY not configured"),
  tool("t18", "exa_contents", true, 3120, 4),
];

/**
 * A real snapshot, when one exists, always wins over the synthetic rows below.
 *
 * `scripts/harness-snapshot.mjs` writes `fixtures.json` (gitignored — real case
 * data). Invented fixtures are a floor, not a substitute: they cannot show a
 * kind distribution skewed 66/101 toward one type, a confidence ceiling of 75,
 * or chain-of-custody covering 4 of 101 artifacts. Those only appear in
 * production data, and they are exactly what the UI has to survive.
 *
 * Vite resolves this eagerly, so a missing file is a build-time miss rather
 * than a runtime throw — hence the glob rather than a bare import.
 */
const SNAPSHOT = (Object.values(
  import.meta.glob("./fixtures.json", { eager: true }) as Record<string, { default?: HarnessSnapshot }>,
)[0]?.default ?? null) as HarnessSnapshot | null;

interface HarnessSnapshot {
  capturedAt: string;
  threadId: string;
  tables: Record<string, unknown[]>;
  user?: { id?: string; email?: string };
}

const SYNTHETIC: Record<string, unknown[]> = {
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
  // Shaped to the columns CustodyTab actually selects (seq / classification /
  // chain_hash / collected_at ...). The previous fixture used a different, older
  // column set — action/actor/hash/created_at — so every field the panel read
  // came back undefined: 30 rows of "Invalid Date" with empty hashes, and a
  // verification RPC whose shape it could not read either. The Custody tab was
  // the one tab in the workspace that could not be reviewed in the harness.
  evidence_log: artifacts.map((a, i) => ({
    id: `e${i + 1}`,
    thread_id: THREAD_ID,
    seq: i + 1,
    classification: i % 3 === 0 ? "hard" : "soft",
    kind: a.kind,
    value: a.value,
    source: a.source,
    source_url: null,
    tool_name: a.source,
    confidence: a.confidence,
    chain_hash: `sha256:${(i + 10).toString(16).padStart(4, "0").repeat(16)}`.slice(0, 71),
    prev_hash: i === 0 ? null : `sha256:${(i + 9).toString(16).padStart(4, "0").repeat(16)}`.slice(0, 71),
    collected_at: a.created_at,
    metadata: a.metadata ?? {},
    archive_storage_path: i % 4 === 0 ? `evidence-archive/${THREAD_ID}/e${i + 1}.bin` : null,
    archive_sha256: i % 4 === 0 ? `${(i + 3).toString(16).padStart(2, "0").repeat(32)}` : null,
    archive_bytes: i % 4 === 0 ? 12_340 + i * 97 : null,
  })),
  artifact_reviews: [
    { id: "r1", artifact_id: "a1", thread_id: THREAD_ID, verdict: "correct", reviewer_id: USER_ID, created_at: iso(9), note: null },
    { id: "r2", artifact_id: "a6", thread_id: THREAD_ID, verdict: "wrong", reviewer_id: USER_ID, created_at: iso(7), note: "Different James Harker — wrong county." },
  ],
  user_credits: [{ user_id: USER_ID, credits_remaining: 466, credits_total: 500, updated_at: iso(4) }],
  agent_memory: [], investigation_cache: [], client_errors: [],
};

const FIXTURES: Record<string, unknown[]> = SNAPSHOT?.tables ?? SYNTHETIC;

if (SNAPSHOT) {
  const t = SNAPSHOT.tables;
  console.info(
    `[harness] real snapshot ${SNAPSHOT.capturedAt} — thread ${SNAPSHOT.threadId}: ` +
      `${t.artifacts?.length ?? 0} artifacts, ${t.tool_usage_log?.length ?? 0} tool calls, ` +
      `${t.messages?.length ?? 0} messages, ${t.threads?.length ?? 0} threads`,
  );
}

const RPC: Record<string, unknown> = {
  get_case_metrics: [{ thread_id: THREAD_ID, artifact_count: artifacts.length, confirmed_count: 2, tool_call_count: tool_usage_log.length, failed_tool_count: 2 }],
  get_insights_summary: [{ total_threads: 12, total_artifacts: 96, confirmed_artifacts: 24, credits_used: 341 }],
  has_role: false,
  // CustodyTab.verify() reads { ok, total, first_break } — the old
  // { valid, checked, broken_at } shape produced `ok: undefined`, which the
  // banner coerced to a red "CHAIN INTEGRITY broken".
  verify_evidence_chain: [{ ok: true, total: artifacts.length, first_break: null }],
  record_analyst_feedback: { ok: true },
  save_agent_memories: { ok: true },
};

/** Chainable PostgREST stub: every filter/modifier returns `this`; awaiting it
 *  resolves `{ data, error: null }`. Mirrors the subset the app actually uses. */
function builder(table: string) {
  // A snapshot table can be absent, or (for a single-row REST response) an
  // object rather than an array — never let either shape throw mid-render.
  const raw = FIXTURES[table];
  let rows: unknown[] = Array.isArray(raw) ? [...raw] : raw ? [raw] : [];
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

/**
 * Signed-out review switch. `?harness=signedout` makes the stub report no
 * session, so the harness can render the logged-out surfaces (Landing, /auth)
 * as well as the signed-in workspace. Default stays signed-in.
 */
const SIGNED_OUT =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("harness") === "signedout";

const session = {
  access_token: "harness-token", refresh_token: "harness-refresh",
  expires_in: 3600, expires_at: 4102444800, token_type: "bearer",
  user: { id: SNAPSHOT?.user?.id ?? USER_ID, email: "analyst@harness.local", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: iso(60_000) } as unknown as User,
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
    getSession: () => Promise.resolve({ data: { session: SIGNED_OUT ? null : session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: SIGNED_OUT ? null : session.user }, error: null }),
    onAuthStateChange: (cb: (e: string, s: Session | null) => void) => {
      setTimeout(() => cb(SIGNED_OUT ? "SIGNED_OUT" : "SIGNED_IN", SIGNED_OUT ? null : session), 0);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    signInWithPassword: () => Promise.resolve({ data: { session }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
  },
} as unknown as typeof import("@/integrations/supabase/client").supabase;

export const HARNESS_THREAD_ID = SNAPSHOT?.threadId ?? THREAD_ID;
