/**
 * lib/cluster.ts — DETERMINISTIC, LLM-INDEPENDENT identity clustering + confidence
 * promotion (audit C-1).
 *
 * Why this exists: in run ccc149bc the LLM correlation tool (minimax_correlate) was
 * never called (Perplexity 401-dead), so every one of 73 artifacts kept cluster_id:null
 * and confidence ≤70 — even a first-party self-admission ("616manii + ManzaVisuals +
 * Hamza Shakoor = SAME") sat at 50. This module joins the dots with a local union-find
 * over STRONG shared selectors and promotes confidence by an in-code rubric, so the
 * pipeline reports connected identities even when every LLM call fails or is skipped.
 * The LLM correlate output may only ADD candidate edges for review — it is never the
 * sole basis for a merge or a promotion.
 *
 * SAFETY / INTEGRITY:
 *  - A merge requires a CONCRETE shared strong selector (identical email/phone/handle/
 *    domain, or an explicit self-admission/ownership_proof). Never merge on a shared
 *    NAME, surname, area code, or city — that is the exact bug that fused two different
 *    people (the Oakland director vs. the Pakistani MERN dev, both "Hamza Shakoor").
 *  - excluded_collision artifacts are never pulled into a cluster; their confidence is
 *    left untouched.
 *  - A contradicted selector (a collision_detector `contradiction`/needs_review artifact)
 *    is capped at 40 and never auto-joined or promoted.
 */

// ---- Confidence tiers (JD's schema) -------------------------------------------
import { loadReviewsForThread, dropRejectedArtifacts } from "../reviews.ts";
import { normPhoneE164 } from "./selector-normalize.ts";
import { canonicalKind } from "./kind-alias.ts";

export const TIERS = { CONFIRMED: 90, LIKELY: 75, POSSIBLE: 50, WEAK: 30 } as const;
export function tierFor(conf: number): string {
  if (conf >= TIERS.CONFIRMED) return "Confirmed";
  if (conf >= TIERS.LIKELY) return "Likely";
  if (conf >= TIERS.POSSIBLE) return "Possible";
  if (conf >= TIERS.WEAK) return "Weak";
  return "Unverified";
}

// ---- Artifact shape -----------------------------------------------------------
export interface Artifact {
  /** DB primary key when clustering live rows (absent when clustering a CSV fixture). */
  id?: string;
  created_at?: string;
  kind: string;
  value: string;
  source: string;
  confidence: number;
  /** raw metadata string (the CSV export truncates the JSON, so we regex-extract
   *  the fields we need rather than JSON.parse). In the runtime path this is the full
   *  JSONB stringified, so the same extractors work. */
  metaRaw: string;
}

export interface ClusterMember extends Artifact {
  index: number;
  cluster_id: string | null;
  subject_id: string | null;
  promoted_confidence: number;
  tier: string;
  /** why this artifact landed where it did (debuggable null-cluster outcomes). */
  join_reason: string;
}

export interface JoinDecision {
  a: string;
  b: string;
  shared_selector: string;
  rule: string;
}

export interface ClusterResult {
  subjects: Array<{
    subjectId: string;
    clusterId: string;
    members: ClusterMember[];
    strongSelectors: string[];
    sources: string[];
  }>;
  members: ClusterMember[]; // every input artifact, annotated
  decisions: JoinDecision[];
}

// ---- Normalization (preserve raw; compare normalized) -------------------------
const STOP = new Set([
  "same", "person", "the", "and", "for", "with", "http", "https", "www", "com",
  "net", "org", "confirmed", "possible", "unverified", "instagram", "youtube",
  "tiktok", "twitter", "profile", "director", "photographer", "oakland", "visuals",
  "email", "breach", "password", "account", "linktree", "primary", "secondary",
]);

/**
 * URL structural separators. A URL carries its handle in a PATH SEGMENT, and
 * `foldWords` below folds on whitespace only — so the whole URL became ONE
 * unmatchable token ("https://soundcloud.com/wopdell" → "httpssoundcloudcomwopdell")
 * and a URL artifact could join a subject ONLY when its metadata happened to
 * carry a `handle` key.
 *
 * Measured on production thread 202d2756 (@wopdell, 2026-09-13): `audiomack.com/wop-dell`
 * carried `metadata.handle` and joined the subject; `beatport.com/artist/wop-dell/1461425`
 * did not and became a singleton — same artist, same handle spelling, opposite
 * outcomes. 46 of 55 graph entities were isolated leads for this reason, including
 * both Apple Music artist pages, SoundCloud, Trapaganda and Archodia. Those are the
 * rows the corroboration bar needs, so the fragmentation also starved
 * `finding-synthesis.ts` of eligible clusters.
 */
const URL_SEG_SEP = /[/:?&=#]+/;

/**
 * Stop words applied ONLY to URL path segments, never to the prose pass.
 *
 * Kept separate from STOP on purpose: STOP is shared with the established prose
 * path, so adding words to it could DELETE a token a previous build produced and
 * silently drop an existing join. This set only ever filters tokens this change
 * introduces, which keeps the whole edit additive.
 */
const URL_PATH_STOP = new Set([
  "artist", "artists", "user", "users", "channel", "channels", "track", "tracks",
  "album", "albums", "playlist", "playlists", "watch", "video", "videos", "reel",
  "reels", "status", "post", "posts", "search", "page", "pages", "about", "home",
  "index", "embed", "share", "music", "apple", "spotify", "soundcloud", "audiomack",
  "beatport", "threads", "telegram", "facebook", "reddit", "github", "linkedin",
  "shazam", "iheart", "medium", "discogs", "genius", "bandcamp", "mixcloud",
]);

/**
 * Kill switch, read at CALL TIME so it takes effect on the running build the
 * moment the secret changes — no deploy cycle. Default ON.
 *
 * Deliberately a local read rather than an import from `env.ts`: that module
 * constructs the AI gateway at load, and this one is unit-tested as a pure
 * function over CSV fixtures. `Deno.env` is guarded because the fixture CLI path
 * may run without `--allow-env`; a denied read falls back to ON, matching the
 * default rather than silently disabling the join.
 */
export function urlHandleTokensEnabled(): boolean {
  try {
    return (Deno.env.get("CLUSTER_URL_HANDLE_TOKENS_DISABLED") ?? "").trim().toLowerCase() !== "true";
  } catch {
    return true;
  }
}

export function normEmail(v: string): string | null {
  const m = String(v ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : null;
}

// MOVED to `lib/selector-normalize.ts` (2026-08-28) so the auto-persist
// extractor can call the SAME fold at write time without importing this module,
// which pulls in `../reviews.ts`. Re-exported here so every existing consumer —
// `strongTokens` below, `lib/memory_consolidate.ts` — keeps working unchanged.
//
// The move is the point: before it, this fold ran only when clustering, so the
// clusterer and the artifact table disagreed about what "one phone" is. One
// number was persisted as three rows and then correctly clustered as one.
// NOTE: imported AND re-exported, not `export … from`. `strongTokens` below
// calls it, and a bare re-export would not bind the name in this module's scope.
export { normPhoneE164 };

/** Fold a handle/username to a comparison token: lowercase, alphanumerics only. So
 * manza_visuals ≡ ManzaVisuals ≡ @manza_visuals ≡ manzavisuals(.com local part). */
export function foldHandle(v: string): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Registrable second-level label of a domain (manzavisuals.com → manzavisuals). */
export function domainRoot(v: string): string | null {
  const host = String(v ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? foldHandle(parts[parts.length - 2]) : null;
}

// djb2 → stable short hex, for subject/cluster ids and quote fingerprints.
export function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// ---- Metadata field extraction (truncation-tolerant) --------------------------
function metaStr(raw: string, key: string): string | null {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}
function metaBoolTrue(raw: string, key: string): boolean {
  return new RegExp(`"${key}"\\s*:\\s*true`, "i").test(raw);
}
/** First element of a JSON string-array field, if present (source_quotes[0]). */
function metaFirstOfArray(raw: string, key: string): string | null {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

export function isExcluded(a: Artifact): boolean {
  return a.kind === "excluded_collision" || metaBoolTrue(a.metaRaw, "excluded_collision") ||
    /"status"\s*:\s*"excluded"/i.test(a.metaRaw) ||
    // Harvested from a name-only query: linkage to the subject is UNPROVEN, so it
    // may not contribute a selector to union-find. Without this, one name search
    // merges every same-name stranger the provider returned into the subject.
    // NB: this is weaker than `excluded` — the row is an unverified lead, not a
    // ruled-out namesake — but for CLUSTERING both must be inert.
    metaBoolTrue(a.metaRaw, "subject_unlinked");
}
export function selfAdmissionQuote(a: Artifact): string | null {
  return metaStr(a.metaRaw, "source_quote") ?? metaFirstOfArray(a.metaRaw, "source_quotes");
}
export function ownershipProof(a: Artifact): string | null {
  return metaStr(a.metaRaw, "ownership_proof");
}
/** An ownership/self-admission signal that is only an UNVERIFIED LLM assertion
 *  (provenance:"llm_asserted_unverified" or provenance_verified:false) is NOT a
 *  proven first-party statement — e.g. a Steam realname the model guessed. It must
 *  never unlock the self-admission cap-override in promoteConfidence(). */
function isLlmAssertedUnverified(a: Artifact): boolean {
  return /"provenance"\s*:\s*"llm_asserted_unverified"/i.test(a.metaRaw)
    || /"provenance_verified"\s*:\s*false/i.test(a.metaRaw);
}
/** A GENUINE, proven first-party self-admission / ownership proof on THIS artifact:
 *  an explicit source_quote / ownership_proof, or a "= SAME" identity assertion —
 *  and NOT an unverified LLM assertion. This is the ONE evidence signal allowed to
 *  promote a member above its source-class cap. Deliberately NOT keyed on
 *  source_category (an "unknown" class is the absence of classification, not proof). */
export function isVerifiedSelfAdmission(a: Artifact): boolean {
  const signal = !!selfAdmissionQuote(a) || !!ownershipProof(a) || /=\s*same/i.test(a.value);
  return signal && !isLlmAssertedUnverified(a);
}
/** An EXPLICIT contradiction signal only: the collision detector's `contradiction`
 *  row (which carries `collision_value`), `contradiction: true`, or a model-written
 *  `status: "contradicted"`. NOT `status: "needs_review"`: the model stamps that on
 *  every unverified row, and reading it as a contradiction capped 1,348 of 1,528 such
 *  rows at <=40 and cut them off from the subject (measured 2026-09-24, against 155
 *  real contradiction rows). Unverified is not contradicted. */
function isContradictionArtifact(a: Artifact): boolean {
  return a.kind === "contradiction" || metaBoolTrue(a.metaRaw, "contradiction") ||
    !!metaStr(a.metaRaw, "collision_value") || /"status"\s*:\s*"contradicted"/i.test(a.metaRaw) ||
    (legacyNeedsReviewContradiction() && /"status"\s*:\s*"needs_review"/i.test(a.metaRaw));
}

/** Kill switch, read at CALL TIME: `CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION=true`
 *  restores the old rule (needs_review ⇒ contradicted) on the running build. */
export function legacyNeedsReviewContradiction(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env("CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION") ?? "").trim().toLowerCase() === "true";
}
/** The selector a contradiction artifact is about (e.g. hamzashakoor@gmail.com). */
function contradictedSelector(a: Artifact): string | null {
  const cv = metaStr(a.metaRaw, "collision_value");
  if (cv) return normEmail(cv) ?? foldHandle(cv);
  const e = normEmail(a.value);
  return e ?? null;
}

// ---- Strong-selector token extraction -----------------------------------------
/** Definite handles asserted anywhere — used as the whitelist for pulling handle
 * tokens out of prose values (so a value word only links when it matches an
 * ESTABLISHED distinctive handle, never a random word). */
export function collectKnownHandles(arts: Artifact[]): Set<string> {
  const known = new Set<string>();
  for (const a of arts) {
    if (isExcluded(a)) continue;
    if (a.kind === "username") known.add(foldHandle(a.value));
    if (a.kind === "name" && metaStr(a.metaRaw, "reclassified_from") === "username") known.add(foldHandle(a.value));
    if (a.kind === "domain") { const r = domainRoot(a.value); if (r) known.add(r); }
    for (const k of ["associated_handle", "seed_association", "instagram", "handle"]) {
      const v = metaStr(a.metaRaw, k);
      if (v) known.add(foldHandle(v));
    }
  }
  known.delete(""); for (const s of STOP) known.delete(s);
  return known;
}

/** The set of STRONG selector tokens an artifact asserts for its subject. Names are
 * deliberately excluded (collision axis). Returns [] for excluded artifacts. */
export function strongTokens(a: Artifact, knownHandles: Set<string>): string[] {
  if (isExcluded(a)) return [];
  const t = new Set<string>();

  // Primary selector by KIND — read through the alias table (lib/kind-alias.ts),
  // never off the raw spelling.
  //
  // This module was the last selector keyspace the alias table had not reached.
  // The write path (`artifactDedupKey`), the read path (`normalizeArtifactKey`)
  // and the dispatch guard all canonicalise; clustering compared `a.kind`
  // literally, so every alias spelling the rest of the pipeline treats as the
  // same selector class contributed NOTHING here and its row could only ever
  // become a singleton "unattributed cluster":
  //
  //   handle / social / social_account / github_account → no handle: token
  //   subdomain                                          → no domain: token
  //   person                                             → no reclassified-handle path
  //
  // Measured on the 2026-09-12 `baig_azhar` export: `ip_address` (auto-persist)
  // and `ip` (record_artifacts) for one value sat in two different clusters.
  //
  // NOTE ON `ip`: an IP is deliberately still NOT a strong token. Shared NAT,
  // CGNAT and hosting make IP equality a false-link hazard, the same reason
  // names are excluded above — `detectContradictions` speaks to shared infra
  // instead. Canonicalising the kind does not admit IPs to union-find; it only
  // stops the alias spellings of the kinds that ARE strong from being dropped.
  const kind = canonicalKind(a.kind, a.value);
  const email = normEmail(a.value);
  if (email) t.add(`email:${email}`);
  if (kind === "phone") { const p = normPhoneE164(a.value); if (p) t.add(`phone:${p}`); }
  if (kind === "username") t.add(`handle:${foldHandle(a.value)}`);
  if (kind === "domain") { const r = domainRoot(a.value); if (r) { t.add(`domain:${r}`); t.add(`handle:${r}`); } }
  if (kind === "name" && metaStr(a.metaRaw, "reclassified_from") === "username") {
    t.add(`handle:${foldHandle(a.value)}`); // reclassified username misfiled as a name
  }
  if (kind === "account_id") { const id = (a.value.match(/\d{5,}/) ?? [])[0]; if (id) t.add(`acct:${id}`); }

  // Metadata-asserted handles.
  for (const k of ["associated_handle", "seed_association", "instagram", "handle", "github"]) {
    const v = metaStr(a.metaRaw, k);
    if (v) { const f = foldHandle(v); if (f.length >= 3 && !STOP.has(f)) t.add(`handle:${f}`); }
  }

  // Prose value words that MATCH an established distinctive handle (whitelist join).
  for (const word of foldWords(a.value)) {
    if (knownHandles.has(word)) t.add(`handle:${word}`);
  }

  // Self-admission / ownership-proof fingerprint (links artifacts that cite the same
  // first-party statement, e.g. all the SpotFund "gone under various names" rows).
  const quote = selfAdmissionQuote(a);
  if (quote && quote.length >= 12) t.add(`quote:${stableHash(quote.toLowerCase().replace(/\s+/g, " ").trim())}`);
  const own = ownershipProof(a);
  if (own && own.length >= 12) t.add(`own:${stableHash(own.toLowerCase().replace(/\s+/g, " ").trim())}`);

  return [...t];
}

function foldWords(value: string): string[] {
  // Split on whitespace + brackets + commas only — NOT on '_'/'@'/'.' — so a handle like
  // "@manza_visuals" stays one token and folds to "manzavisuals" (matching the known
  // handle), instead of splitting into "manza"+"visuals" which match nothing.
  const chunks = String(value ?? "").split(/[\s,()[\]{}|"']+/);
  const out = new Set<string>();
  for (const chunk of chunks) {
    const w = foldHandle(chunk);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
    // SECOND, ADDITIVE pass: also fold each URL path segment of this chunk. The
    // whole-chunk token above is still emitted, so no token a previous build
    // produced can disappear and no existing join can regress — this can only ADD
    // candidates. Safety is unchanged because the CALLER (`strongTokens`) only
    // keeps a word that matches an ESTABLISHED distinctive handle, so "us",
    // "1575104299" or an 11-character video id still link nothing.
    if (!urlHandleTokensEnabled() || !URL_SEG_SEP.test(chunk)) continue;
    for (const seg of chunk.split(URL_SEG_SEP)) {
      const s = foldHandle(seg);
      if (s.length >= 3 && !STOP.has(s) && !URL_PATH_STOP.has(s)) out.add(s);
    }
  }
  return [...out];
}

// ---- Union-find ---------------------------------------------------------------
class UnionFind {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb); }
}

// ---- Confidence promotion -----------------------------------------------------
function distinctSources(members: Artifact[]): Set<string> {
  const s = new Set<string>();
  for (const m of members) for (const part of String(m.source ?? "").split(/\s*[+/,]\s*/)) { const p = part.trim().toLowerCase(); if (p) s.add(p); }
  return s;
}

/** Promote a member's confidence from the cluster's corroboration. Contradicted /
 * needs_review members are capped at 40 and never promoted. Excluded are untouched. */
export function promoteConfidence(
  member: Artifact,
  clusterMembers: Artifact[],
  opts: { contradicted: boolean; hasSelfAdmission: boolean },
): number {
  if (isExcluded(member)) return member.confidence; // untouched
  if (opts.contradicted) return Math.min(member.confidence, 40); // do NOT promote
  let conf = member.confidence;
  // Cluster co-membership (≥2 distinct sources in the subject) is NOT an
  // independent source class: the artifact's OWN sources are already priced into
  // member.confidence by applyEvidenceCaps' source-class caps. So a corroborated
  // cluster may lift a member toward "Likely" but NEVER above its own capped
  // confidence — Math.min(75, member.confidence). Otherwise a GitHub-404 dead-end
  // (conf 30) or a confirmed false positive (conf 10) rides cluster co-membership
  // up to 75/"Likely" and corrupts the downstream C-3 evidence grade.
  if (distinctSources(clusterMembers).size >= 2) conf = Math.max(conf, Math.min(TIERS.LIKELY, member.confidence));
  // The ONE legitimate promotion ABOVE the source-class cap: a PROVEN first-party
  // self-admission / ownership proof ("I am X" / "= SAME PERSON") — the strongest
  // evidence class, not weak evidence that got lucky with corroboration. Gated on
  // isVerifiedSelfAdmission (never source_category, never an llm_asserted_unverified
  // assertion), so a model-guessed Steam realname can't earn it.
  if (opts.hasSelfAdmission && isVerifiedSelfAdmission(member)) conf = Math.max(conf, TIERS.CONFIRMED); // 90 core identity
  return conf;
}

// ---- Main entry ---------------------------------------------------------------
export function clusterArtifacts(arts: Artifact[]): ClusterResult {
  const known = collectKnownHandles(arts);
  const tokensPer = arts.map((a) => strongTokens(a, known));

  // Contradicted selectors (from collision_detector artifacts) — capped, never joined.
  const contradicted = new Set<string>();
  for (const a of arts) if (isContradictionArtifact(a)) { const c = contradictedSelector(a); if (c) contradicted.add(c); }
  const memberContradicted = arts.map((a, i) => {
    if (isContradictionArtifact(a)) return true;
    const email = normEmail(a.value);
    return !!(email && contradicted.has(email));
  });

  // Union-find over shared strong tokens — but a contradicted or excluded member never
  // links (so it can't bridge two subjects), and a contradicted email links only to its
  // own contradicted siblings.
  const uf = new UnionFind(arts.length);
  const tokenOwners = new Map<string, number[]>();
  const decisions: JoinDecision[] = [];
  for (let i = 0; i < arts.length; i++) {
    if (isExcluded(arts[i]) || memberContradicted[i]) continue;
    for (const tok of tokensPer[i]) {
      const owners = tokenOwners.get(tok) ?? [];
      if (owners.length) {
        const j = owners[0];
        if (uf.find(i) !== uf.find(j)) {
          uf.union(i, j);
          decisions.push({ a: arts[j].value.slice(0, 60), b: arts[i].value.slice(0, 60), shared_selector: tok, rule: ruleFor(tok) });
        }
      }
      owners.push(i); tokenOwners.set(tok, owners);
    }
  }

  // Group contradicted-by-same-selector artifacts into one needs_review cluster each.
  const contradictedGroup = new Map<string, number>(); // selector → representative index
  // Identity of each contradicted member's GROUP, for its cluster id (see below).
  const contraKey: Array<string | null> = arts.map(() => null);
  for (let i = 0; i < arts.length; i++) {
    if (!memberContradicted[i] || isExcluded(arts[i])) continue;
    const found = normEmail(arts[i].value) ?? contradictedSelector(arts[i]);
    const sel = found ?? `idx${i}`;
    contraKey[i] = found ? `sel:${found}` : `id:${arts[i].id ?? i}`;
    if (!contradictedGroup.has(sel)) contradictedGroup.set(sel, i);
    else uf.union(i, contradictedGroup.get(sel)!);
  }

  // Assemble clusters.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < arts.length; i++) {
    if (isExcluded(arts[i])) continue;
    const r = uf.find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(i);
  }

  const members: ClusterMember[] = arts.map((a, i) => ({
    ...a, index: i, cluster_id: null, subject_id: null,
    promoted_confidence: a.confidence, tier: isExcluded(a) ? "Excluded" : tierFor(a.confidence), join_reason: "",
  }));

  const subjects: ClusterResult["subjects"] = [];
  for (const [root, idxs] of byRoot) {
    const selectors = [...new Set(idxs.flatMap((i) => tokensPer[i]))].sort();
    // A JOINED cluster's selector set is unique: any shared token would have unioned
    // the two. Contradicted groups are never unioned on tokens, so two of them can
    // carry the same set; hashing that set gave twenty unrelated singletons one
    // `clus_…`. Key a contradicted cluster by its group identity instead.
    const contraKeys = [...new Set(idxs.map((i) => contraKey[i]).filter((k): k is string => !!k))].sort();
    const hash = contraKeys.length
      ? stableHash(`contra|${contraKeys.join("|")}`)
      : stableHash(selectors.join("|") || `root${root}`);
    const subjectId = `subj_${hash}`, clusterId = `clus_${hash}`;
    const clusterArts = idxs.map((i) => arts[i]);
    const isContra = idxs.some((i) => memberContradicted[i]);
    const hasSelfAdmission = idxs.some((i) => isVerifiedSelfAdmission(arts[i]));
    const clusterMembers: ClusterMember[] = [];
    for (const i of idxs) {
      const conf = promoteConfidence(arts[i], clusterArts, { contradicted: isContra, hasSelfAdmission });
      members[i].cluster_id = clusterId;
      members[i].subject_id = subjectId;
      members[i].promoted_confidence = conf;
      members[i].tier = isContra ? tierFor(Math.min(conf, 40)) : tierFor(conf);
      members[i].join_reason = idxs.length === 1
        ? "singleton (no shared strong selector)"
        : isContra ? "contradicted selector — capped, needs_review" : `joined on ${selectors.slice(0, 3).join(", ")}`;
      clusterMembers.push(members[i]);
    }
    subjects.push({ subjectId, clusterId, members: clusterMembers, strongSelectors: selectors, sources: [...distinctSources(clusterArts)].sort() });
  }

  return { subjects, members, decisions };
}

function ruleFor(tok: string): string {
  const kind = tok.split(":")[0];
  return {
    email: "identical email", phone: "identical E.164 phone", handle: "identical folded handle/username",
    domain: "shared first-party domain", acct: "identical platform account id",
    quote: "shared first-party self-admission", own: "shared ownership_proof",
  }[kind] ?? "shared strong selector";
}

// ---- Runtime apply: write cluster_id/subject_id + surface promotion ----------
export interface ClusterUpdate {
  id: string;
  cluster_id: string | null;
  subject_id: string | null;
  promoted_confidence: number;
  tier: string;
}

/** Pure: map a cluster result to the per-artifact DB updates. Only rows that carry a
 * DB id are emitted (fixtures without ids are skipped). Excluded artifacts get
 * cluster_id/subject_id: null. */
export function clusterUpdatesFor(arts: Artifact[]): ClusterUpdate[] {
  const { members } = clusterArtifacts(arts);
  return members
    .filter((m) => m.id)
    .map((m) => ({ id: m.id!, cluster_id: m.cluster_id, subject_id: m.subject_id, promoted_confidence: m.promoted_confidence, tier: m.tier }));
}

// Minimal structural shape of the supabase client — only `from` is required. The
// query-builder chain is deliberately `any`: a precise structural type (matching
// supabase-js's real PostgrestFilterBuilder generics) makes `deno check` hit "Type
// instantiation is excessively deep and possibly infinite" (TS2589) at the index.ts call
// site — the builder's generic chain recurses past TS's resolution depth. `any` here is
// the standard escape hatch for that class of external-generic-library mismatch, not a
// laziness shortcut; every value that flows through it is re-validated at the field level
// inside applyClusteringToThread before use. No hard @supabase/supabase-js import, so
// this module stays unit-testable with a plain stub (see cluster_test.ts).
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { from(table: string): any };

/**
 * Null the persisted cluster_id / subject_id (and the promoted_confidence /
 * confidence_tier the promotion wrote into metadata) on every row in `rows`
 * that is NOT in `keptIds` and still carries an assignment. Stamps
 * `metadata.cluster_cleared_reason = "analyst_rejected"`. Authority, not
 * deletion: the row, its confidence and the rest of its metadata are untouched.
 *
 * Shared by the finalize-time clustering pass and the health-path sweep
 * (lib/rejected-cluster-sweep.ts) so both clear by ONE definition.
 */
export async function clearStaleClusterAssignments(
  admin: DbLike,
  rows: Array<Record<string, unknown>>,
  keptIds: ReadonlySet<string>,
): Promise<number> {
  let cleared = 0;
  for (const r of rows) {
    const id = typeof r.id === "string" ? r.id : "";
    if (!id || keptIds.has(id)) continue;
    const meta = (r.metadata && typeof r.metadata === "object") ? r.metadata as Record<string, unknown> : {};
    const hasStale = r.cluster_id != null || r.subject_id != null ||
      meta.cluster_id != null || meta.subject_id != null;
    if (!hasStale) continue;
    const { cluster_id: _c, subject_id: _s, promoted_confidence: _p, confidence_tier: _t, ...rest } = meta;
    void _c; void _s; void _p; void _t;
    const nextMeta = { ...rest, cluster_cleared_reason: "analyst_rejected" };
    const { error: cErr } = await admin.from("artifacts")
      .update({ cluster_id: null, subject_id: null, metadata: nextMeta }).eq("id", id);
    if (!cErr) cleared++;
  }
  return cleared;
}

/**
 * The C-1 DETERMINISTIC STEP: fetch a thread's artifacts, cluster them locally, and
 * write cluster_id/subject_id (+ surface promoted_confidence/tier in metadata, never
 * overwriting the raw observed confidence — chain-of-custody). Runs AFTER any LLM
 * correlate call, REGARDLESS of whether it succeeded/failed/was skipped. Best-effort:
 * an error here must never fail the investigation, so callers wrap it and swallow.
 */
export async function applyClusteringToThread(
  admin: DbLike,
  threadId: string,
  // artifacts.user_id is NOT NULL (no default); the cluster_decision insert below
  // omitted it, so every write hit a 23502 not-null violation and the custody
  // artifact was silently dropped (0 cluster_decision rows ever persisted). The
  // caller threads the run's authenticated user_id — same value every succeeding
  // artifact write (record_artifacts) already uses. Required for the insert to land.
  userId: string,
): Promise<{ updated: number; subjects: number; merges: number; cleared: number }> {
  const { data, error } = await admin.from("artifacts")
    .select("id,kind,value,source,confidence,metadata,cluster_id,subject_id").eq("thread_id", threadId);
  if (error || !Array.isArray(data) || data.length === 0) return { updated: 0, subjects: 0, merges: 0, cleared: 0 };
  // Analyst verdicts gate identity resolution. A rejected finding left in this set
  // does not merely reappear — it RE-SEEDS the union-find, so a value the analyst
  // said is NOT the subject can pull genuine artifacts into its cluster and be
  // promoted as the most-likely identity. Filtering here is why the rejection has
  // to reach clustering and not just the prompt.
  // FAIL-CLOSED: verdicts unreadable → cluster nothing rather than cluster on
  // unfiltered rows.
  const reviews = await loadReviewsForThread(admin as unknown as Parameters<typeof loadReviewsForThread>[0], threadId, userId);
  if (!reviews.ok) {
    console.warn(JSON.stringify({
      event: "clustering_skipped_review_state_unavailable", thread_id: threadId, error: reviews.error,
    }));
    return { updated: 0, subjects: 0, merges: 0, cleared: 0 };
  }
  // dropRejectedArtifacts, NOT the old applyReviewsToArtifacts: rejection is the
  // only decision clustering honours, and the confidence that enters union-find
  // promotion must be the RECORDED one — an analyst verdict is not evidence.
  const kept = dropRejectedArtifacts(data as Array<Record<string, unknown>>, reviews);
  // ⛔ STALE ASSIGNMENT. A rejected row is filtered out of THIS union-find, but
  // an earlier run may already have written it a cluster_id/subject_id (plus
  // promoted_confidence / confidence_tier into its metadata). Nothing cleared
  // those, so a row the analyst said is NOT the subject kept reading as a member
  // of the subject's cluster on every surface that keys on the persisted
  // columns. Clear them now — authority, not deletion: the row, its confidence
  // and its metadata otherwise stay exactly as recorded.
  const keptIds = new Set(kept.map((r) => String((r as { id?: unknown }).id ?? "")));
  const cleared = await clearStaleClusterAssignments(admin, data as Array<Record<string, unknown>>, keptIds);
  if (cleared) {
    console.log(JSON.stringify({ event: "cluster_assignment_cleared", thread_id: threadId, cleared, reason: "analyst_rejected" }));
  }
  if (kept.length === 0) return { updated: 0, subjects: 0, merges: 0, cleared };
  const arts: Artifact[] = kept.map((r) => {
    const row = r as { id: string; kind: string; value: string; source?: string; confidence?: number; metadata?: unknown };
    return {
      id: row.id, kind: row.kind ?? "", value: row.value ?? "", source: row.source ?? "",
      confidence: Number(row.confidence) || 0,
      metaRaw: typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata ?? {}),
    };
  });
  const { members, subjects, decisions } = clusterArtifacts(arts);
  const metaById = new Map(data.map((r) => {
    const row = r as { id: string; metadata?: unknown };
    const meta = (row.metadata && typeof row.metadata === "object") ? row.metadata as Record<string, unknown> : {};
    return [row.id, meta];
  }));
  let updated = 0;
  for (const m of members) {
    if (!m.id) continue;
    const meta = { ...(metaById.get(m.id) ?? {}), cluster_id: m.cluster_id, subject_id: m.subject_id, promoted_confidence: m.promoted_confidence, confidence_tier: m.tier };
    const { error: uErr } = await admin.from("artifacts")
      .update({ cluster_id: m.cluster_id, subject_id: m.subject_id, metadata: meta }).eq("id", m.id);
    if (!uErr) updated++;
  }
  // Clustering telemetry goes to the LOG, never into `artifacts`.
  //
  // This used to insert a `cluster_decision` row — `confidence: 100`, value
  // "Deterministic clustering: N subjects, M merges", source
  // "lib/cluster.ts (union-find)". That is the engine describing its own
  // bookkeeping, not an observation about the subject, and persisting it as an
  // artifact made it evidence:
  //   • it is the ONLY thing in the table at confidence 100, above every real
  //     ceiling (breach cap 60, quarantine cap 55, highest real artifact 75), so
  //     it carried more authority than any actual finding;
  //   • it has no `source_category`, no `confidence_cap_applied` and no
  //     `subject_unlinked`, so it bypassed every write-path control;
  //   • every artifact COUNT is a bare `count(*)` (useInsightsData, HomeHub, and
  //     the get_case_metrics RPC), so it inflated the Evidence number an analyst
  //     reads even though `isMetaArtifact` hides it from the list.
  //
  // Nothing ever consumed it: zero backend readers, and the only frontend
  // reference was the filter that EXCLUDES it. Its stated purpose — "makes a
  // null-cluster outcome debuggable" — is served by a structured log line, which
  // is already how this function reports clustering state (see the
  // `clustering_skipped_review_state_unavailable` warn above). The summary also
  // still reaches the caller through this function's return value.
  if (decisions.length) {
    console.log(JSON.stringify({
      event: "clustering_applied",
      thread_id: threadId,
      subject_count: subjects.length,
      merge_count: decisions.length,
      artifacts_updated: updated,
      // The number this line exists to make readable after a deploy: a subject of
      // one is an artifact that reached the graph as an isolated lead, contributed
      // no source class to any cluster, and so could never clear finding
      // synthesis's >=2-independent-class bar. Production thread 202d2756 ran at
      // 46 isolated of 55 entities.
      singleton_count: subjects.filter((s) => s.members.length === 1).length,
      decisions: decisions.slice(0, 60),
    }));
  }
  return { updated, subjects: subjects.length, merges: decisions.length, cleared };
}

// ---- CSV parsing (RFC4180, tolerant) ------------------------------------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse the artifacts CSV export into Artifact records. */
export function parseArtifactsCsv(text: string): Artifact[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iKind = col("kind"), iVal = col("value"), iSrc = col("source"), iConf = col("confidence"), iMeta = col("metadata"), iCreated = col("created_at");
  return rows.slice(1).filter((r) => r.length > iKind && r[iKind]).map((r) => ({
    created_at: iCreated >= 0 ? r[iCreated] : undefined,
    kind: (r[iKind] ?? "").trim(),
    value: r[iVal] ?? "",
    source: r[iSrc] ?? "",
    confidence: Number(r[iConf] ?? 0) || 0,
    metaRaw: r[iMeta] ?? "",
  }));
}

// ---- CLI: deno run -A lib/cluster.ts --fixture <csv> --no-llm ------------------
if (import.meta.main) {
  const args = Deno.args;
  const fi = args.indexOf("--fixture");
  const path = fi >= 0 ? args[fi + 1] : "";
  if (!path) { console.error("usage: cluster.ts --fixture <artifacts.csv> [--no-llm]"); Deno.exit(2); }
  const text = await Deno.readTextFile(path);
  const arts = parseArtifactsCsv(text);
  const result = clusterArtifacts(arts);
  const nonExcluded = result.members.filter((m) => m.tier !== "Excluded");
  const nullCluster = nonExcluded.filter((m) => m.cluster_id === null).length;
  console.log(JSON.stringify({
    artifacts: arts.length,
    non_excluded: nonExcluded.length,
    null_cluster_id: nullCluster,
    subjects: result.subjects.length,
    merges: result.decisions.length,
    top_subjects: result.subjects
      .map((s) => ({ subjectId: s.subjectId, size: s.members.length, maxConf: Math.max(...s.members.map((m) => m.promoted_confidence)), selectors: s.strongSelectors.slice(0, 6) }))
      .sort((a, b) => b.size - a.size).slice(0, 8),
  }, null, 2));
}
