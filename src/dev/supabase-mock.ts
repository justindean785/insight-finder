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
const DRAFT_THREAD_ID = "22222222-3333-4444-8555-666666666666";
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

  // ── Alias twins — one selector, two kind spellings ────────────────────────
  //    The auto-persist path writes `ip_address`, record_artifacts writes `ip`;
  //    a sweep writes `url` for a profile a later tool records as
  //    `social_profile`. Production (@hoodken28) listed both twins as separate
  //    rows with different confidences. The report folds each pair to one row.
  { id: "twin-ip-a", thread_id: THREAD_ID, kind: "ip_address", value: "203.0.113.57", confidence: 40, source: "oathnet_lookup", created_at: iso(12), metadata: { sources: ["oathnet_lookup"], corroborations: 1, source_class: "breach", confidence_cap_applied: 60, reason_for_confidence: "single source class: breach" } },
  { id: "twin-ip-b", thread_id: THREAD_ID, kind: "ip", value: "203.0.113.57", confidence: 70, source: "ip_intel + shodan_internetdb", created_at: iso(11), metadata: { sources: ["ip_intel", "shodan_internetdb"], corroborations: 2, source_class: "infra", confidence_cap_applied: 70, reason_for_confidence: "single source class: infra" } },
  { id: "twin-url-a", thread_id: THREAD_ID, kind: "url", value: "https://social.example/jharker_ops", confidence: 30, source: "username_sweep", created_at: iso(12), metadata: { sources: ["username_sweep"], corroborations: 1, source_class: "username_sweep", confidence_cap_applied: 45, reason_for_confidence: "single source class: username_sweep" } },
  { id: "twin-url-b", thread_id: THREAD_ID, kind: "social_profile", value: "https://social.example/jharker_ops", confidence: 55, source: "gemini_deep_dork", created_at: iso(11), metadata: { sources: ["gemini_deep_dork"], corroborations: 1, source_class: "ai_summary", handle: "jharker_ops", platform: "Social", confidence_cap_applied: 55, reason_for_confidence: "single source class: ai_summary" } },
  // ── Kinds the report used to file under **Other** ─────────────────────────
  { id: "org-1", thread_id: THREAD_ID, kind: "organization", value: "Northgate Logistics LLC", confidence: 62, source: "opencorporates + exa_search", created_at: iso(12), metadata: { sources: ["opencorporates", "exa_search"], corroborations: 2, source_class: "official" } },
  { id: "evt-1", thread_id: THREAD_ID, kind: "event", value: "Sacramento Freight Expo 2025 — listed exhibitor", confidence: 48, source: "gemini_deep_dork", created_at: iso(11), metadata: { sources: ["gemini_deep_dork"], corroborations: 1, source_class: "ai_summary", confidence_cap_applied: 55 } },
  { id: "wl-1", thread_id: THREAD_ID, kind: "weak_lead", value: "Sierra — mentioned in a stream title", confidence: 20, source: "socialfetch_web_read", created_at: iso(10), metadata: { sources: ["socialfetch_web_read"], corroborations: 1, source_class: "social_profile_passive" } },

  // ── Bulk-corpus spam — the gsalas916-style wall this change collapses ─────
  // Legacy shape: many rows, one reason. The board groups these into one card.
  { id: "bulk-1", thread_id: THREAD_ID, kind: "name", value: "Gabriel G. Salas", confidence: 45, source: "indicia_address", created_at: iso(9), metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject", source_class: "data_broker" } },
  { id: "bulk-2", thread_id: THREAD_ID, kind: "name", value: "Esther Salas", confidence: 45, source: "indicia_address", created_at: iso(8), metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject", source_class: "data_broker" } },
  { id: "bulk-3", thread_id: THREAD_ID, kind: "name", value: "Gabriel Gilbert Gilbert Salas", confidence: 45, source: "indicia_address", created_at: iso(7), metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject", source_class: "data_broker" } },
  { id: "bulk-4", thread_id: THREAD_ID, kind: "name", value: "Michael O. Wong", confidence: 45, source: "indicia_address", created_at: iso(6), metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject", source_class: "data_broker" } },
  { id: "bulk-5", thread_id: THREAD_ID, kind: "name", value: "Sandra Salas", confidence: 45, source: "indicia_address", created_at: iso(5), metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject", source_class: "data_broker" } },
  { id: "bulk-summary", thread_id: THREAD_ID, kind: "bulk_corpus_harvest", value: "67 unlinked identities — bulk corpus (gsalas916@icloud.com)", confidence: 40, source: "indicia_address", created_at: iso(4), metadata: {
    bulk_corpus: true,
    identity_count: 67,
    subject_unlinked: true,
    subject_unlinked_reason:
      "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector, which is a dataset of many people rather than one person's record; appearing in that dataset is not linkage to the subject",
    harvested_identities: [
      { kind: "name", value: "Gabriel G. Salas" },
      { kind: "name", value: "Esther Salas" },
      { kind: "email", value: "lil.est58@yahoo.com" },
      { kind: "email", value: "bboyjr03@verizon.net" },
    ],
  } },

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
  { id: "m5", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(4), parts: text("## Findings report\n\n**Subject:** James Harker — logistics operations, Northgate Logistics.\n\n### Confirmed\n- [CONFIRMED] Corporate email verified across two independent origins (`hunter_verify`, `exa_search`).\n- [CONFIRMED] Registrant domain `northgate-logistics.com` confirmed authoritative via RDAP.\n\n### Probable\n- [CORRELATED] Handle `jharker88` reused across two platforms.\n\n### Unresolved\n- [VERIFY] Oakland, CA location rests on a single broker record. Not promotable.\n- [LOW] IP `203.0.113.47` appears only in a breach dump; no independent confirmation.\n- [CONFLICT] RDAP and the staff directory name two different registrants for the same domain.\n\n| Selector | Class | Confidence |\n| --- | --- | --- |\n| j.harker@northgate-logistics.com | verified | 88 |\n| northgate-logistics.com | authoritative | 92 |\n| jharker88 | provider | 74 |\n| +1 415 555 0142 | data broker | [CONFIRMED] 95 (engine: 55, cap 60) |") },
];

const tool = (id: string, name: string, ok: boolean, ms: number, mins: number, err: string | null = null, cached = false) =>
  ({ id, thread_id: THREAD_ID, user_id: USER_ID, tool_name: name, ok, cached, duration_ms: ms, created_at: iso(mins), error_msg: err, status_code: ok ? 200 : 500, cost_micro_usd: 1200, charged_micro_usd: cached ? 0 : 1200, input_json: {} });

/**
 * Cross-case memories for the Intelligence page (/brain). Twelve rows: enough
 * for every kind the page groups, hit counts that are visibly NOT recall counts
 * (a `hit_count` rises on recall AND on re-save), and confidences averaging 66
 * so the header's "Memory confidence (sample)" reads differently from the
 * Overview's "Artifact confidence" (49, from `get_insights_summary` below) —
 * the two numbers the 2026-10-31 audit saw share one label.
 *
 * Scenarios: `?scenario=memories-empty` (0 rows) and `?scenario=memories-overcap`
 * (520 rows → the page samples 500, the count reads 520, the caption reads
 * "500 most recent of 520").
 */
const memoryRow = (i: number, over: Partial<Record<string, unknown>> = {}) => ({
  id: `mem-${i}`, user_id: USER_ID, kind: "lesson", subject: `subject-${i}`, subject_kind: "email",
  content: `Lesson ${i}: a saved observation about how this selector behaved.`, related_values: null,
  confidence: 60, hit_count: 1, last_used_at: null, created_at: iso(i * 7), source_thread_id: THREAD_ID, ...over,
});
const agent_memory = [
  memoryRow(0, { kind: "pattern", subject: "gmail.com", subject_kind: "email", content: "Gmail seeds rarely resolve through WHOIS; pivot to username reuse first.", confidence: 82, hit_count: 7, last_used_at: iso(3), related_values: ["username_sweep", "gravatar_profile"] }),
  memoryRow(1, { kind: "lesson", subject: "oathnet_lookup", subject_kind: "breach", content: "oathnet returns bulk corpus rows for common names — quarantine before pivoting.", confidence: 74, hit_count: 4, last_used_at: iso(9) }),
  memoryRow(2, { kind: "identity", subject: "j.harker@northgate-logistics.com", content: "Verified corporate mailbox; registrant of northgate-logistics.com.", confidence: 88, hit_count: 3, last_used_at: iso(14), related_values: ["jharker88", "northgate-logistics.com"] }),
  memoryRow(3, { kind: "connection", subject: "jharker88", subject_kind: "username", content: "Handle reused on two platforms; same avatar hash.", confidence: 71, hit_count: 2 }),
  memoryRow(4, { kind: "pattern", subject: "+1 415", subject_kind: "phone", content: "415 area-code numbers from brokers are mostly VoIP; carrier lookup first.", confidence: 58, hit_count: 5, last_used_at: iso(20) }),
  memoryRow(5, { kind: "lesson", subject: "socialfetch_lookup", subject_kind: "social", content: "SocialFetch credits burn fastest on username sweeps; prefer a single profile fetch.", confidence: 63, hit_count: 1 }),
  memoryRow(6, { kind: "identity", subject: "northgate-logistics.com", subject_kind: "domain", content: "Domain registered 2019; RDAP registrant matches staff directory.", confidence: 92, hit_count: 0 }),
  memoryRow(7, { kind: "lesson", subject: "firecrawl_scrape", content: "Staff directories behind a login time out at 15s; use the wayback copy.", confidence: 47, hit_count: 2 }),
  memoryRow(8, { kind: "pattern", subject: "stocktonfreight.example", subject_kind: "breach", content: "Domain-breach corpora list every mailbox; none is linkage to the subject.", confidence: 55, hit_count: 3 }),
  memoryRow(9, { kind: "connection", subject: "harker.logistics", subject_kind: "username", content: "Linkage confirmed by analyst after collision review.", confidence: 69, hit_count: 1 }),
  memoryRow(10, { kind: "lesson", subject: "indicia_person", subject_kind: "geo", content: "Two broker residences for one subject is a conflict, not corroboration.", confidence: 52, hit_count: 0 }),
  memoryRow(11, { kind: "identity", subject: "Oakland, California, US", subject_kind: "geo", content: "Single-broker location; not promotable.", confidence: 41, hit_count: 1 }),
];

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

// ── Per-run telemetry for /brain → Credits ──────────────────────────────────
// Shaped like `orchestrator_invocations` / `orchestrator_step_metrics`
// (supabase/migrations/20260908000000_orchestrator_telemetry.sql, plus the timing columns of
// 20261029210000). Timestamps are RELATIVE TO NOW, unlike `iso()` which is pinned to Aug 9:
// the Credits tab windows by the real clock, so pinned dates would all fall outside its
// 30-day window and the tab would render empty. Offsets sit mid-day so no run is near a
// day boundary. Expected figures for e2e/credits.spec.ts (30-day window = 8 runs; the 40-day
// row is outside it): spend30 $1.77, spend14 $1.36, one unknown-cost run, forced share 3/7
// = 43%, salvage 126.3 s of 711.6 s timed = 18%.
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const invocation = (id: string, hoursAgo: number, over: Partial<Record<string, unknown>> = {}) => ({
  id, thread_id: THREAD_ID, user_id: USER_ID, provider: "deepseek", model_id: "glm-5.2",
  started_at: ago(hoursAgo), finished_at: ago(hoursAgo), created_at: ago(hoursAgo),
  duration_ms: 100_000, step_count: 8, tool_call_count: 12, finish_reason: "stop",
  stop_reason: "natural_stop", finalize_started: false, credits_micro_usd: 150_000,
  persist_ms: 2_000, salvage_ms: null, cluster_ms: 1_500, salvage_outcome: "none", unfinished_steps: 0,
  first_step_offset_ms: 90, loop_end_offset_ms: null, error_message: null,
  ...over,
});
const orchestrator_invocations = [
  invocation("inv-0001", 2, { duration_ms: 84_700, step_count: 7, tool_call_count: 11, credits_micro_usd: 142_300 }),
  invocation("inv-0002", 5, { stop_reason: "finalize_forced", finalize_started: true, duration_ms: 154_200, step_count: 8, tool_call_count: 14, credits_micro_usd: 232_900, persist_ms: 55_500, salvage_ms: 53_700, salvage_outcome: "ok" }),
  invocation("inv-0003", 26, { duration_ms: 160_300, step_count: 7, tool_call_count: 12, credits_micro_usd: 198_400, persist_ms: 76_000, salvage_ms: 72_600, salvage_outcome: "ok" }),
  invocation("inv-0004", 78, { stop_reason: "finalize_forced", finalize_started: true, duration_ms: 162_300, step_count: 11, tool_call_count: 19, credits_micro_usd: 487_000, persist_ms: 1_100 }),
  invocation("inv-0005", 150, { stop_reason: "stream_error", duration_ms: 57, step_count: 0, tool_call_count: 0, credits_micro_usd: 0, persist_ms: 0, cluster_ms: null, error_message: "stream error" }),
  // A run recorded before the cost column carried a value, and before the ending was classified.
  invocation("inv-0006", 222, { stop_reason: "unknown", credits_micro_usd: null, persist_ms: null, cluster_ms: null, salvage_outcome: null, unfinished_steps: null }),
  // A run recorded before timing shipped: cost and ending present, every timing column NULL.
  invocation("inv-0007", 270, { duration_ms: 118_000, credits_micro_usd: 301_500, persist_ms: null, cluster_ms: null, salvage_outcome: null, unfinished_steps: null }),
  invocation("inv-0008", 438, { stop_reason: "finalize_forced", finalize_started: true, duration_ms: 150_000, step_count: 12, tool_call_count: 21, credits_micro_usd: 410_000 }),
  // Outside the 30-day window: must not reach any figure on the tab.
  invocation("inv-0009", 966, { credits_micro_usd: 900_000 }),
];
const stepRow = (inv: string, n: number, input: number | null, output: number | null) => ({
  id: `${inv}-s${n}`, invocation_id: inv, thread_id: THREAD_ID, user_id: USER_ID, step_number: n,
  step_wall_ms: 9_000, context_chars: 180_000, input_tokens: input, output_tokens: output,
  tool_call_count: 1, tool_names: [], finish_reason: "tool-calls", created_at: ago(2),
});
const orchestrator_step_metrics = [
  stepRow("inv-0001", 1, 41_000, 600), stepRow("inv-0001", 2, 48_500, 450), stepRow("inv-0001", 3, 52_000, 1_900),
  // One step with no usage: the run's token total must read as a floor, not as an exact sum.
  stepRow("inv-0002", 1, 60_000, 700), stepRow("inv-0002", 2, null, null), stepRow("inv-0002", 3, 71_000, 2_400),
  stepRow("inv-0003", 1, 60_000, 2_100), stepRow("inv-0003", 2, 64_000, 1_800),
];

const SYNTHETIC: Record<string, unknown[]> = {
  threads: [{
    id: THREAD_ID, user_id: USER_ID, title: "James Harker — logistics", archive_attachments: false,
    seed_value: "j.harker@northgate-logistics.com", seed_type: "email",
    // Equals the sum of this case's recorded runs below (all nine, including the one outside the
    // 30-day window), so the Credits tab's "all time" figure is not smaller than its 30-day one.
    status: "finished", credits_used: 34, cost_micro_usd: 2_672_100,
    recovered_at: null, recovery_reason: null,
    created_at: iso(46), updated_at: iso(4), last_heartbeat_at: iso(4), run_started_at: iso(45),
  }, {
    // A NEVER-STARTED thread — the exact production shape of the two rows
    // measured 2026-09-07: "New investigation" inserts { user_id } and every
    // other column takes its default, so status is 'active' with no run marker
    // at all. Kept in the harness because "active but never ran" is a state the
    // case list has to render correctly (Draft, not Running) and there is no
    // other way to see it without a real blank thread.
    id: DRAFT_THREAD_ID, user_id: USER_ID, title: "New investigation", archive_attachments: false,
    seed_value: null, seed_type: null,
    status: "active", credits_used: 0, cost_micro_usd: 0,
    recovered_at: null, recovery_reason: null,
    created_at: iso(2), updated_at: iso(2), last_heartbeat_at: null, run_started_at: null,
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
  // `review.ts` selects `artifact_id,state,note` and keys on `user_id`; the
  // previous rows carried `verdict` / `reviewer_id`, so no analyst decision ever
  // reached the harness UI and a screenshot could not show what Confirm or
  // Dismiss does to the report. Shape matches the live table.
  artifact_reviews: [
    { id: "r1", artifact_id: "a1", thread_id: THREAD_ID, user_id: USER_ID, state: "confirmed", created_at: iso(9), note: null },
    { id: "r2", artifact_id: "a6", thread_id: THREAD_ID, user_id: USER_ID, state: "dismissed", created_at: iso(7), note: "Different James Harker — wrong county." },
    // One twin of the ip_address / ip pair below is dismissed: the report must
    // fold the pair and render it FAILED, not keep the other twin authoritative.
    { id: "r3", artifact_id: "twin-ip-a", thread_id: THREAD_ID, user_id: USER_ID, state: "dismissed", created_at: iso(6), note: "carrier NAT egress — not the subject's line" },
  ],
  // Real columns (supabase/migrations/20260629_user_credits.sql). This row used to carry
  // `credits_remaining` / `credits_total`, which the table does not have, so the sidebar chip
  // read `balance_micro_usd` as missing and rendered "Out of beta credits $0". A beta user with
  // a part-spent grant is the default; `?scenario=credits-unlimited` is the owner account.
  user_credits: [{
    user_id: USER_ID, balance_micro_usd: 312_450, spent_micro_usd: 187_550, daily_spent_micro_usd: 41_200,
    daily_window_start: iso(300), unlimited: false, blocked: false, created_at: iso(60_000), updated_at: iso(4),
  }],
  orchestrator_invocations, orchestrator_step_metrics,
  agent_memory, investigation_cache: [], client_errors: [],
};

const FIXTURES: Record<string, unknown[]> = SNAPSHOT?.tables ?? SYNTHETIC;
const SYNTHETIC_TOOL_ROWS = [...tool_usage_log];

if (SNAPSHOT) {
  const t = SNAPSHOT.tables;
  console.info(
    `[harness] real snapshot ${SNAPSHOT.capturedAt} — thread ${SNAPSHOT.threadId}: ` +
      `${t.artifacts?.length ?? 0} artifacts, ${t.tool_usage_log?.length ?? 0} tool calls, ` +
      `${t.messages?.length ?? 0} messages, ${t.threads?.length ?? 0} threads`,
  );
}

/**
 * Harness SCENARIOS — `?scenario=<name>` on any harness URL. Each one reshapes
 * the fixtures so a state that only exists in production (an interrupted run,
 * a case still syncing, a live reconciliation) can be rendered, screenshotted
 * and driven by Playwright without a network or a paid run.
 *
 *   running      — status active with a fresh heartbeat
 *   interrupted  — finished with a stream-error recovery reason, partial spend
 *   stale        — recovered by the health sweep
 *   stopped      — an analyst Stop
 *   syncing      — every read hangs, so the case never hydrates
 *   reconcile    — starts interrupted (16 calls, $0.120); ~2.5s later the run
 *                  finalizes (18 calls, $0.393) and a realtime UPDATE fires
 *   malformed    — the latest report's pivot section carries table rows and a
 *                  footer, which the rail must render as "needs repair"
 *   ready        — analyst confirmations lift report readiness past the bar
 */
const SCENARIO =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("scenario") ?? "" : "";

const mainThread = FIXTURES.threads?.[0] as Record<string, unknown> | undefined;
const nowIso = () => new Date().toISOString();
if (!SNAPSHOT && mainThread) {
  if (SCENARIO === "running" || SCENARIO === "running-elsewhere") {
    Object.assign(mainThread, { status: "active", run_started_at: new Date(Date.now() - 120_000).toISOString(), last_heartbeat_at: nowIso() });
    // Calls this run has recorded so far: the server keeps working whether or
    // not this browser still holds the live stream (a fresh page load holds none).
    const inRun = (id: string, name: string, ok: boolean, ms: number, secsAgo: number) =>
      ({ ...tool(id, name, ok, ms, 0), created_at: new Date(Date.now() - secsAgo * 1000).toISOString() });
    FIXTURES.tool_usage_log = [
      ...(FIXTURES.tool_usage_log ?? []),
      inRun("r1", "dns_records", true, 474, 100),
      inRun("r2", "crtsh_lookup", false, 2829, 95),
      inRun("r3", "wayback_cdx_search", true, 679, 40),
    ];
    if (SCENARIO === "running") {
      // The agent's first reply as a dropped stream leaves it: cut off mid-stream.
      (FIXTURES.messages as unknown[]).push({
        id: "m-run-start", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: new Date(Date.now() - 110_000).toISOString(),
        parts: [{ type: "text", text: "Starting with the domain's DNS and certificate history.", state: "streaming" }],
      });
    } else {
      // `running-elsewhere`: this tab had the case open BEFORE the run started
      // (a second tab or device). `messages` is not in the realtime publication,
      // so its transcript still ends with the PREVIOUS run's final reply — here
      // one that was itself cut off — and no message of the new run is loaded.
      (FIXTURES.messages as unknown[]).push({
        id: "m-prev-run-end", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: new Date(Date.now() - 720_000).toISOString(),
        parts: [{ type: "text", text: "Earlier run: the breach sweep found two reused handles and", state: "streaming" }],
      });
    }
  } else if (SCENARIO === "interrupted" || SCENARIO === "reconcile") {
    Object.assign(mainThread, {
      status: "finished",
      recovery_reason: "stream_error: upstream provider closed the connection (ECONNRESET)",
      recovered_at: null,
      cost_micro_usd: 120_000,
    });
  } else if (SCENARIO === "stale") {
    Object.assign(mainThread, {
      status: "finished",
      recovery_reason: "stale heartbeat recovered by health sweep",
      recovered_at: iso(3),
      cost_micro_usd: 120_000,
    });
  } else if (SCENARIO === "stopped") {
    Object.assign(mainThread, { status: "stopped" });
  }
  if (SCENARIO === "reconcile") {
    // The ledger as the long-lived header last saw it: two calls short.
    FIXTURES.tool_usage_log = (FIXTURES.tool_usage_log ?? []).slice(0, 16);
  }
  if (SCENARIO === "malformed") {
    (FIXTURES.messages as unknown[]).push({
      id: "m6", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: iso(1),
      parts: text("## Findings report\n\nSubject remains unresolved.\n\n### Recommended Next Pivots\n\n| Action | Target | Type | Reason |\n| --- | --- | --- | --- |\n| Review lead | Keith family residence | name | confirm household |\n\nThis report was generated by an automated OSINT assistant and is provided for informational purposes only.\n\n- Verify `jharker88` reuse across platforms — two handles match"),
    });
  }
  if (SCENARIO === "ready") {
    const confirmed = (FIXTURES.artifacts as { id: string; metadata?: Record<string, unknown> }[])
      .filter((a) => !a.metadata?.subject_unlinked && !a.metadata?.possible_collision && !a.metadata?.conflict && !a.metadata?.false_positive)
      .map((a, i) => ({ id: `rr${i}`, artifact_id: a.id, thread_id: THREAD_ID, user_id: USER_ID, state: "confirmed", created_at: iso(2), note: null }));
    FIXTURES.artifact_reviews = confirmed;
  }
}

// Memory-population scenarios for /brain. Independent of the thread scenarios
// above: the page reads `agent_memory` only.
// Credits scenarios for /brain → Credits: the owner account (never debited) and a user with
// no recorded runs. Same independence from the thread scenarios as the memory ones below.
if (!SNAPSHOT) {
  if (SCENARIO === "credits-unlimited") {
    FIXTURES.user_credits = [{ ...(SYNTHETIC.user_credits[0] as Record<string, unknown>), unlimited: true, balance_micro_usd: 0, spent_micro_usd: 0, daily_spent_micro_usd: 0 }];
  }
  if (SCENARIO === "runs-empty") {
    FIXTURES.orchestrator_invocations = [];
    FIXTURES.orchestrator_step_metrics = [];
  }
}

if (!SNAPSHOT) {
  if (SCENARIO === "memories-empty") FIXTURES.agent_memory = [];
  if (SCENARIO === "memories-overcap") {
    FIXTURES.agent_memory = Array.from({ length: 520 }, (_, i) => memoryRow(i, { confidence: 40 + (i % 50), hit_count: i % 4 }));
  }
}

/** Realtime: channels register their postgres_changes bindings here so a
 *  scenario can push an UPDATE the way Supabase would. */
type Binding = { table: string; event: string; cb: (payload: unknown) => void };
const bindings = new Set<Binding>();
function emit(table: string, event: string, payload: unknown) {
  for (const b of bindings) {
    if (b.table === table && (b.event === "*" || b.event === event)) b.cb({ eventType: event, ...(payload as object) });
  }
}

if (!SNAPSHOT && mainThread && SCENARIO === "reconcile" && typeof window !== "undefined") {
  window.setTimeout(() => {
    FIXTURES.tool_usage_log = [...SYNTHETIC_TOOL_ROWS];
    Object.assign(mainThread, { status: "finished", recovery_reason: null, recovered_at: null, cost_micro_usd: 393_000, updated_at: nowIso() });
    emit("threads", "UPDATE", { new: { ...mainThread }, old: {} });
  }, 2500);
}

// `running`: the run finishes while the page is away (a phone asleep). The row
// and the report are saved and NO realtime event reaches the page, which is the
// production gap: only a re-read (return to the tab, the live poll) can see it.
if (!SNAPSHOT && mainThread && SCENARIO === "running" && typeof window !== "undefined") {
  (window as unknown as { __harnessFinishRun?: () => void }).__harnessFinishRun = () => {
    Object.assign(mainThread, { status: "finished", last_heartbeat_at: nowIso(), updated_at: nowIso() });
    (FIXTURES.messages as unknown[]).push({
      id: "m-run-end", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: nowIso(),
      parts: text("## Findings report\n\nSynthetic run finished while this page was away."),
    });
  };
}

// `stalled`: the case is finished when the page opens. The test then sends a
// message, which the harness answers with a stream that never closes (see
// fetch-retry-mock.ts). Finishing the run saves the row and the report and,
// as in production when the socket is dead, NO realtime event reaches the page.
// The row names THIS run (its start is after the stream opened), which is what
// lets the transcript tell a dead stream from a healthy new one.
if (!SNAPSHOT && mainThread && SCENARIO === "stalled" && typeof window !== "undefined") {
  (window as unknown as { __harnessFinishRun?: () => void }).__harnessFinishRun = () => {
    Object.assign(mainThread, { status: "finished", run_started_at: nowIso(), last_heartbeat_at: nowIso(), updated_at: nowIso() });
    (FIXTURES.messages as unknown[]).push({
      id: "m-stalled-end", thread_id: THREAD_ID, user_id: USER_ID, role: "assistant", created_at: nowIso(),
      parts: text("## Findings report\n\nSynthetic run finished after its stream stalled."),
    });
  };
}

const RPC: Record<string, unknown> = {
  // Field names must match the production RPC's RETURNS TABLE
  // (thread_id, artifacts, tool_calls) — loadCaseMetrics maps those exact
  // names, so anything else silently renders the cases list as all-zero.
  get_case_metrics: [{ thread_id: THREAD_ID, artifacts: artifacts.length, tool_calls: tool_usage_log.length }],
  // Shape of the production RPC (`InsightsSummary`). The old stub was an array
  // of a different record, so the Overview rendered every card empty in the
  // harness. `avg_confidence` is over public.artifacts — the tile says so.
  get_insights_summary: {
    kind_counts: [{ kind: "email", count: 31 }, { kind: "username", count: 12 }, { kind: "domain", count: 9 }, { kind: "phone", count: 8 }, { kind: "breach_exposure", count: 22 }, { kind: "location", count: 6 }, { kind: "social_profile", count: 8 }],
    source_counts: [{ source: "oathnet_lookup", count: 38 }, { source: "indicia_address", count: 17 }, { source: "hunter_verify", count: 11 }, { source: "exa_search", count: 10 }, { source: "socialfetch", count: 7 }, { source: "whois_lookup", count: 5 }],
    day_counts: Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), count: [3, 0, 7, 12, 4, 0, 1, 9, 2, 0, 5, 6, 0, 8][i] })),
    top_cases: [{ thread_id: THREAD_ID, title: "James Harker — logistics", artifact_count: artifacts.length, last_at: iso(4) }],
    conf_buckets: { ge80: 9, b50: 27, b20: 44, lt20: 16, unscored: 0 },
    avg_confidence: 49,
    tool_counts: tool_usage_log.reduce<Array<{ tool_name: string; count: number; ok_count: number }>>((acc, t) => {
      const row = acc.find((r) => r.tool_name === t.tool_name) ?? (acc.push({ tool_name: t.tool_name, count: 0, ok_count: 0 }), acc[acc.length - 1]);
      row.count += 1; if (t.ok) row.ok_count += 1; return acc;
    }, []),
    tool_calls_total: tool_usage_log.length,
  },
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

  for (const m of ["select", "insert", "upsert", "delete", "neq", "is", "gt", "gte", "lt", "lte", "like", "ilike", "not", "or", "filter", "order", "range", "returns", "abortSignal", "overrideTypes"]) {
    self[m] = chain;
  }
  // `update(patch)` is applied to the rows the filters select, and a realtime
  // UPDATE is emitted for each, the way Supabase would. `rows` holds the SAME
  // object refs as the fixture table, so the patch is visible to every later
  // read. This is what lets the harness show the analyst's Stop (a client write
  // of `status='stopped'` on `threads`) reach the case snapshot and the
  // transcript's watchdog without a server. Applied when the chain is awaited,
  // after the `.eq()` filters have run. TRAP: `eq()` ignores a column the
  // fixture rows do not carry, so an update filtered only on such a column
  // patches EVERY row of the table — give the fixture the column instead.
  let pendingUpdate: Record<string, unknown> | null = null;
  self.update = (patch: Record<string, unknown>) => { pendingUpdate = patch ?? {}; return self; };
  const applyUpdate = () => {
    if (!pendingUpdate) return;
    const patch = pendingUpdate;
    pendingUpdate = null;
    for (const r of rows) {
      if (typeof r !== "object" || r === null) continue;
      const before = { ...(r as Record<string, unknown>) };
      Object.assign(r as Record<string, unknown>, patch);
      emit(table, "UPDATE", { new: { ...(r as Record<string, unknown>) }, old: before });
    }
  };
  // Equality filters are honoured on columns the fixture rows carry, so a
  // thread-scoped read of the draft thread returns the DRAFT, not the first
  // thread in the table. Columns a fixture does not carry are ignored.
  const has = (r: unknown, col: string) => typeof r === "object" && r !== null && col in (r as Record<string, unknown>);
  self.eq = (col: string, value: unknown) => {
    rows = rows.filter((r) => !has(r, col) || (r as Record<string, unknown>)[col] === value);
    return self;
  };
  self.in = (col: string, values: unknown[]) => {
    rows = rows.filter((r) => !has(r, col) || values.includes((r as Record<string, unknown>)[col]));
    return self;
  };
  self.limit = (n: number) => { rows = rows.slice(0, n); return self; };
  // `syncing` never answers — the case must render its hydration state.
  const settle = <T,>(v: T): Promise<T> => (SCENARIO === "syncing" ? new Promise<T>(() => {}) : Promise.resolve(v));
  self.single = () => { applyUpdate(); return settle({ data: rows[0] ?? null, error: null }); };
  self.maybeSingle = self.single;
  self.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    applyUpdate();
    return settle({ data: rows, error: null, count: rows.length, status: 200 }).then(resolve, reject);
  };
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
  rpc: (name: string) => (SCENARIO === "syncing" ? new Promise(() => {}) : Promise.resolve({ data: RPC[name] ?? null, error: null })),
  channel: () => {
    const mine: Binding[] = [];
    const ch: Record<string, unknown> = {};
    ch.on = (_type: string, cfg: { table?: string; event?: string }, cb: (payload: unknown) => void) => {
      const b: Binding = { table: cfg?.table ?? "", event: cfg?.event ?? "*", cb };
      mine.push(b);
      bindings.add(b);
      return ch;
    };
    ch.subscribe = (cb?: (status: string) => void) => { cb?.("SUBSCRIBED"); return ch; };
    ch.unsubscribe = () => Promise.resolve("ok");
    ch.__bindings = mine;
    return ch;
  },
  removeChannel: (ch: { __bindings?: Binding[] }) => {
    for (const b of ch?.__bindings ?? []) bindings.delete(b);
    return Promise.resolve("ok");
  },
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
