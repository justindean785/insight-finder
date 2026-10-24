// lib/next-pivot.ts — the RESUME BRIEF: a server-ranked "best next pivot" plus a correlation summary,
// handed to the orchestrator at the start of a RESUMED turn.
//
// WHY. A resumed turn starts cold exactly when it needs "where were we, what is the best next move":
// the budget pass cuts the prior report to ~268 chars and memory_recall output to ~295 (measured
// 2026-10-24, prompt-growth-findings), and `minimax_plan_pivots` — the only place a ranked, correlated
// view was ever built — runs only when the MODEL chooses to call it. This module computes that view
// deterministically from PERSISTED rows (artifacts, tool log, analyst verdicts), with no LLM call and
// no writes, and renders it as one bounded block (<= NEXT_PIVOT_BRIEF_MAX_CHARS).
//
// CHANNEL. The block is appended to `intermediateSystem` ONLY (index.ts), after the cached base prompt:
// the Anthropic cache prefix and the finalize / salvage prompts stay byte-identical. It is outside
// `capTotalToBudget` (which only touches the message array), which is why it is NOT a message: an
// assistant-role note is cut to 200 chars by the elision pass (pinned in next_pivot_test.ts).
//
// AUTHORITY. This block feeds model reasoning, so it is subject to the analyst's verdicts exactly like
// the planner's relationship graph (thread b74049ad):
//   - artifacts pass through `dropRejectedAndDerived` BEFORE ranking, and the winner is checked again
//     against the SAME dispatch-key sets cache.ts refuses on, so it cannot recommend what dispatch
//     would refuse;
//   - unreadable review state (`ok:false`, a RETURN not a throw) => no brief;
//   - a selector is out only while EVERY row carrying it is quarantined / collision / minor-flagged
//     (the browser's `isInert`); release is per row, and score and "why" come ONLY from the live rows.
//     Quarantine is disclosure, not deletion: those selectors are counted in WITHHELD, never listed.
//   - every value that reaches the prompt is shape-validated per type (artifact values are scraped
//     third-party text), capped at 80 chars, and shown as the recorded value.
//
// WHAT IT IS NOT. Not evidence, not a source, no confidence arithmetic, no tool-choice or termination
// control, and intent is never inferred from prose: the trigger is STRUCTURAL (an assistant message
// already exists, an eligible artifact exists, the latest user message is not a bare selector).
//
// Kill switch, read at CALL TIME: NEXT_PIVOT_BRIEF_DISABLED=true.
//
// EDGE-ONLY. Its own env read goes through `globalThis`, but it imports circuit.ts / cluster.ts, which read
// `Deno` directly, so no frontend suite may import it.

import { normalizeSelector } from "../circuit.ts";
import { canonicalKind, kindAliases } from "./kind-alias.ts";
import { dispatchKey } from "./dispatch-quarantine.ts";
import { buildRejectedDispatchKeys, crossCaseDispatchRows } from "./dispatch-rejection.ts";
import { dispatchSpellings } from "./cross-case-reviews.ts";
import { isSubjectUnlinked } from "./quarantine.ts";
import { type Artifact as ClusterArtifact, clusterArtifacts, isBookkeepingArtifact, stableHash } from "./cluster.ts";
import { THREAD_SEED_KINDS } from "./thread-seed.ts";
import { dropRejectedAndDerived, emptyReviewLoad, normalizeArtifactKey, type ReviewedRow, type ReviewLoad } from "../reviews.ts";
import { classifySourceInput, countIndependentClasses } from "../source-classification.ts";
import { playbookFor } from "../playbooks.ts";
import { detectSeedServer } from "../validation.ts";

// ---- limits & kill switch ----------------------------------------------------------------------

/** Hard cap on the rendered block. ~450 tokens; asserted on a worst-case fixture. */
export const NEXT_PIVOT_BRIEF_MAX_CHARS = 1800;
/** Wall-clock budget for the two reads. Past it the run simply goes without a brief. */
export const NEXT_PIVOT_BRIEF_DEADLINE_MS = 2500;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_SELECTOR_CHARS = 80;
const MAX_NAMED_LINKS = 3;
const MAX_TOOLS = 3;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function nextPivotBriefDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("NEXT_PIVOT_BRIEF_DISABLED") ?? "").trim().toLowerCase() === "true";
}

// ---- types -------------------------------------------------------------------------------------

export type PivotType = "email" | "username" | "phone" | "domain" | "ip" | "wallet";
const PIVOT_TYPES: ReadonlySet<string> = new Set<PivotType>(["email", "username", "phone", "domain", "ip", "wallet"]);

/** An `artifacts` row as read for this purpose. */
export type BriefArtifact = {
  id?: unknown;
  kind?: unknown;
  value?: unknown;
  source?: unknown;
  confidence?: unknown;
  metadata?: unknown;
  created_at?: unknown;
};

/** A `tool_usage_log` row as read for this purpose. */
export type BriefUsageRow = { outcome?: unknown; input_json?: unknown };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ---- "already queried": a mirror of the browser's useThreadQueriedTargets ------------------------
// "Unsearched" carries the +1000 term, so the server must believe the same things the browser does or
// the brief re-recommends pivots the analyst's screen already shows as done. The two helpers below are
// byte-for-byte `normalizeTarget` / `entityKey` from src/lib/next-step-cards.ts; the key lists are the
// ones in src/hooks/useThreadQueriedTargets.ts. DELIBERATE DIFFERENCE: rows with outcome='skipped'
// (a governance no-op that never reached a provider) are not investigations and are ignored; the
// browser counts every row. ok / empty / failed / cached / legacy-null rows all count.

export function normalizeTarget(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function entityKey(value: string): string {
  return normalizeTarget(value.replace(/\s+[-–—]\s+.*$/, ""));
}

const TARGET_KEYS = ["email", "value", "url", "handle", "phone", "username", "domain", "ip", "wallet", "address"] as const;
const QUERY_KEYS = ["query", "q", "search", "search_query"] as const;
const QUOTED_RE = /["“”']([^"“”']{2,80})["“”']/g;

function collectTargets(inputJson: unknown, into: Set<string>): void {
  if (!isObj(inputJson)) return;
  const runtime = inputJson.runtime;
  if (isObj(runtime) && typeof runtime.selector === "string" && runtime.selector.trim()) {
    into.add(normalizeTarget(runtime.selector));
  }
  // Two stored shapes: `{input:{…}, runtime:{…}}` (the wrapper's) and the flat tool input itself.
  const input = isObj(inputJson.input) ? inputJson.input : inputJson;
  for (const k of TARGET_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) into.add(normalizeTarget(v));
  }
  for (const k of QUERY_KEYS) {
    const v = input[k];
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(QUOTED_RE)) {
      const phrase = m[1]?.trim();
      if (phrase) into.add(normalizeTarget(phrase));
    }
  }
}

export function collectQueriedTargets(rows: readonly BriefUsageRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row?.outcome === "skipped") continue;
    collectTargets(row?.input_json, out);
  }
  out.delete("");
  return out;
}

// ---- paged reads -------------------------------------------------------------------------------

export type Page<T> = { data?: readonly T[] | null; count?: number | null; error?: { message?: string } | null };
export type PageReader<T> = (from: number, to: number) => Promise<Page<T>>;

export interface PagedRead<T> {
  rows: T[];
  /** True only when the whole set was read. An incomplete "searched" set is unreliable, so the caller skips. */
  complete: boolean;
  reason: string | null;
}

/**
 * Read every page. Advances by rows actually RETURNED (PostgREST's `db-max-rows` can trim a window
 * with a clean 200), ends on an empty page or when `count` is reached, and never assumes a short page
 * means the end. Same posture as `loadRefusedArtifacts` (#519).
 */
export async function readAllPages<T>(
  read: PageReader<T>,
  opts: { pageSize?: number; maxPages?: number; cancelled?: () => boolean } = {},
): Promise<PagedRead<T>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const rows: T[] = [];
  let total: number | null = null;
  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    // Once the caller has given up (deadline), stop asking: a brief nobody will use is not worth more
    // database load, least of all on the long threads that are slowest to read.
    if (opts.cancelled?.()) return { rows, complete: false, reason: "cancelled" };
    let res: Page<T>;
    try {
      res = await read(from, from + pageSize - 1);
    } catch {
      return { rows, complete: false, reason: "read_threw" };
    }
    if (res?.error) return { rows, complete: false, reason: "read_error" };
    const got = res?.data ?? [];
    if (typeof res?.count === "number") total = res.count;
    if (got.length === 0) {
      const complete = total === null || rows.length >= total;
      return { rows, complete, reason: complete ? null : "short_read" };
    }
    rows.push(...got);
    from += got.length;
    if (total !== null && rows.length >= total) return { rows, complete: true, reason: null };
  }
  return { rows, complete: false, reason: "page_cap" };
}

export interface BriefReaders {
  artifacts: PageReader<BriefArtifact>;
  usage: PageReader<BriefUsageRow>;
}

export interface BriefInputs {
  artifacts: BriefArtifact[];
  usage: BriefUsageRow[];
  complete: boolean;
  /** Why the read is incomplete; null when complete. */
  reason: string | null;
  ms: number;
}

export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ timedOut: boolean; value: T | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const r = await Promise.race([p, timeout]);
    return r === "timeout" ? { timedOut: true, value: null } : { timedOut: false, value: r as T };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Both reads in parallel under one deadline. Never throws. */
export async function loadBriefInputs(
  readers: BriefReaders,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<BriefInputs> {
  const now = opts.now ?? Date.now;
  const started = now();
  const empty = (reason: string): BriefInputs => ({ artifacts: [], usage: [], complete: false, reason, ms: now() - started });
  let cancelled = false;
  const cancelledNow = () => cancelled;
  try {
    const both = Promise.all([
      readAllPages(readers.artifacts, { cancelled: cancelledNow }),
      readAllPages(readers.usage, { cancelled: cancelledNow }),
    ]);
    const { timedOut, value } = await withDeadline(both, opts.deadlineMs ?? NEXT_PIVOT_BRIEF_DEADLINE_MS);
    if (timedOut || !value) {
      cancelled = true;
      return empty("deadline");
    }
    const [a, u] = value;
    const complete = a.complete && u.complete;
    return {
      artifacts: a.rows,
      usage: u.rows,
      complete,
      reason: complete ? null : `${a.complete ? "" : `artifacts:${a.reason}`}${!a.complete && !u.complete ? "," : ""}${u.complete ? "" : `tool_log:${u.reason}`}`,
      ms: now() - started,
    };
  } catch {
    cancelled = true;
    return empty("read_threw");
  }
}

// ---- selector shape validation -------------------------------------------------------------------
// Artifact values come from scraped third-party text. Only a value that has the SHAPE of its selector
// type may reach the system prompt; free text never does.

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;
const USER_RE = /^[a-z0-9_.-]{2,40}$/i;
const DOMAIN_RE = /^(?=.{4,80}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const TLD_RE = /^[a-z]{2,24}$/i;
const PHONE_RE = /^\+?\d{7,15}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^(?=.*:.*:)[0-9a-f:]{3,39}$/i;
const ETH_RE = /^0x[a-f0-9]{40}$/i;
const BTC_RE = /^(?:bc1|[13])[a-z0-9]{25,62}$/i;

// Mirrors INFRA_DOMAINS / SHARED_INFRA_SUFFIXES in src/lib/intel.ts: data sources and shared hosting say
// HOW evidence was gathered, never WHO the subject is. Keep in step with that file.
const INFRA_DOMAINS: ReadonlySet<string> = new Set([
  "bizfile.com", "bizfile.ca.gov", "bizfileonline.sos.ca.gov", "opencorporates.com", "bizapedia.com",
  "buildzoom.com", "builderzoom.com", "manta.com", "dnb.com", "bbb.org",
  "yelp.com", "google.com", "facebook.com", "linkedin.com", "twitter.com",
  "x.com", "instagram.com", "reddit.com", "wikipedia.org", "wikimedia.org",
  "archive.org", "web.archive.org", "pacer.gov", "courtlistener.com",
  "sec.gov", "ftc.gov", "fbi.gov", "irs.gov", "usa.gov", "ca.gov",
  "lacounty.gov", "dpw.lacounty.gov", "placer.ca.gov", "sos.ca.gov",
  "nationalpublicdata.com", "spokeo.com", "whitepages.com", "intelius.com",
  "beenverified.com", "instantcheckmate.com", "truthfinder.com",
  "rapidapi.com", "apis.guru", "hunter.io", "leakcheck.io",
  "haveibeenpwned.com", "dehashed.com", "intelx.io",
  "urlscan.io", "virustotal.com", "shodan.io", "censys.io",
  "domaintools.com", "whois.com", "icann.org", "iana.org",
  "homes.com", "zillow.com", "redfin.com", "trulia.com", "realtor.com",
  "peoplefinders.com", "radaris.com", "fastpeoplesearch.com",
  "numbuster.ru", "yandex.ru", "vk.com",
]);
const SHARED_INFRA_SUFFIXES = [
  "dns-parking.com", "registrar-servers.com", "domaincontrol.com", "googledomains.com",
  "hostinger.com", "hostinger.net", "ns.cloudflare.com",
];

function isInfraHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return SHARED_INFRA_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`)) || INFRA_DOMAINS.has(h);
}

/** The value as it may be shown, or null when it does not have the shape of its selector type. */
export function safeSelector(type: PivotType, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_SELECTOR_CHARS) return null;
  switch (type) {
    case "email":
      return EMAIL_RE.test(v) ? v : null;
    case "username": {
      const u = v.replace(/^@+/, "");
      return USER_RE.test(u) ? u : null;
    }
    case "phone": {
      const p = v.replace(/[^\d+]/g, "");
      return PHONE_RE.test(p) ? p : null;
    }
    case "domain": {
      if (!DOMAIN_RE.test(v)) return null;
      const tld = v.slice(v.lastIndexOf(".") + 1);
      if (!TLD_RE.test(tld) || isInfraHost(v)) return null;
      return v.toLowerCase();
    }
    case "ip": {
      const m = IPV4_RE.exec(v);
      if (m) return m.slice(1).every((o) => Number(o) <= 255) ? v : null;
      return IPV6_RE.test(v) ? v.toLowerCase() : null;
    }
    case "wallet":
      return ETH_RE.test(v) || BTC_RE.test(v) ? v : null;
  }
}

// ---- ranking -------------------------------------------------------------------------------------
// Same ordering law as src/lib/pivot-engine.ts so the browser and the server agree on the shared
// signals: an analyst Key outranks comparable ordinary leads, then tier, confidence, expected fan-out,
// recency. "Unsearched first" is realised by FILTERING: a selector already run is never listed, so the
// browser's +1000 status term has nothing to do here and is not carried over. Two server-only terms
// (50 in total, under the 100 gap between tiers, so they only break ties): a selector resting on a
// single independent source class (running it is how it gets a second), and one already tied to a
// multi-member cluster. Names and URLs are deliberately not ranked: a bare name query is collision
// noise (system prompt).
const KEY_BONUS = 500;
const TIER_SCORE = { high: 300, medium: 200, low: 100 } as const;
const CONF_WEIGHT = 0.6;
const YIELD_WEIGHT = 0.5;
const RECENCY_WEIGHT = 40;
const GAP_BONUS = 30;
const LINKED_BONUS = 20;
const TYPE_YIELD: Record<PivotType, number> = { email: 80, username: 70, phone: 60, wallet: 55, ip: 45, domain: 30 };
/** Types whose pivots usually reach the most linked accounts (same set the browser's explainer uses). */
const WIDE_FAN_OUT: ReadonlySet<PivotType> = new Set<PivotType>(["email", "username", "phone"]);

export type ReasonCode = "unsearched" | "analyst_key" | "analyst_recheck" | "single_source" | "linked" | "wide_fan_out";

export interface RankedPivot {
  type: PivotType;
  /** Shape-validated, as recorded. */
  value: string;
  /** `type:normalized` — the dispatch key. */
  key: string;
  score: number;
  searched: boolean;
  reasons: ReasonCode[];
  independentClasses: number;
  rows: number;
  /** How many quarantined / denied rows also carry this selector (not counted toward score). */
  alsoOnDenied: number;
}

export interface Correlation {
  /** Multi-member clusters (quarantined and excluded rows are inert there, as everywhere). */
  clusters: number;
  /** Of those, clusters whose rows span >= 2 INDEPENDENT source classes. */
  crossSourceClusters: number;
  /** At most MAX_NAMED_LINKS, shape-validated. */
  links: Array<{ tokens: string[]; rows: number; classes: number }>;
  /** Eligible selectors with no multi-member cluster behind them. */
  unlinkedLeads: number;
  /** Eligible selectors resting on fewer than two independent source classes. */
  singleSource: number;
}

export interface RankResult {
  top: RankedPivot | null;
  next: RankedPivot[];
  candidates: number;
  unsearched: number;
  searched: number;
  correlation: Correlation;
  /** Selector groups every one of whose rows is quarantined / collision / minor-flagged / blocked. */
  withheldDenied: number;
}

interface Row {
  idx: number;
  id: string;
  kind: string;
  value: string;
  source: string;
  conf: number;
  meta: Obj;
  at: string;
}

function metaOf(v: unknown): Obj {
  if (isObj(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return isObj(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Why a row may not carry authority, or null when it is live. Quarantine is released per row by `linkage_confirmed`. */
function denialOf(meta: Obj): string | null {
  if (isSubjectUnlinked(meta) && meta.linkage_confirmed !== true) return "quarantined";
  if (meta.excluded_collision === true || meta.collision === true || meta.status === "excluded") return "collision";
  if (meta.possible_minor === true || meta.minor_warning === true) return "minor";
  if (meta.auto_pivot_blocked === true) return "blocked";
  if (meta.false_positive === true) return "false_positive";
  return null;
}

function priorityFor(type: PivotType, conf: number): keyof typeof TIER_SCORE {
  if (type === "domain") return conf >= 75 ? "medium" : "low";
  return conf >= 75 ? "high" : conf >= 50 ? "medium" : "low";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface RankInput {
  /** Rows AFTER `dropRejectedAndDerived`. */
  rows: readonly BriefArtifact[];
  queried: ReadonlySet<string>;
  /** The dispatch-key sets cache.ts refuses on (in-thread + cross-case). */
  rejectedKeys: ReadonlySet<string>;
  reviewedRows: readonly ReviewedRow[];
  normalize?: (kind: string, raw: unknown) => string;
}

export function rankNextPivots(input: RankInput): RankResult {
  const normalize = input.normalize ?? normalizeSelector;

  const parsed: Row[] = input.rows.map((r, i) => ({
    idx: i,
    id: typeof r.id === "string" ? r.id : "",
    kind: typeof r.kind === "string" ? r.kind : "",
    value: typeof r.value === "string" ? r.value : "",
    source: typeof r.source === "string" ? r.source : "",
    conf: clamp(Number(r.confidence) || 0, 0, 100),
    meta: metaOf(r.metadata),
    at: typeof r.created_at === "string" ? r.created_at : "",
  }));
  // Stable by created_at; equal or missing timestamps keep read order.
  const ordered = parsed.map((r) => r).sort((a, b) => (a.at === b.at ? a.idx - b.idx : a.at.localeCompare(b.at)));
  const orderOf = new Map<number, number>();
  ordered.forEach((r, i) => orderOf.set(r.idx, i));
  const denom = Math.max(1, ordered.length - 1);

  // Analyst Key / Recheck, in the dispatch keyspace.
  const keyKeys = new Set<string>();
  const recheckKeys = new Set<string>();
  for (const rr of input.reviewedRows) {
    if (rr.state !== "key" && rr.state !== "recheck") continue;
    const t = canonicalKind(rr.kind, rr.value);
    if (!PIVOT_TYPES.has(t)) continue;
    const k = dispatchKey(t, normalize(t, rr.value));
    (rr.state === "key" ? keyKeys : recheckKeys).add(k);
  }

  // Lineage the browser also treats as "searched": a row another row names as its parent seed.
  const parentSet = new Set<string>();
  for (const r of parsed) {
    const parent = String(r.meta.parent ?? r.meta.parent_seed ?? r.meta.seed ?? "").trim();
    if (parent) parentSet.add(normalizeTarget(parent));
  }

  // Correlation over ALL surviving rows. Quarantined / excluded / bookkeeping rows are inert inside
  // clusterArtifacts, so nothing withheld can ever form a link here.
  const clusterArts: ClusterArtifact[] = parsed.map((r) => ({
    id: r.id || undefined, created_at: r.at || undefined, kind: r.kind, value: r.value, source: r.source,
    confidence: r.conf, metaRaw: JSON.stringify(r.meta),
  }));
  const clustering = clusterArtifacts(clusterArts);
  const multiIdx = new Set<number>();
  const links: Correlation["links"] = [];
  let clusters = 0;
  let crossSourceClusters = 0;
  const crossCandidates: Array<{ tokens: string[]; rows: number; classes: number }> = [];
  for (const s of clustering.subjects) {
    if (s.members.length < 2) continue;
    clusters++;
    for (const m of s.members) multiIdx.add(m.index);
    const classes = countIndependentClasses(
      s.members.flatMap((m) => classifySourceInput({ source: m.source, metadata: metaOf(parsed[m.index]?.meta) })),
    );
    if (classes < 2) continue;
    crossSourceClusters++;
    crossCandidates.push({ tokens: linkLabels(s.members.map((m) => parsed[m.index]).filter((r): r is Row => !!r)), rows: s.members.length, classes });
  }
  crossCandidates.sort((a, b) => b.classes - a.classes || b.rows - a.rows);
  for (const c of crossCandidates) {
    if (c.tokens.length >= 2) links.push(c);
    if (links.length >= MAX_NAMED_LINKS) break;
  }

  // Group selector rows by dispatch key.
  interface Group { type: PivotType; display: string; key: string; live: Row[]; denied: Row[]; first: number }
  const groups = new Map<string, Group>();
  for (const r of parsed) {
    const type = canonicalKind(r.kind, r.value);
    if (!PIVOT_TYPES.has(type)) continue;
    const display = safeSelector(type as PivotType, r.value);
    if (!display) continue;
    const norm = normalize(type, r.value);
    if (!norm) continue;
    const key = dispatchKey(type, norm);
    let g = groups.get(key);
    if (!g) {
      g = { type: type as PivotType, display, key, live: [], denied: [], first: r.idx };
      groups.set(key, g);
    }
    const bookkeeping = isBookkeepingArtifact({ kind: r.kind, value: r.value, source: r.source, confidence: r.conf, metaRaw: JSON.stringify(r.meta) });
    if (bookkeeping || denialOf(r.meta)) g.denied.push(r);
    else g.live.push(r);
  }

  const ranked: RankedPivot[] = [];
  let withheldDenied = 0;
  let singleSource = 0;
  let unlinkedLeads = 0;
  for (const g of groups.values()) {
    if (g.live.length === 0) {
      if (g.denied.length) withheldDenied++;
      continue;
    }
    // Backstop: the SAME keys dispatch refuses on, over every spelling of every carrying row.
    const refused = g.live.some((r) => kindAliases(r.kind, r.value).some((t) => input.rejectedKeys.has(dispatchKey(t, normalize(t, r.value)))));
    if (refused) continue;

    const classes = countIndependentClasses(
      g.live.flatMap((r) => classifySourceInput({ source: r.source, metadata: r.meta })),
    );
    const linked = g.live.some((r) => multiIdx.has(r.idx));
    if (classes < 2) singleSource++;
    if (!linked) unlinkedLeads++;

    const value = g.display;
    // The display form can be a reshaped spelling (phone digits, a stripped "@"); the tool log and lineage hold the
    // RECORDED spelling. Check both, or a selector already run reads as unsearched.
    const forms = new Set<string>([value, ...g.live.map((r) => r.value.trim())]);
    const searched = [...forms].some((f) => {
      const k = normalizeTarget(f);
      const ek = entityKey(f);
      return parentSet.has(k) || input.queried.has(k) || parentSet.has(ek) || input.queried.has(ek);
    });

    const isRecheck = recheckKeys.has(g.key);
    const isKey = !isRecheck && keyKeys.has(g.key);
    const status = isRecheck ? "new" : searched ? "searched" : "new";
    const conf = Math.max(...g.live.map((r) => r.conf));
    const priority = isRecheck || isKey ? "high" : priorityFor(g.type, conf);
    const newest = Math.max(...g.live.map((r) => orderOf.get(r.idx) ?? 0));
    const score = (isKey ? KEY_BONUS : 0) +
      TIER_SCORE[priority] +
      conf * CONF_WEIGHT +
      TYPE_YIELD[g.type] * YIELD_WEIGHT +
      (newest / denom) * RECENCY_WEIGHT +
      (classes < 2 ? GAP_BONUS : 0) +
      (linked ? LINKED_BONUS : 0);

    const reasons: ReasonCode[] = [];
    if (status === "new") reasons.push("unsearched");
    if (isRecheck) reasons.push("analyst_recheck");
    if (isKey) reasons.push("analyst_key");
    if (classes < 2) reasons.push("single_source");
    if (linked) reasons.push("linked");
    if (WIDE_FAN_OUT.has(g.type)) reasons.push("wide_fan_out");

    ranked.push({
      type: g.type, value, key: g.key, score, searched: status !== "new", reasons,
      independentClasses: classes, rows: g.live.length, alsoOnDenied: g.denied.length,
    });
  }
  // Stable: equal scores keep first-seen order (the sort below breaks ties on insertion order).
  const withOrder = ranked.map((p, i) => ({ p, i }));
  withOrder.sort((a, b) => b.p.score - a.p.score || a.i - b.i);
  const sorted = withOrder.map(({ p }) => p);

  const open = sorted.filter((p) => !p.searched);
  return {
    top: open[0] ?? null,
    next: open.slice(1, 3),
    candidates: sorted.length,
    unsearched: open.length,
    searched: sorted.length - open.length,
    correlation: { clusters, crossSourceClusters, links, unlinkedLeads, singleSource },
    withheldDenied,
  };
}

/**
 * Up to three selectors from a cluster, AS RECORDED, one type at a time first (an email, then a username, then a
 * phone…) so the line reads as a link between different kinds of selector. The clusterer's own tokens are not used:
 * they are FOLDED (`handle_15` becomes `handle15`, a different string the model could pivot on). Live rows only,
 * shape-validated; a cluster naming fewer than two distinct selectors is not shown as a link.
 */
function linkLabels(members: readonly Row[]): string[] {
  const byConfidence = [...members].sort((a, b) => b.conf - a.conf || a.idx - b.idx);
  const seen = new Set<string>();
  const perType = new Map<PivotType, string[]>();
  for (const r of byConfidence) {
    if (denialOf(r.meta)) continue;
    const type = canonicalKind(r.kind, r.value);
    if (!PIVOT_TYPES.has(type)) continue;
    const shown = safeSelector(type as PivotType, r.value);
    if (!shown) continue;
    const label = `${type}:${shown}`;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const list = perType.get(type as PivotType) ?? [];
    list.push(label);
    perType.set(type as PivotType, list);
  }
  const out: string[] = [];
  for (let depth = 0; out.length < 3; depth++) {
    let added = false;
    for (const list of perType.values()) {
      if (list[depth] && out.length < 3) { out.push(list[depth]); added = true; }
    }
    if (!added) break;
  }
  return out;
}

// ---- rendering -----------------------------------------------------------------------------------

function reasonWords(p: RankedPivot): string {
  const parts: string[] = [];
  for (const r of p.reasons) {
    if (r === "unsearched") parts.push("not yet run");
    else if (r === "analyst_key") parts.push("analyst-marked KEY");
    else if (r === "analyst_recheck") parts.push("analyst asked for a re-check");
    else if (r === "single_source") {
      parts.push(`only ${p.independentClasses} independent source class${p.independentClasses === 1 ? "" : "es"} so far, so a second would corroborate it`);
    } else if (r === "linked") parts.push("already tied to the subject's cluster");
    else if (r === "wide_fan_out") parts.push(`a ${p.type} usually reaches the most linked accounts`);
    if (parts.length === 3) break;
  }
  const tail = p.alsoOnDenied ? ` (also seen on ${p.alsoOnDenied} quarantined/excluded row${p.alsoOnDenied === 1 ? "" : "s"}, not counted)` : "";
  return parts.join("; ") + tail;
}

const label = (p: Pick<RankedPivot, "type" | "value">) => `${p.type}:${p.value}`;
const TOOL_NAME_RE = /^[a-z0-9_]{2,48}$/;

export interface RenderInput {
  result: RankResult;
  /** Rows the analyst rejected in this case + values rejected in other cases that occur here. */
  withheldRejected: number;
  /** Thread seed type, for the playbook's typical tools. */
  seedType?: string | null;
  /** Registered tool names; a playbook tool outside it is not suggested. */
  availableTools?: ReadonlySet<string>;
}

function typicalTools(p: RankedPivot, seedType: string | null | undefined, available?: ReadonlySet<string>): string[] {
  const list = playbookFor(seedType).pivots[p.type] ?? [];
  return list.filter((t) => TOOL_NAME_RE.test(t) && (!available || available.has(t))).slice(0, MAX_TOOLS);
}

/** The block, or null when it cannot honour the cap. Optional lines are dropped from the END first, in display order. */
export function renderResumeBrief(input: RenderInput): string | null {
  const { result } = input;
  const lines: Array<{ text: string; optional: boolean }> = [];
  const add = (text: string, optional = false) => lines.push({ text, optional });

  add("## RESUME BRIEF — server ranking as of turn start (advisory; NOT evidence: do not cite it as a source or restate its counts as findings)");
  if (result.top) {
    const tools = typicalTools(result.top, input.seedType, input.availableTools);
    add(`NEXT BEST PIVOT: ${label(result.top)} — ${reasonWords(result.top)}${tools.length ? `. Typical tools: ${tools.join(", ")}` : ""}`);
  } else {
    add("NEXT BEST PIVOT: none ranked (every eligible recorded selector has already been run).");
  }
  if (result.next.length) {
    add(`THEN: ${result.next.map((p) => `${label(p)} (not yet run)`).join(" · ")}. Once the top pick has been run, move to these.`, true);
  }
  const c = result.correlation;
  add(
    `CONNECTED: ${c.clusters} linked cluster${c.clusters === 1 ? "" : "s"} (${c.crossSourceClusters} spanning 2+ independent source classes); ` +
      `${c.unlinkedLeads} unlinked lead${c.unlinkedLeads === 1 ? "" : "s"}; ${c.singleSource} selector${c.singleSource === 1 ? "" : "s"} resting on a single source class.`,
  );
  for (const l of c.links) add(`  - ${l.tokens.join(" ↔ ")} (${l.rows} rows, ${l.classes} source classes)`, true);
  if (result.withheldDenied > 0 || input.withheldRejected > 0) {
    add(
      `WITHHELD (never candidates): ${result.withheldDenied} quarantined/excluded selector${result.withheldDenied === 1 ? "" : "s"}, ` +
        `${input.withheldRejected} analyst-rejected.`,
    );
  }
  add(
    "The analyst's latest message wins over this ranking. If you act on it, give the reason as a trailing clause on your per-cycle line " +
      "(finding — selector — tier); never as a standalone sentence before a tool call.",
  );

  const join = () => lines.map((l) => l.text).join("\n");
  while (join().length > NEXT_PIVOT_BRIEF_MAX_CHARS) {
    let last = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].optional) { last = i; break; }
    if (last < 0) break;
    lines.splice(last, 1);
  }
  const text = join();
  return text.length <= NEXT_PIVOT_BRIEF_MAX_CHARS ? text : null;
}

// ---- the gate & the composition --------------------------------------------------------------------

type MessageLike = { role?: string; parts?: Array<{ type?: string; text?: string }> | null };
type SeedLike = { kind: string; raw?: string; normalized?: string } | null;

function userText(m: MessageLike | undefined): string {
  return (m?.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
    .trim();
}

/** Kinds whose detection is a regex on the value's SHAPE. Unlike THREAD_SEED_KINDS this keeps `username`
 *  out: `detectSeedServer` calls any bare word ("continue", "next") a username. */
const BARE_SELECTOR_KINDS: ReadonlySet<string> = new Set([...THREAD_SEED_KINDS].filter((k) => k !== "username"));

/** STRUCTURAL: is the latest user message nothing but a selector (the analyst is naming a target)? */
export function latestMessageIsBareSelector(
  messages: readonly MessageLike[] | null | undefined,
  detect: (text: string) => SeedLike = detectSeedServer,
): boolean {
  const users = (messages ?? []).filter((m) => m?.role === "user");
  const text = userText(users[users.length - 1]);
  if (!text || text.length > 512) return false;
  let d: SeedLike;
  try {
    d = detect(text);
  } catch {
    return false;
  }
  if (!d?.kind) return false;
  if (BARE_SELECTOR_KINDS.has(d.kind)) return true;
  return d.kind === "username" && text.startsWith("@");
}

export type BriefReason =
  | "injected" | "disabled" | "review_state_unavailable" | "incomplete_read" | "first_turn"
  | "latest_message_is_selector" | "no_eligible_artifact" | "nothing_to_rank" | "over_cap" | "error";

export interface BriefOutcome {
  text: string | null;
  reason: BriefReason;
  /** Counts only — never a selector value. */
  stats: {
    candidates: number; unsearched: number; clusters: number; crossSourceClusters: number;
    withheldDenied: number; withheldRejected: number; chars: number;
    topType: PivotType | null; topKeyHash: string | null; topValueHash: string | null;
  };
}

const NO_STATS: BriefOutcome["stats"] = {
  candidates: 0, unsearched: 0, clusters: 0, crossSourceClusters: 0, withheldDenied: 0, withheldRejected: 0, chars: 0,
  topType: null, topKeyHash: null, topValueHash: null,
};

/** Short stable hash of a dispatch key, so "did the run go to the ranked pivot?" can be answered offline by hashing
 *  the first dispatched selector the same way. Never a value. */
export function briefKeyHash(type: string, normalizedValue: string): string {
  return stableHash(dispatchKey(type, normalizedValue));
}

/** The same, WITHOUT the type: joins to `tool_usage_log.input_json.runtime.selector` even when the wrapper's
 *  detected `selector_type` is spelled differently from the artifact kind (`handle` vs `username`, `value`). */
export function briefValueHash(normalizedValue: string): string {
  return stableHash(String(normalizedValue ?? "").trim().toLowerCase());
}

export interface BuildBriefInput {
  messages: readonly MessageLike[] | null | undefined;
  inputs: Pick<BriefInputs, "artifacts" | "usage" | "complete">;
  reviews: ReviewLoad;
  seedType?: string | null;
  availableTools?: ReadonlySet<string>;
  normalize?: (kind: string, raw: unknown) => string;
  detect?: (text: string) => SeedLike;
  disabled?: boolean;
}

export function buildResumeBrief(input: BuildBriefInput): BriefOutcome {
  const skip = (reason: BriefReason, stats = NO_STATS): BriefOutcome => ({ text: null, reason, stats });
  try {
    if (input.disabled ?? nextPivotBriefDisabled()) return skip("disabled");
    // FAIL CLOSED for the brief (this block feeds model reasoning), open for the run. `ok:false` is a
    // RETURN, not a throw, so the try/catch below would never see it.
    if (!input.reviews.ok) return skip("review_state_unavailable");
    if (!input.inputs.complete) return skip("incomplete_read");
    if (!(input.messages ?? []).some((m) => m?.role === "assistant")) return skip("first_turn");
    if (latestMessageIsBareSelector(input.messages, input.detect)) return skip("latest_message_is_selector");

    const normalize = input.normalize ?? normalizeSelector;
    const kept = dropRejectedAndDerived(input.inputs.artifacts as Obj[], input.reviews);
    const rejectedKeys = new Set<string>([
      ...buildRejectedDispatchKeys(input.reviews.rejectedRows, normalize),
      ...buildRejectedDispatchKeys(crossCaseDispatchRows(input.reviews.crossCase?.rejected, dispatchSpellings), normalize),
    ]);
    const result = rankNextPivots({
      rows: kept,
      queried: collectQueriedTargets(input.inputs.usage),
      rejectedKeys,
      reviewedRows: input.reviews.reviewedRows,
      normalize,
    });
    const withheldRejected = input.reviews.rejectedRows.length + (input.reviews.crossCase?.hiddenInCase ?? 0);
    const stats: BriefOutcome["stats"] = {
      candidates: result.candidates, unsearched: result.unsearched,
      clusters: result.correlation.clusters, crossSourceClusters: result.correlation.crossSourceClusters,
      withheldDenied: result.withheldDenied, withheldRejected, chars: 0,
      topType: result.top?.type ?? null,
      topKeyHash: result.top ? stableHash(result.top.key) : null,
      topValueHash: result.top ? briefValueHash(result.top.key.slice(result.top.key.indexOf(":") + 1)) : null,
    };
    if (result.candidates === 0) return skip("no_eligible_artifact", stats);
    if (!result.top && result.correlation.clusters === 0) return skip("nothing_to_rank", stats);
    const text = renderResumeBrief({ result, withheldRejected, seedType: input.seedType, availableTools: input.availableTools });
    if (!text) return skip("over_cap", stats);
    return { text, reason: "injected", stats: { ...stats, chars: text.length } };
  } catch {
    return skip("error");
  }
}

/** One structured log line per turn. Counts and a hash only; the hash is `stableHash(type:normalized)`. */
export function nextPivotBriefEvent(
  threadId: string,
  outcome: BriefOutcome,
  extra: { ms?: number; artifactsRead?: number; usageRowsRead?: number; readReason?: string | null } = {},
): Record<string, unknown> {
  return {
    event: outcome.text ? "next_pivot_brief" : "next_pivot_brief_skipped",
    thread_id: threadId,
    injected: !!outcome.text,
    reason: outcome.reason,
    chars: outcome.stats.chars,
    candidates: outcome.stats.candidates,
    unsearched: outcome.stats.unsearched,
    clusters: outcome.stats.clusters,
    cross_source_clusters: outcome.stats.crossSourceClusters,
    withheld_denied: outcome.stats.withheldDenied,
    withheld_rejected: outcome.stats.withheldRejected,
    top_type: outcome.stats.topType,
    top_key_hash: outcome.stats.topKeyHash,
    top_value_hash: outcome.stats.topValueHash,
    ms: extra.ms ?? null,
    artifacts_read: extra.artifactsRead ?? null,
    tool_log_rows_read: extra.usageRowsRead ?? null,
    read_incomplete_reason: extra.readReason ?? null,
  };
}

// ---- /health self-test -----------------------------------------------------------------------------

/**
 * Pure probe over a built-in fixture; PRESENCE of the `checks.next_pivot_brief` key proves the build.
 * ok:false means a rule failed its own probe. It does NOT prove index.ts still appends the block —
 * next_pivot_test.ts pins that wiring at source level.
 */
export function nextPivotBriefSelfTest(): { ok: boolean; switch: string; detail: string } {
  if (nextPivotBriefDisabled()) {
    return { ok: true, switch: "NEXT_PIVOT_BRIEF_DISABLED", detail: "LEGACY via NEXT_PIVOT_BRIEF_DISABLED: no resume brief is built" };
  }
  const rows: BriefArtifact[] = [
    { id: "a1", kind: "email", value: "probe@example.test", source: "rapidapi_breach_search", confidence: 60, metadata: {}, created_at: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "username", value: "probe_user", source: "username_sweep", confidence: 70, metadata: {}, created_at: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "username", value: "strangerhandle", source: "username_sweep", confidence: 70, metadata: { subject_unlinked: true }, created_at: "2026-01-01T00:00:03Z" },
    { id: "a4", kind: "email", value: "rejected@example.test", source: "rapidapi_breach_search", confidence: 80, metadata: {}, created_at: "2026-01-01T00:00:04Z" },
  ];
  const reviews = emptyReviewLoad(true);
  reviews.byId.set("a4", "dismissed");
  reviews.rejectedKeys.add(normalizeArtifactKey("email", "rejected@example.test"));
  reviews.rejectedRows.push({ id: "a4", kind: "email", value: "rejected@example.test" });
  const messages: MessageLike[] = [
    { role: "user", parts: [{ type: "text", text: "probe@example.test" }] },
    { role: "assistant", parts: [{ type: "text", text: "Findings report." }] },
    { role: "user", parts: [{ type: "text", text: "Continue the investigation." }] },
  ];
  const usage: BriefUsageRow[] = [{ outcome: "ok", input_json: { input: { username: "probe_user" }, runtime: { selector: "probe_user" } } }];
  const out = buildResumeBrief({ messages, inputs: { artifacts: rows, usage, complete: true }, reviews, disabled: false });
  const text = out.text ?? "";
  const ok = out.reason === "injected" &&
    text.includes("NEXT BEST PIVOT: email:probe@example.test") &&
    !text.includes("rejected@example.test") && !text.includes("strangerhandle") &&
    out.stats.withheldDenied === 1 && out.stats.withheldRejected === 1 &&
    text.length <= NEXT_PIVOT_BRIEF_MAX_CHARS &&
    buildResumeBrief({ messages: messages.slice(0, 1), inputs: { artifacts: rows, usage, complete: true }, reviews, disabled: false }).reason === "first_turn" &&
    buildResumeBrief({ messages, inputs: { artifacts: rows, usage, complete: true }, reviews: emptyReviewLoad(false, "probe"), disabled: false }).reason === "review_state_unavailable";
  return ok
    ? {
      ok: true, switch: "NEXT_PIVOT_BRIEF_DISABLED",
      detail: `resume brief ranks persisted selectors (unsearched first), withholds rejected and quarantined ones, fails closed on unreadable review state, <= ${NEXT_PIVOT_BRIEF_MAX_CHARS} chars; appended to intermediate steps only`,
    }
    : { ok: false, switch: "NEXT_PIVOT_BRIEF_DISABLED", detail: "resume-brief rule misbehaving on its own probe" };
}
