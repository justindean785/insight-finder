import type { Artifact } from "@/hooks/useThreadArtifacts";
import { toSourceStrings } from "@/lib/source-strings";
import {
  AUTHORITY_HEADING,
  authorityStatement,
  keyFindingsFraming,
  recordedConfidenceCap,
  type AuthoritativeFindings,
} from "@/lib/authoritative-findings";
import { detectSeed, extractDisplaySeed } from "@/lib/seed";
import { auditEntryToolName, toolActionLabel } from "@/lib/tool-display";
import { humanizeSourceChain, primaryToolSlug, tokenizeSourceChain } from "@/lib/report-source-labels";
import { deriveToolStatus, deriveToolReason } from "@/lib/tool-run";
import { isSubjectUnlinked, isQuarantined } from "@/lib/quarantine";
// Pure (no Supabase import), so no cycle: the one rejection predicate every
// frontend consumer shares — analyst verdict OR the legacy `false_positive` flag.
import { isRejectedArtifact as isRejectedArtifactRow, buildRejectedDerivationIds } from "@/lib/analyst-decisions";
import { normalizeTarget } from "@/lib/next-step-cards";
import { detectNameConflict, formatNameConflict } from "@/lib/name-conflict";
// Derived models built here (timeline entries, pivot candidates) carry a
// per-artifact confidence that is later RENDERED, so they must carry the
// effective value — otherwise a surface displays a raw number without ever
// touching `a.confidence` itself. No cycle: display-confidence imports only
// authoritative-findings and quarantine, and neither imports this module.
import { effectiveConfidence, effectiveConfidenceOrZero } from "@/lib/display-confidence";
import {
  clusterDisplayId,
  bucketQualifiesAsCluster,
  isCollisionArtifact,
  isClusterIneligible,
  sanitizeValueForLabel,
  reportDisplayKind,
  reservedNumberAnnotation,
  dedupeBreachDatasets,
  foldAliasTwins,
  isNonEntityArtifact,
} from "@/lib/report-hygiene";

/** Analyst-grade group buckets for artifact kinds. */
export type Group =
  | "identity"
  | "contact"
  | "social"
  | "infrastructure"
  | "breach"
  | "web"
  | "crypto"
  | "affiliation"
  | "records"
  | "other";

export const GROUP_LABEL: Record<Group, string> = {
  identity: "Identity",
  contact: "Contact",
  social: "Social",
  infrastructure: "Infrastructure",
  breach: "Breach / Exposure",
  web: "Web / Archive",
  crypto: "Crypto",
  affiliation: "Organizations / Affiliations",
  records: "Records / Events",
  other: "Other",
};

export const GROUP_ORDER: Group[] = [
  "identity",
  "contact",
  "social",
  "infrastructure",
  "breach",
  "web",
  "crypto",
  "affiliation",
  "records",
  "other",
];

const KIND_TO_GROUP: Record<string, Group> = {
  name: "identity",
  person: "identity",
  avatar: "identity",
  age: "identity",
  dob: "identity",
  gender: "identity",
  email: "contact",
  phone: "contact",
  address: "contact",
  geo: "contact",
  location: "contact",
  username: "social",
  handle: "social",
  social: "social",
  account: "social",
  social_footprint: "social",
  // The live extractors emit these spellings for the same concept as `social`
  // / `account`. None was mapped, so on the @hoodken28 export every Instagram,
  // YouTube, Kick, Linktree and Apple Music profile — the subject's entire
  // public footprint — was filed under **Other**, below the breach rows.
  social_profile: "social",
  social_account: "social",
  account_id: "social",
  alias: "social",
  github_account: "social",
  github_repo: "social",
  ip: "infrastructure",
  // The extractor emits BOTH `ip` and `ip_address` for the same concept. Only
  // `ip` was mapped, so `ip_address` fell through to "other" — on the
  // leoseyes86 report that filed 206.111.150.4 and 72.23.81.65 under **Other**
  // while 75.169.97.217 sat under **Infrastructure**, splitting one entity type
  // across two sections of the same document.
  ip_address: "infrastructure",
  domain: "infrastructure",
  subdomain: "infrastructure",
  asn: "infrastructure",
  port: "infrastructure",
  host: "infrastructure",
  cert: "infrastructure",
  breach: "breach",
  // The auto-persist collapse emits breach_exposure instead of many `breach`
  // rows; without this the collapsed row silently fell through to "other".
  breach_exposure: "breach",
  bulk_corpus_harvest: "breach",
  credential_exposure: "breach",
  password: "breach",
  hash: "breach",
  leak: "breach",
  leak_paste: "breach",
  stealer_log: "breach",
  url: "web",
  archive: "web",
  page: "web",
  paste: "web",
  document: "web",
  wallet: "crypto",
  crypto: "crypto",
  crypto_wallet: "crypto",
  tx: "crypto",
  // Organisations and records are entities in the subject's network, not
  // "other" — an employer, a registry entry or a court case is exactly what an
  // analyst scans a network section for. They get their own headings so the
  // Other bucket stops being where the interesting rows go to hide.
  organization: "affiliation",
  employer: "affiliation",
  legal_record: "records",
  court_case: "records",
  criminal_case_event: "records",
  media_report: "records",
  event: "records",
};

export function groupForKind(kind: string): Group {
  return KIND_TO_GROUP[kind.toLowerCase()] ?? "other";
}

/** Confidence label used across the analyst surfaces. */
export type ConfLabel =
  | "CONFIRMED"
  /** Analyst Confirm / Key: a decision, not a second source class. */
  | "ATTESTED"
  | "CORRELATED"
  | "INFERRED"
  | "VERIFY"
  | "CONFLICT"
  | "LOW"
  | "FAILED";

// Sources that are NOT independent corroboration on their own. Breach/leak
// data alone must never produce a CONFIRMED label — it can only support an
// INFERRED or VERIFY claim until a second source class (live profile, web
// page, registry, user-provided context) backs it up.
const BREACH_ONLY_SOURCES = new Set([
  "breach_check",
  "leakcheck_lookup",
  "oathnet_lookup",
  "intelbase_email_lookup",
  "stolen.tax",
  "osintcat",
  "leakcheck",
  "oathnet",
  "intelbase",
  "snusbase",
]);

// Sweep-only sources only prove that a username string is taken on a site —
// they do NOT prove identity ownership. Cap their label at VERIFY when they
// are the sole source class.
const USERNAME_SWEEP_SOURCES = new Set([
  "username_sweep",
  "username_search",
  "deepfind_profile_analyzer",
  "deepfind_reverse_email",
  // Legacy: the stolentax_footprint tool was retired, but persisted artifacts
  // that predate metadata.source_category still carry this source slug. Keep it
  // classified sweep-only so retiring the tool never reclassifies (or uncaps)
  // historical account-discovery hits.
  "stolentax_footprint",
]);

// Direct profile sources observe the value on the actual platform and can
// return rich profile metadata. These are required to upgrade a username or
// social handle to CONFIRMED.
const DIRECT_PROFILE_SOURCES = new Set([
  "socialfetch_lookup",
  "github_user",
  "reddit_user",
  "hackernews_user",
  "gravatar_profile",
  "firecrawl_scrape",
]);

// PII kinds that should never be auto-confirmed from breach data alone.
const SENSITIVE_KINDS = new Set(["dob", "address", "phone", "ssn", "name", "person", "age"]);

export function isBreachSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  // Not `!src` alone: production carries `metadata.sources` arrays holding
  // OBJECTS, which are truthy and reach `.toLowerCase()`. A malformed source is
  // not a matching source — degrade to false, never throw inside a useMemo.
  if (typeof src !== "string" || !src) return false;
  const s = src.toLowerCase();
  return [...BREACH_ONLY_SOURCES].some((k) => s.includes(k));
}

export function isUsernameSweepSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  // Not `!src` alone: production carries `metadata.sources` arrays holding
  // OBJECTS, which are truthy and reach `.toLowerCase()`. A malformed source is
  // not a matching source — degrade to false, never throw inside a useMemo.
  if (typeof src !== "string" || !src) return false;
  const s = src.toLowerCase();
  return [...USERNAME_SWEEP_SOURCES].some((k) => s.includes(k));
}

export function isDirectProfileSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  // Not `!src` alone: production carries `metadata.sources` arrays holding
  // OBJECTS, which are truthy and reach `.toLowerCase()`. A malformed source is
  // not a matching source — degrade to false, never throw inside a useMemo.
  if (typeof src !== "string" || !src) return false;
  const s = src.toLowerCase();
  return [...DIRECT_PROFILE_SOURCES].some((k) => s.includes(k));
}

// Threat/reputation sources (VirusTotal, URLScan, EmailRep, IPQS, AbuseIPDB).
// These describe reputation/abuse signals, NOT credential breach data, and must
// never be presented under "Breach / Exposure".
// `emailrep` is a legacy slug: the emailrep tool was retired, but persisted
// reputation rows can still carry source "emailrep" — keep matching it so those
// historical rows never render under Breach / Exposure.
const REPUTATION_SOURCE_RE = /virustotal|urlscan|ipqualityscore|ipqs|abuseipdb|emailrep|reputation|threat/i;

/** True when an artifact is a threat/reputation signal rather than a breach. */
export function isReputationArtifact(a: { kind: string; source: string | null; metadata: Record<string, unknown> | null }): boolean {
  const kind = a.kind.toLowerCase();
  if (kind === "threat_reputation" || kind === "reputation_signal") return true;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const sc = Array.isArray(meta.source_category) ? meta.source_category.map((s) => String(s)) : [];
  if (sc.includes("infra_reputation")) return true;
  return REPUTATION_SOURCE_RE.test(a.source ?? "");
}

/**
 * Display kind for an artifact. Remaps a row the model mis-kinded as `breach`
 * but which actually came from a reputation source to `threat_reputation`, so
 * VirusTotal/URLScan results never render under Breach / Exposure.
 */
export function displayKind(a: { kind: string; source: string | null; metadata: Record<string, unknown> | null }): string {
  const kind = a.kind.toLowerCase();
  if ((kind === "breach" || kind === "breach_exposure") && isReputationArtifact(a)) {
    return "threat_reputation";
  }
  return a.kind;
}

export function isSensitiveKind(kind: string, meta?: Record<string, unknown>): boolean {
  if (SENSITIVE_KINDS.has(kind.toLowerCase())) return true;
  if (meta && (meta.sensitive === true || meta.pii === true)) return true;
  return false;
}

// Back-compat alias for internal callers.

/**
 * Optional analyst review state (from local review store) that overrides or
 * adjusts the source-derived confidence.
 */
export type ReviewAdjustment =
  | "new"
  | "confirmed"
  | "key"
  | "recheck"
  | "dismissed"
  | "wrong"
  | null
  | undefined;

const REVIEW_DELTA: Record<string, number> = {
  confirmed: 20,
  key: 25,
  recheck: -20,
  wrong: -40,
};

/** Minor-safety ceiling. A possible-minor row can never auto-promote. */
export const POSSIBLE_MINOR_CEILING = 55;
/**
 * Quarantine ceiling for `subject_unlinked` rows. Same value as the backend's
 * write-side cap, so the client cannot render a number the server refused to
 * persist. Kept as a named constant rather than a literal because the label
 * ladder reasons about the same threshold.
 */
export const QUARANTINE_CEILING = 55;

/**
 * The server's recorded source-class ceiling for a row, or null.
 *
 * `metadata.confidence_cap_applied` is written by the backend's integrity layer
 * (`auto-record-integrity.ts` — `confidence_cap_applied: cap.cap`) and encodes a
 * specific claim: *this row's source classes cannot support more than N*
 * (breach-only ≤60, username_sweep-only ≤45, `social_profile_passive` ≤40,
 * `ai_summary` ≤55). It is the same kind of assertion as the two ceilings above,
 * just per-row rather than per-flag.
 *
 * Total on purpose. `metadata` is untyped JSON off the wire and is partly
 * model-authored, so anything unparseable yields null and scoring falls back to
 * its normal path. Note the value can only ever LOWER a displayed number, never
 * raise one, so an unusable or hostile value cannot inflate a row — the failure
 * mode is fail-safe in the direction that matters.
 */


export function adjustedConfidence(a: Artifact, review?: ReviewAdjustment): number {
  const base = a.confidence ?? 0;
  const d = review ? REVIEW_DELTA[review] ?? 0 : 0;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = toSourceStrings(meta.sources);
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  // ── THIS IS A CLASSIFICATION SCORE, NOT A DISPLAYED NUMBER ────────────────
  //
  // Read the docstring above before changing anything here. As of 2026-08-31 the
  // ONLY consumer of this function is `labelForArtifact`, and the number it
  // returns is never rendered. What an analyst reads is
  // `displayConfidence(a).effective` = `min(stored, confidence_cap_applied)` and
  // nothing else — see src/lib/display-confidence.ts.
  //
  // That split is the whole fix. This function used to be BOTH: it fed the label
  // ladder AND was rendered by EvidenceMatrixTab, so its corroboration bonus
  // showed up as a number no other surface agreed with —
  // `j.harker@northgate-logistics.com` stored 88 and displayed 93 on exactly one
  // tab. The terms below were never wrong for CLASSIFICATION; they were wrong as
  // a figure, because independence is measured server-side by
  // `countIndependentClasses` and re-crediting it in a rendered number counts the
  // same sources twice.
  //
  // So they stay, here, where the ladder is tuned against them. Deleting them and
  // then lowering the thresholds to compensate is the same computation with more
  // moving parts, and it silently re-tunes rungs that no test pins.
  //
  // The rule is one line: this value classifies, it never displays. The source
  // guard in `display-confidence-contract.test.ts` enforces it — no component
  // file may call this function.
  const classes = new Set(
    allSources.map((s) =>
      isBreachSource(s)
        ? "breach"
        : isUsernameSweepSource(s)
        ? "sweep"
        : s.toLowerCase().split(/[_:.]/)[0],
    ),
  );
  let bonus = 0;
  if (classes.size >= 3) bonus += 10;
  else if (classes.size >= 2) bonus += 5;
  // Direct profile observation is the strongest single signal.
  if (allSources.some((s) => isDirectProfileSource(s))) bonus += 5;
  // Breach-only signals get pulled down a hair to fight false certainty.
  if (allSources.length > 0 && allSources.every((s) => isBreachSource(s))) bonus -= 5;
  // Sweep-only handles never imply identity ownership.
  if (allSources.length > 0 && allSources.every((s) => isUsernameSweepSource(s))) bonus -= 10;
  // Explicit conflict / collision metadata is a strong negative signal.
  if (meta.conflict === true || meta.collision === true) bonus -= 15;
  // The server's per-row source-class ceiling, folded into whichever limit
  // applies below so the STRICTER of the two always wins. Applied to every
  // return path rather than as a fourth branch: a quarantined row whose cap is
  // 40 must land on 40, not on the looser QUARANTINE_CEILING of 55.
  //
  // This clamps the analyst review delta too, matching how POSSIBLE_MINOR_CEILING
  // already treats it. That is deliberate — `confidence_cap_applied` is a
  // statement about what this row's EVIDENCE can support, and a review verdict
  // is not new evidence. The escape hatch for genuine adjudication is
  // `linkage_confirmed`, which is explicit and durable, not a one-click verdict
  // (the review control is known to invert on quarantined rows, so it must not
  // be able to overrule an evidence ceiling on a mis-click).
  //
  // The corroboration bonus is clamped for a second, independent reason: it is a
  // DOUBLE COUNT. The server already measured independence with
  // `countIndependentClasses` over the authoritative taxonomy before setting the
  // cap; re-adding a coarse client-side estimate on top re-credits the same
  // sources twice.
  const recordedCap = recordedConfidenceCap(meta);
  const ceil = (limit: number) => (recordedCap === null ? limit : Math.min(limit, recordedCap));
  // Possible-minor signal forces a cap so the artifact never auto-promotes.
  if (meta.possible_minor === true) {
    return Math.max(0, Math.min(ceil(POSSIBLE_MINOR_CEILING), base + d + bonus));
  }
  // Quarantine is the SECOND ceiling, for the same reason and with the same shape.
  // #448 gave `subject_unlinked` a hard floor at the LABEL (labelForArtifact) but
  // left the NUMBER uncapped, which breaks the invariant the possible_minor branch
  // above exists to hold — see its comment in labelForArtifact: the cap is there
  // "so number and label stay consistent". Without this, a quarantined row renders
  // 65, or 85 once attested, beside a deliberately non-CONFIRMED label, and
  // EvidenceMatrixTab shows that number to the analyst as the score.
  //
  // The backend already enforces this ceiling on write — canary run 4d0193c7
  // observed max confidence 55 across all 24 quarantined rows — so an uncapped
  // client value is the display contradicting the persisted record.
  //
  // Asymmetric on purpose: quarantine is a CEILING, never a floor. Positive
  // corroboration and positive review deltas are dropped, because neither speaks
  // to whether the row is THIS SUBJECT'S; negatives are kept in full, so a
  // quarantined row that other signals push down still goes down.
  //
  // `isQuarantined` (not `isSubjectUnlinked`) is deliberate: it returns false once
  // `linkage_confirmed` is set, preserving #448's explicit escape hatch — an
  // analyst who has actually adjudicated provenance restores full authority here
  // exactly as they do at the label boundary.
  if (isQuarantined(meta)) {
    return Math.max(0, Math.min(ceil(QUARANTINE_CEILING), base + Math.min(0, d) + Math.min(0, bonus)));
  }
  return Math.max(0, Math.min(ceil(100), base + d + bonus));
}

// Source classes that do NOT, on their own, constitute independent corroboration
// of an identity/association claim (discovery, low-trust aggregators, single AI
// summaries, shared-host, ransomware-victim threat-intel). Mirrors the backend
// taxonomy in supabase/functions/osint-agent/source-classification.ts
// (NON_CORROBORATING_CLASSES) so two sources in the SAME non-corroborating class
// can never masquerade as independent corroboration.
const NON_CORROBORATING_CLASSES = new Set<string>([
  "unknown",
  "web_search",
  "ai_summary",
  "username_sweep",
  "social_profile_passive",
  "social_review",
  "infra_shared_host",
  "threat_intel",
]);

/** Metadata counters a lookup writes for "how many records matched". */
const NEGATIVE_COUNT_KEYS = [
  "total_breaches", "breaches_found", "breach_hits", "found", "total", "total_pastes",
  "stealer_rows", "victim_logs", "results_count",
] as const;
const NEGATIVE_LOOKUP_STATUSES = new Set(["not_found", "restricted", "blocked", "denied", "error"]);

/**
 * A row that records a lookup finding NOTHING: zero breach hits, a 404 profile,
 * `lookupStatus: not_found`. It is a coverage fact ("we checked X"), not an
 * observation about the subject — so it must never link a selector to a cluster
 * or count as a corroborating source class. Live case 2026-09-25: zero-hit
 * breach checks on GUESSED `<handle>@outlook/yahoo` emails merged into the
 * subject's cluster on the local-part and supplied its `breach` class, and the
 * report printed "3 independent source classes" for one profile lookup.
 *
 * Structured metadata only: every present match counter is 0 (and none is
 * positive), a not-found/blocked lookup status, or a 4xx HTTP status.
 */
export function isNegativeResultArtifact(a: Artifact): boolean {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const status = typeof meta.lookup_status === "string" ? meta.lookup_status.trim().toLowerCase() : "";
  if (NEGATIVE_LOOKUP_STATUSES.has(status)) return true;
  const http = Number(meta.http_status);
  if (Number.isFinite(http) && http >= 400 && http < 500) return true;
  const counts = NEGATIVE_COUNT_KEYS
    .map((k) => meta[k])
    .filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
  return counts.length > 0 && counts.every((v) => v === 0);
}

/**
 * Distinct source CLASSES backing an artifact. Prefers the backend's
 * authoritative `metadata.source_category` (written by the source-classification
 * layer), which already collapses same-class providers — census + nominatim both
 * classify to `public_record`, exa + gemini both to `ai_summary` — so they can
 * never present as two independent classes. Falls back to a coarse split of the
 * raw source strings only for legacy rows that predate `source_category`.
 */
function artifactSourceClasses(a: Artifact): string[] {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const sc = meta.source_category;
  if (Array.isArray(sc)) {
    const cats = sc.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    if (cats.length) return Array.from(new Set(cats));
  } else if (typeof sc === "string" && sc.trim()) {
    return [sc.trim().toLowerCase()];
  }
  const metaSources = toSourceStrings(meta.sources);
  const all = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  return Array.from(
    new Set(
      all.map((s) =>
        isBreachSource(s)
          ? "breach"
          : isUsernameSweepSource(s)
          ? "username_sweep"
          : s.toLowerCase().split(/[_:.]/)[0],
      ),
    ),
  );
}

/** Count of distinct source classes that can INDEPENDENTLY corroborate a claim.
 *  Non-corroborating classes (discovery / low-trust / single-AI-summary) are
 *  excluded, so census+nominatim (one `public_record` class) count once and
 *  exa+gemini (`ai_summary` only) count zero. */
function independentSourceClassCount(a: Artifact): number {
  return artifactSourceClasses(a).filter((c) => !NON_CORROBORATING_CLASSES.has(c)).length;
}

/**
 * The independent (corroborating) source classes backing a CLUSTER — the union
 * of each member artifact's independent classes. A cluster is corroborated when
 * two such classes back it, whether both come from one artifact or one from each
 * of two: corroboration is a property of the claim, not of a single row.
 *
 * Deliberately NOT `cluster.sources.length`. That field holds raw source STRINGS
 * (tool ids) — the report renders it elsewhere as "Source tools:" — and two tool
 * ids are not two independent classes. The taxonomy collapses census + nominatim
 * to a single `public_record`, and excludes discovery / AI-summary / sweep
 * classes from corroborating anything. Measured on production 2026-08-24: 388
 * artifacts carry >=2 raw categories but only 123 carry >=2 independent ones, so
 * counting raw sources would over-report corroboration by ~3.2x.
 */
function clusterIndependentSourceClasses(c: IdentityCluster): string[] {
  const out = new Set<string>();
  for (const a of c.artifacts) {
    // A zero-hit row observed nothing, so it corroborates nothing.
    if (isNegativeResultArtifact(a)) continue;
    for (const cls of artifactSourceClasses(a)) {
      if (!NON_CORROBORATING_CLASSES.has(cls)) out.add(cls);
    }
  }
  return Array.from(out);
}

/** A cluster is corroborated when >=2 INDEPENDENT source classes back it. Same
 *  bar `labelForArtifact` uses to award CONFIRMED, applied at cluster scope. */
const CLUSTER_CORROBORATION_MIN_CLASSES = 2;

/** Distinct independent source strings ("corpora") after case-insensitive dedup.
 *  `meta.sources` frequently repeats `a.source`, so a single corpus otherwise
 *  reads as two sources. Used to gate breach-email corroboration. */
function distinctSourceCount(sources: string[]): number {
  return new Set(sources.map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
}

export function labelForArtifact(a: Artifact, review?: ReviewAdjustment): ConfLabel {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  if (review === "dismissed" || review === "wrong" || meta.false_positive === true) return "FAILED";
  if (meta.conflict === true || meta.collision === true) return "CONFLICT";
  // Analyst attestations short-circuit to CONFIRMED — EXCEPT for a possible-minor
  // row. Minor-safety is a HARD FLOOR: attestation must never label-promote a
  // potential minor to CONFIRMED (which downstream renders/exports as a confirmed
  // finding — it leads Key Findings, the "Confirmed" KPI/bucket, and skips value
  // sanitization). adjustedConfidence already caps a possible_minor's number at 55;
  // skipping the short-circuit makes the LABEL respect that cap too — the row flows
  // through the source-derived tiers below (max VERIFY at 55), so number and label
  // stay consistent. The analyst review itself is still recorded.
  // QUARANTINE IS A SECOND HARD FLOOR, alongside possible_minor. `subject_unlinked`
  // says linkage to the subject is unproven; CONFIRMED asserts the row IS the
  // subject's. Those cannot both be true, and CONFIRMED is not cosmetic — it leads
  // Key Findings, feeds the "Confirmed" KPI bucket, and skips value sanitization on
  // export.
  //
  // Ordinary attestation does NOT clear it. `meta.reviewed`/"confirmed"/"key" are
  // set by flows that never adjudicated PROVENANCE — they answer "is this value
  // real?", not "is it this person's?". Quarantine is a machine claim about
  // provenance, so only an explicit human claim about provenance clears it:
  // `linkage_confirmed`. Operator-approved policy, 2026-08-10.
  //
  // The analyst's review is still recorded, and still authoritative in the NEGATIVE
  // direction — a dismissal above already returned FAILED.
  // One predicate, shared with evidenceStatus — see isQuarantined's docstring for
  // why two independent promotion paths must not each compute this themselves.
  const quarantined = isQuarantined(meta);

  const attested = review === "confirmed" || review === "key" || meta.reviewed === true;
  // An analyst decision gets its OWN rung. It used to return CONFIRMED, so a
  // row at recorded confidence 40 read "CONFIRMED" beside a legend defining
  // CONFIRMED as two independent source classes — the number and the label
  // disagreed in the same table row. ATTESTED renders as ANALYST-CONFIRMED,
  // still counts as verified on the board, and never touches the figure.
  if (attested && meta.possible_minor !== true && !quarantined) {
    // Evidence that already clears the CONFIRMED bar on its own keeps the
    // stronger, evidence-derived label; the decision never downgrades it.
    const evidence = labelForArtifact({ ...a, metadata: { ...meta, reviewed: false } }, undefined);
    return evidence === "CONFIRMED" ? "CONFIRMED" : "ATTESTED";
  }

  const metaSources = toSourceStrings(meta.sources);
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  // Independent corroboration is counted from the backend's authoritative
  // source_category (which already collapses same-class providers), NOT a naive
  // first-token split of the raw source strings — see independentSourceClassCount.
  const independentClasses = independentSourceClassCount(a);
  const breachOnly =
    allSources.length > 0 && allSources.every((s) => isBreachSource(s));
  const sweepOnly =
    allSources.length > 0 && allSources.every((s) => isUsernameSweepSource(s));
  const hasDirectProfile = allSources.some((s) => isDirectProfileSource(s));
  const sensitive = isSensitiveKind(a.kind, meta);
  const kind = a.kind.toLowerCase();
  const isIdentity = kind === "username" || kind === "handle" || kind === "social" || kind === "name" || kind === "person";
  // Cluster-linkage hint: artifact carries seed-email parent ⇒ it can rise to CORRELATED.
  const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim().toLowerCase();
  const seedLinked = !!parent && parent.includes("@");

  const c = adjustedConfidence(a, review);

  // Sweep-only handles only prove the username is taken on some site —
  // never identity ownership. Cap at VERIFY.
  if (sweepOnly) {
    return "VERIFY";
  }
  // Breach-only sensitive PII (name/phone/address/DOB/SSN) can never be
  // auto-CONFIRMED. If linked to the seed email it can rise to CORRELATED;
  // otherwise stays at VERIFY.
  if (breachOnly && sensitive) {
    return seedLinked ? "CORRELATED" : "VERIFY";
  }
  // Breach-only non-sensitive data → max INFERRED. Email seen in ≥2 breach
  // sources can rise to CORRELATED (still not CONFIRMED).
  if (breachOnly) {
    // Email seen in ≥2 DISTINCT breach corpora can rise to CORRELATED. Dedup
    // first: meta.sources often repeats a.source, so a single corpus otherwise
    // reads as length 2 and over-promotes the most sensitive PII class.
    if (kind === "email" && distinctSourceCount(allSources) >= 2) return "CORRELATED";
    return c >= 70 ? "INFERRED" : c >= 40 ? "VERIFY" : "LOW";
  }
  // Username / social handle can only be CONFIRMED when a direct profile
  // source actually observed it on the platform.
  if (isIdentity && !hasDirectProfile) {
    if (c >= 70 && independentClasses >= 2) return "CORRELATED";
    return c >= 50 ? "INFERRED" : "VERIFY";
  }

  // Multi-source-class corroboration → CONFIRMED / CORRELATED.
  //
  // Corroboration cannot lift quarantine, and this is the clause that matters most:
  // it proves the VALUE is real, never that it is the SUBJECT's. Ten providers
  // agreeing a phone number exists says nothing about whose phone it is — and a
  // name-only harvest returns exactly that shape, several sources describing one
  // real stranger. So a quarantined row tops out at CORRELATED ("real, apparently
  // connected") rather than CONFIRMED ("belongs to the subject").
  // THRESHOLDS ARE UNCHANGED AT EVERY RUNG, deliberately.
  //
  // An earlier pass deleted the corroboration bonus from this function and then
  // lowered this comparison 85 -> 80 to compensate, on the reasoning that a
  // two-class row scored +5 so the effective bar had always been 80. The
  // arithmetic was right and the change was still wrong: it re-tuned
  // CLASSIFICATION as a side effect of a DISPLAY fix, and it only compensated the
  // one rung that happened to have a test. The +5 also lifted rows over the 70
  // CORRELATED rung and the identity branch's own 70, and the separate
  // direct-profile +5 lifted rows over 85 / 65 / 40 — none of which any test
  // pins, so those would have moved silently.
  //
  // The split resolves it without touching a single threshold: the terms this
  // ladder is tuned against still exist, in the classification score above, and
  // what was removed is only their reach into the RENDERED figure. Classification
  // may weigh source independence; a displayed number may not re-derive it.
  if (c >= 85 && independentClasses >= 2) return quarantined ? "CORRELATED" : "CONFIRMED";
  if (c >= 70 && independentClasses >= 2) return "CORRELATED";
  if (c >= 85) return "INFERRED"; // single source class, even if high confidence
  if (c >= 65) return "INFERRED";
  if (c >= 40) return "VERIFY";
  return "LOW";
}

export const CONF_LABEL_HELP: Record<ConfLabel, string> = {
  CONFIRMED: "Supported by ≥2 independent source classes.",
  ATTESTED: "Analyst-confirmed. A decision, not a second source — the evidence figure is unchanged.",
  CORRELATED: "Multiple artifacts point together but no definitive proof.",
  INFERRED: "Source states this but it is not independently corroborated.",
  VERIFY: "Possible match. Needs verification before reporting.",
  CONFLICT: "Conflicts with seed or another identity cluster.",
  LOW: "Low confidence. Treat as a lead, not a finding.",
  FAILED: "Marked as a false positive by the analyst.",
};

export const CONF_LABEL_CLASS: Record<ConfLabel, string> = {
  CONFIRMED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
  ATTESTED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))] border-dashed bg-[hsl(var(--confidence-high))]/10",
  CORRELATED: "text-[hsl(var(--confidence-high))]/90 border-[hsl(var(--confidence-high))]/30 bg-[hsl(var(--confidence-high))]/5",
  INFERRED: "text-primary border-primary/40 bg-primary/10",
  VERIFY: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  CONFLICT: "text-destructive border-destructive/40 bg-destructive/10",
  LOW: "text-muted-foreground border-border bg-secondary/60",
  FAILED: "text-destructive border-destructive/40 bg-destructive/10 line-through",
};

// ---- Pivot inference ---------------------------------------------------

export type PivotType =
  | "email"
  | "username"
  | "domain"
  | "url"
  | "ip"
  | "name"
  | "wallet"
  | "phone";

export type Pivot = {
  value: string;
  type: PivotType;
  why: string;
  source: string;
  sourceArtifactId: string;
  confidence: number;
  fanout: string;
  status: "new" | "searched";
};

const PIVOT_FANOUT: Record<PivotType, string> = {
  email: "Hunter → IntelBase → OathNet → OSINTNova",
  username: "Built-in username sweep → social fetch",
  domain: "crt.sh, Shodan, hackertarget, urlscan",
  url: "urlscan, Wayback, page archive",
  ip: "Shodan, hackertarget, reverse DNS",
  name: "People search, social handle cross-ref",
  wallet: "Chain explorers, sanctions feeds",
  phone: "Carrier lookup, social reverse lookup",
};

export const KIND_TO_PIVOT: Record<string, PivotType> = {
  email: "email",
  username: "username",
  handle: "username",
  social: "username",
  domain: "domain",
  subdomain: "domain",
  url: "url",
  ip: "ip",
  ip_address: "ip",
  name: "name",
  person: "name",
  wallet: "wallet",
  crypto: "wallet",
  phone: "phone",
};

// Domains that are data sources / search infrastructure, not subject
// identifiers. Pivoting on "opencorporates.com" or "bizfile.ca.gov" wastes a
// tool cycle and clutters the lead list — these are HOW evidence was gathered,
// never WHO the subject is.
const INFRA_DOMAINS = new Set([
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

// Shared DNS / parking / registrar-nameserver providers. A name server such as
// helios.dns-parking.com tells you who HOSTS the zone, never who OWNS the domain: thousands of unrelated
// domains share it. Suffix-matched (the first label is per-customer or per-pool), so they are never
// offered as a subject pivot. Disclosure of the nameserver itself is unaffected — it stays in the evidence.
const SHARED_INFRA_SUFFIXES = [
  "dns-parking.com", "registrar-servers.com", "domaincontrol.com", "googledomains.com",
  "hostinger.com", "hostinger.net", "ns.cloudflare.com",
];

/** True when a domain/URL value is OSINT source infrastructure, not a subject identifier. */
export function isInfraDomain(value: string): boolean {
  try {
    const host = value.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (SHARED_INFRA_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
    return INFRA_DOMAINS.has(host);
  } catch {
    return false;
  }
}

/**
 * Build a deduped pivot queue from current artifacts. A pivot is "searched"
 * when another artifact already references it as a parent/source seed.
 */
export function buildPivots(artifacts: Artifact[], seedValue: string | null): Pivot[] {
  const seedNorm = (seedValue ?? "").trim().toLowerCase();

  // Track which raw values have been used as a parent/source seed by later artifacts.
  const searched = new Set<string>();
  for (const a of artifacts) {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const parent = String(m.parent ?? m.parent_seed ?? m.seed ?? "").trim().toLowerCase();
    if (parent) searched.add(parent);
  }

  const seen = new Map<string, Pivot>();
  for (const a of artifacts) {
    const pType = KIND_TO_PIVOT[a.kind.toLowerCase()];
    if (!pType) continue;
    const v = a.value.trim();
    if (!v) continue;
    const key = `${pType}:${v.toLowerCase()}`;
    if (seen.has(key)) continue;
    if (v.toLowerCase() === seedNorm) continue; // skip the seed itself
    // Skip source-infrastructure domains — these are OSINT tool sources
    // (bizfile.com, opencorporates.com, bbb.org…), not subject identifiers.
    // Pivoting on them produces nothing actionable.
    if ((pType === "domain" || pType === "url") && isInfraDomain(v)) continue;
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    if (meta.false_positive === true) continue;

    seen.set(key, {
      value: v,
      type: pType,
      why: `${pType[0].toUpperCase() + pType.slice(1)} discovered via ${a.source ?? "tool"}. Expand to find linked accounts.`,
      source: a.source ?? "—",
      sourceArtifactId: a.id,
      confidence: effectiveConfidenceOrZero(a),
      fanout: PIVOT_FANOUT[pType],
      status: searched.has(v.toLowerCase()) ? "searched" : "new",
    });
  }

  // New pivots first, then by confidence desc.
  return Array.from(seen.values()).sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

// ---- Timeline ----------------------------------------------------------

export type TimelineEventType =
  | "seed"
  | "triage"
  | "tool_result"
  | "artifact"
  | "cache_replay"
  | "failed"
  | "report";

export type TimelineItem = {
  id: string;
  time: string;
  type: TimelineEventType;
  title: string;
  source: string | null;
  confidence: number | null;
  kind: string | null;
  explanation: string;
};

/**
 * Build a timeline strictly from artifact rows. Triage / cache / failed
 * events are detected from metadata flags. When `messages` is provided,
 * user queries, tool invocations, and report-generated markers are
 * interleaved with the artifact stream.
 */
export function buildTimelineItems(
  artifacts: Artifact[],
  seed: { value: string | null; type: string | null; createdAt?: string | null } | null,
  messages?: Array<{ id: string; role: string; created_at: string; summary: string; toolCalls: Array<{ toolName: string; resultSummary?: string }> }>,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  // ---- Seed event ----
  if (seed?.value && seed.createdAt) {
    items.push({
      id: "seed",
      time: seed.createdAt,
      type: "seed",
      title: seed.value,
      source: null,
      confidence: null,
      kind: seed.type ?? null,
      explanation: "Investigation seed submitted.",
    });
  }

  // ---- Message-level events ----
  if (messages) {
    for (const msg of messages) {
      // User follow-up queries
      if (msg.role === "user" && msg.summary && msg.summary.length > 0) {
        items.push({
          id: `msg-${msg.id}`,
          time: msg.created_at,
          type: "seed",
          title: msg.summary,
          source: null,
          confidence: null,
          kind: "query",
          explanation: "Follow-up query submitted.",
        });
      }
      // Tool calls
      for (const tc of msg.toolCalls) {
        items.push({
          id: `tc-${msg.id}-${tc.toolName}`,
          time: msg.created_at,
          type: "tool_result",
          title: tc.toolName,
          source: tc.toolName,
          confidence: null,
          kind: "tool_call",
          explanation: tc.resultSummary
            ? `Tool ${tc.resultSummary}.`
            : "Tool invoked.",
        });
      }
      // Report generation markers
      if (msg.role === "assistant" && /report/i.test(msg.summary)) {
        items.push({
          id: `report-${msg.id}`,
          time: msg.created_at,
          type: "report",
          title: "Report generated",
          source: null,
          confidence: null,
          kind: "report",
          explanation: "Final investigation report completed.",
        });
      }
    }
  }

  // ---- Artifact events ----

  for (const a of artifacts) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const isTriage = a.kind.toLowerCase() === "triage" || meta.triage === true || String(a.source ?? "").toLowerCase().includes("triage");
    const isCache = meta.cached === true || meta._cached === true || meta.cache === true;
    const isFailed = meta.false_positive === true || meta.failed === true || meta.skipped === true;

    let type: TimelineEventType = "artifact";
    let explanation = `Recorded ${a.kind} from ${a.source ?? "unknown source"}.`;
    if (isTriage) {
      type = "triage";
      explanation = "Triage decision recorded.";
    } else if (isFailed) {
      type = "failed";
      explanation = meta.skipped === true
        ? "Source skipped by gate."
        : "Marked as failed / false positive.";
    } else if (isCache) {
      type = "cache_replay";
      explanation = "Result served from cache.";
    }

    items.push({
      id: a.id,
      time: a.created_at,
      type,
      title: a.value,
      source: a.source,
      confidence: effectiveConfidence(a),
      kind: a.kind,
      explanation,
    });
  }

  items.sort((x, y) => new Date(x.time).getTime() - new Date(y.time).getTime());
  return items;
}

// ---- Tool audit --------------------------------------------------------

export type ToolAuditEntry = {
  /** Grouping key: the producing tool's slug (see primaryToolSlug). */
  tool: string;
  /** The raw `source` spellings folded into this entry, first-seen order. */
  variants: string[];
  totalResults: number;
  highConf: number;
  /** Analyst-confirmed (ATTESTED): a decision, not evidence strength — counted apart from highConf. */
  attested: number;
  lowConf: number;
  cached: number;
  failed: number;
  kinds: string[];
};

export type ToolAudit = {
  tools: ToolAuditEntry[];
  cachedCount: number;
  failedCount: number;
  kindsCovered: Set<string>;
};

export function buildToolAudit(
  artifacts: Artifact[],
  reviews?: Record<string, ReviewAdjustment> | null,
): ToolAudit {
  const map = new Map<string, ToolAuditEntry>();
  let cachedCount = 0;
  let failedCount = 0;
  const kindsCovered = new Set<string>();

  for (const a of artifacts) {
    // Group by the PRODUCING TOOL, not the raw source string. Sources are
    // free-form chains ("rapidapi_breach_search (9 variants)", "hunter_email_verifier
    // + rapidapi_breach_search", "Username_Sweep/Instagram"), and keying on
    // them printed 34 near-duplicate Tool Coverage lines on one export.
    const rawSource = (a.source ?? "unknown").trim() || "unknown";
    const tool = primaryToolSlug(rawSource);
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    // Through the analyst's verdict where one is supplied, so a dismissed row
    // counts as failed here exactly as it renders everywhere else.
    const label = labelForArtifact(a, reviews?.[a.id]);
    const cached = meta.cached === true || meta._cached === true;
    const failed = label === "FAILED" || meta.skipped === true || meta.failed === true;

    kindsCovered.add(a.kind.toLowerCase());
    if (cached) cachedCount++;
    if (failed) failedCount++;

    const entry = map.get(tool) ?? {
      tool, variants: [], totalResults: 0, highConf: 0, attested: 0, lowConf: 0, cached: 0, failed: 0, kinds: [],
    };
    if (!entry.variants.includes(rawSource)) entry.variants.push(rawSource);
    entry.totalResults++;
    if (label === "CONFIRMED" || label === "INFERRED") entry.highConf++;
    if (label === "ATTESTED") entry.attested++;
    if (label === "LOW" || label === "VERIFY") entry.lowConf++;
    if (cached) entry.cached++;
    if (failed) entry.failed++;
    if (!entry.kinds.includes(a.kind.toLowerCase())) entry.kinds.push(a.kind.toLowerCase());
    map.set(tool, entry);
  }

  return {
    tools: Array.from(map.values()).sort((a, b) => b.totalResults - a.totalResults),
    cachedCount,
    failedCount,
    kindsCovered,
  };
}

// ---- Source clarity ----------------------------------------------------

export type CacheLayer = "live" | "memory" | "db" | "unknown";

export type ArtifactSourceInfo = {
  primary: string;
  all: string[];
  cacheLayer: CacheLayer;
  parent: string | null;
  rawValue: string | null;
  hasMetadata: boolean;
};

export function extractSourceInfo(a: Artifact): ArtifactSourceInfo {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = toSourceStrings(meta.sources);
  const all = tokenizeSourceChain([...(a.source ? [a.source] : []), ...metaSources]);
  const primary = all[0] ?? "unknown";
  let cacheLayer: CacheLayer = "unknown";
  if (meta.cached === true || meta._cached === true) {
    const layer = String(meta._cache_layer ?? meta.cache_layer ?? "").toLowerCase();
    if (layer === "memory" || layer === "mem") cacheLayer = "memory";
    else if (layer === "db" || layer === "database") cacheLayer = "db";
    else cacheLayer = "db";
  } else if (meta.live === true || meta._live === true) {
    cacheLayer = "live";
  } else if (a.source) {
    cacheLayer = "live";
  }
  const parent = (meta.parent ?? meta.parent_seed ?? meta.seed ?? null) as string | null;
  const rawValue = (meta.raw_value ?? meta.raw ?? meta.original ?? null) as string | null;
  const hasMetadata = Object.keys(meta).length > 0;
  return { primary, all, cacheLayer, parent, rawValue, hasMetadata };
}

export const CACHE_LAYER_LABEL: Record<CacheLayer, string> = {
  live: "Live call",
  memory: "Memory cache",
  db: "DB cache",
  unknown: "Unknown",
};

export const CACHE_LAYER_CLASS: Record<CacheLayer, string> = {
  live: "text-primary border-primary/40 bg-primary/10",
  memory: "text-muted-foreground border-border bg-secondary/60",
  db: "text-muted-foreground border-border bg-secondary/60",
  unknown: "text-muted-foreground border-border bg-secondary/40",
};

// ---- Failed / skipped tool extraction ----------------------------------

export type FailedToolEntry = {
  id: string;
  /** Operational status — mirrors the Tools/Activity feed so counts agree. */
  kind: "failed" | "skipped" | "gated" | "degraded";
  name: string;
  error: string;
  input: unknown;
  output: unknown;
  time: string | null;
  suggestion: string | null;
  messageId: string | null;
  toolCallId: string | null;
};

function suggestFix(name: string, err: string): string | null {
  const e = err.toLowerCase();
  if (e.includes("invalid email") || e.includes("validation")) {
    return "Tool input failed validation. The agent likely passed a non-matching value (e.g. a username into an email field). Use a different tool or pass a `value` field.";
  }
  if (e.includes("rate limit") || e.includes("429")) return "Rate limited. Retry later or use an alternative tool.";
  if (e.includes("401") || e.includes("403") || e.includes("unauthorized")) return "Tool credentials missing or rejected. Check the connector configuration.";
  if (e.includes("timeout")) return "Tool timed out. The remote source may be slow or unreachable.";
  if (e.includes("not found") || e.includes("404")) return "Target was not found by this source.";
  if (name.startsWith("socialfetch") && e.includes("platform")) return "Platform unsupported by socialfetch_lookup. Try http_fingerprint or web search instead.";
  return null;
}

export type RawMessage = {
  id: string;
  role: string;
  parts: unknown;
  created_at: string;
};

/** Subset of an AI SDK tool message part — only the fields read below. */
interface ToolMessagePart {
  type?: string;
  state?: string;
  errorText?: unknown;
  error?: unknown;
  input?: unknown;
  output?: unknown;
  toolCallId?: unknown;
  [k: string]: unknown;
}

export function extractFailedAndSkipped(messages: RawMessage[]): FailedToolEntry[] {
  const out: FailedToolEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const parts = Array.isArray(m.parts) ? (m.parts as ToolMessagePart[]) : [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || typeof p.type !== "string") continue;
      if (!p.type.startsWith("tool-")) continue;
      const name = p.type.replace(/^tool-/, "");
      // Classify with the SAME engine the Tools/Activity feed uses so the
      // Failures register can never disagree with the header count. This also
      // catches ok:false results (e.g. "budget exhausted") that the old
      // errorText-only check missed, and splits real failures from
      // gated/degraded/skipped outcomes.
      const status = deriveToolStatus(p);
      if (status === "failed" || status === "gated" || status === "degraded") {
        const err = String(
          (typeof p.errorText === "string" && p.errorText) ||
          deriveToolReason(p.output) ||
          p.error ||
          (status === "failed" ? "Tool failed" : status === "gated" ? "Blocked by a gate" : "Degraded result"),
        );
        out.push({
          id: `${m.id}-${i}`,
          kind: status,
          name,
          error: err,
          input: p.input,
          output: p.output,
          time: m.created_at ?? null,
          suggestion: status === "failed" ? suggestFix(name, err) : null,
          messageId: m.id,
          toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : null,
        });
        continue;
      }
      // list_tools may surface disabled_tools after triage
      if (name === "list_tools" && p.output && typeof p.output === "object") {
        const disabled = (p.output as Record<string, unknown>).disabled_tools;
        if (Array.isArray(disabled)) {
          for (const d of disabled) {
            const tn = String(d?.name ?? "unknown");
            const reason = String(d?.reason ?? "Skipped by triage gate");
            out.push({
              id: `${m.id}-${i}-skip-${tn}`,
              kind: "skipped",
              name: tn,
              error: reason,
              input: null,
              output: null,
              time: m.created_at ?? null,
              suggestion: "Triage gate did not promote this tool. Adjust the seed or run a Stage-1 tool that satisfies the gate.",
              messageId: m.id,
              toolCallId: null,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Events rendered in the report's Timeline. Anything beyond this is disclosed, not hidden. */
const TIMELINE_MAX_EVENTS = 40;

// ---- Investigation summary --------------------------------------------

export function buildInvestigationSummary(input: ReportInput): string {
  const { seedValue, seedType, artifacts } = input;
  const audit = buildToolAudit(artifacts);
  const confirmed = artifacts.filter((a) => { const l = labelForArtifact(a); return l === "CONFIRMED" || l === "ATTESTED"; }).length;
  const verify = artifacts.filter((a) => labelForArtifact(a) === "VERIFY").length;
  const low = artifacts.filter((a) => labelForArtifact(a) === "LOW").length;
  const failed = artifacts.filter((a) => labelForArtifact(a) === "FAILED").length;
  return [
    `Investigation summary`,
    `  Seed: ${seedValue ?? "—"} (${seedType ?? "unknown"})`,
    `  Artifacts: ${artifacts.length} across ${audit.tools.length} tool(s)`,
    `  Confirmed: ${confirmed}  Verify: ${verify}  Low: ${low}  Failed: ${failed}`,
    `  Cached results: ${audit.cachedCount}`,
  ].join("\n");
}

/** Suggested fan-out tool groups based on artifact kinds present. */
export const SUGGESTED_TOOLS_BY_KIND: Record<string, string[]> = {
  email: ["breach_check", "gravatar_profile", "hunter_email_verifier", "intelbase_email_lookup"],
  username: ["username_sweep", "github_user", "reddit_user", "hackernews_user", "google_dorks"],
  domain: ["whois_lookup", "dns_records", "crtsh_subdomains", "hunter_domain_search", "urlscan_search"],
  ip: ["ip_intel", "shodan_internetdb", "hackertarget"],
  url: ["http_fingerprint", "archive_url", "wayback_snapshots", "urlscan_search"],
  crypto: ["crypto_wallet"],
  wallet: ["crypto_wallet"],
};

export function inferToolGaps(audit: ToolAudit): { kind: string; suggested: string[] }[] {
  const used = new Set(
    audit.tools.flatMap((t) => [t.tool.toLowerCase(), ...t.kinds.map((k) => k.toLowerCase())]),
  );
  // Match the covered kinds through the alias table, not on their raw spelling.
  // `SUGGESTED_TOOLS_BY_KIND` is keyed by selector CLASS (`ip`, `username`,
  // `domain`), while `kindsCovered` holds whatever each write path recorded —
  // the auto-persist path writes `ip_address`/`social_account`, the model's
  // record_artifacts path writes `ip`/`username`. On the 2026-09-12
  // `baig_azhar` export that left eight `ip_address` rows invisible to gap
  // inference while a single `ip` row drove it, from the same case.
  const covered = new Set([...audit.kindsCovered].map((k) => KIND_TO_PIVOT[k] ?? k));
  const gaps: { kind: string; suggested: string[] }[] = [];
  for (const [kind, tools] of Object.entries(SUGGESTED_TOOLS_BY_KIND)) {
    if (!covered.has(kind)) continue;
    const missing = tools.filter((t) => !used.has(t.toLowerCase()));
    if (missing.length) gaps.push({ kind, suggested: missing });
  }
  return gaps;
}

// ---- Markdown builders -------------------------------------------------

function mdEscape(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

export function buildEvidenceMatrixMarkdown(
  artifacts: Artifact[],
  reviews?: Record<string, ReviewAdjustment>,
): string {
  if (artifacts.length === 0) return "_No evidence recorded._";
  const rows = artifacts.map((a) => {
    // Through the analyst's verdict, like every other label in the report: a
    // rejected row is listed (forensic history) but reads FAILED, never as an
    // active CONFIRMED / CORRELATED row in the exported matrix.
    const label = labelForArtifact(a, reviews?.[a.id]);
    // #3: strip promotional "CONFIRMED" wording from the VALUE when the row is
    // not actually backend-CONFIRMED (render-only; artifact untouched).
    let value = sanitizeValueForLabel(a.value, label === "CONFIRMED" || label === "ATTESTED");
    // #7: annotate reserved/fictional numbers as non-actionable (never delete).
    const reserved = reservedNumberAnnotation(a);
    if (reserved) value = `${value} — ${reserved}`;
    // #8: a legal_record that is really a source/claim discrepancy displays as
    // source_conflict so a reporting disagreement isn't shown as a criminal record.
    const kind = reportDisplayKind(a) === a.kind ? displayKind(a) : "source_conflict";
    return `| ${mdEscape(value)} | ${kind} | ${mdEscape(humanizeSourceChain(a.source, "—"))} | ${label} | ${a.confidence ?? "—"} | ${new Date(a.created_at).toISOString()} |`;
  });
  return [
    "| Value | Kind | Source | Label | Confidence | First seen |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export type ReportInput = {
  seedValue: string | null;
  seedType: string | null;
  artifacts: Artifact[];
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    created_at: string;
    summary: string;
    toolCalls: Array<{ toolName: string; resultSummary?: string }>;
  }>;
  /** Analyst review verdicts by artifact id (Verified/Rejected/Key/Recheck). */
  reviews?: Record<string, ReviewAdjustment>;
  /** Output shape: "full" dossier (default) or condensed "brief". */
  reportType?: "full" | "brief";
  /** #499 — what the ENGINE adjudicated, from `selectAuthoritativeFindings`.
   *  Optional so every other caller of this function keeps working unchanged;
   *  when absent the section is omitted rather than guessed at. */
  authority?: AuthoritativeFindings;
  /** Authoritative tool-call activity (from tool_usage_log), one entry per call.
   *  Supplied by the UI so the Activity Log reflects real tool invocations even
   *  though the persisted message stream doesn't carry tool parts. */
  toolActivity?: Array<{ toolName: string }>;
  /** Total tool invocations incl. suppressed failures, when known. */
  toolInvocations?: number;
};

/**
 * #499 — the engine's own adjudication, rendered above Key Findings.
 *
 * Placed ABOVE deliberately: its job is to qualify what follows. "Key Findings"
 * is built from `labelForArtifact(a) === "CONFIRMED"` over ALL artifacts, which
 * is a source-tier label and not an adjudication — so on a case where
 * `record_finding` never fired, this section is what tells the analyst that
 * everything below is a lead.
 *
 * Returns [] when no authority result was supplied, so existing callers are
 * unaffected. The wording lives in `authorityStatement` so this and the rendered
 * Report tab cannot drift into saying different things about the same run.
 */
function authoritySection(authority?: AuthoritativeFindings): string[] {
  if (!authority) return [];
  const rows = (authority.findings ?? []).map((f) => {
    const pct = typeof f.confidence === "number" ? `${f.confidence}%` : "n/a";
    const tier = f.tier ? f.tier.charAt(0).toUpperCase() + f.tier.slice(1) : "Unverified";
    return `- ${f.value} — ${pct} — ${tier}`;
  });
  return [`## ${AUTHORITY_HEADING}`, "", authorityStatement(authority), ...(rows.length ? ["", ...rows] : []), ""];
}

/**
 * Group artifacts by the exact text of their recorded reason, preserving the
 * order each reason first appears. Used so a section states one judgement once
 * rather than repeating it per artifact — see the collision section below.
 */
function groupByReason<T>(items: T[], reasonOf: (item: T) => string): { reason: string; items: T[] }[] {
  const order: string[] = [];
  const by = new Map<string, T[]>();
  for (const item of items) {
    const reason = reasonOf(item);
    const bucket = by.get(reason);
    if (bucket) bucket.push(item);
    else { by.set(reason, [item]); order.push(reason); }
  }
  return order.map((reason) => ({ reason, items: by.get(reason)! }));
}

export function buildReportMarkdown(input: ReportInput): string {
  const { seedValue, seedType, messages, reviews, reportType, toolActivity, toolInvocations, authority } = input;
  const display = extractDisplaySeed(seedValue, seedType);
  // Collapse breach datasets recorded twice under name variants from the same
  // source pair (conservative — see dedupeBreachDatasets) so the Artifact Table
  // and Network Connections don't double-list one breach.
  // …and fold alias twins (`ip_address` / `ip`, `url` / `social_profile` for
  // the same value) to one row each — see foldAliasTwins. A dismissed twin
  // represents its pair, so the fold is what lets a Dismiss on either spelling
  // bind on the report (the network section excludes rejected rows by id).
  const artifacts = foldAliasTwins(dedupeBreachDatasets(input.artifacts), reviews);
  const total = artifacts.length;

  // Analyst review wins over source-derived label/confidence so a marked
  // artifact reads the same here as in the Evidence view.
  const rev = (a: Artifact): ReviewAdjustment => reviews?.[a.id];
  const lbl = (a: Artifact): ConfLabel => labelForArtifact(a, rev(a));
  // The markdown export's number, and it is the same number the on-screen report
  // renders — `CaseReport.confOf` was changed in lockstep. This was
  // `rev(a) ? adjustedConfidence(a, rev(a)) : a.confidence`, a third pipeline that
  // switched which of the other two it agreed with depending on whether an
  // analyst had clicked Confirm, and it shipped that inconsistency into an
  // exported document. The LABEL above still goes through the review; only the
  // figure is review-independent.
  const conf = (a: Artifact): number | null => effectiveConfidence(a);

  // CONFIRMED is evidence-derived (2+ independent source classes); ATTESTED is
  // the analyst's decision. They are counted, worded and listed separately.
  const confirmed = artifacts.filter((a) => lbl(a) === "CONFIRMED");
  const attested = artifacts.filter((a) => lbl(a) === "ATTESTED");
  const inferred = artifacts.filter((a) => lbl(a) === "INFERRED");
  const verify = artifacts.filter((a) => lbl(a) === "VERIFY");
  const low = artifacts.filter((a) => lbl(a) === "LOW");
  const failed = artifacts.filter((a) => lbl(a) === "FAILED");

  const reviewTally = (() => {
    let verified = 0, rejected = 0, needs = 0;
    for (const a of artifacts) {
      const r = rev(a);
      if (r === "confirmed" || r === "key") verified++;
      else if (r === "dismissed" || r === "wrong") rejected++;
      else if (r === "recheck") needs++;
    }
    return { verified, rejected, needs };
  })();

  // Rejection follows provenance. The analyst rejects the row they can see; the
  // rows the pipeline DERIVED from it carry the same claim and must leave the
  // authoritative sections with it. Live case 2026-09-08: the analyst rejected
  // `dgoff1276@gmail.com` as not the subject's, and the two plaintext breach
  // passwords extracted from that email stayed in "Network Connections — Breach
  // / Exposure" as part of the subject's network.
  const rejectedIds = new Set(artifacts.filter((a) => isRejectedArtifactRow(a, rev(a))).map((a) => a.id));
  const rejectedDerivedIds = buildRejectedDerivationIds(artifacts, rejectedIds, normalizeTarget);
  /** Rejected outright, or derived from something rejected. */
  const isOutOfSet = (a: Artifact) => rejectedIds.has(a.id) || rejectedDerivedIds.has(a.id);

  const audit = buildToolAudit(artifacts, reviews);
  // A "next step" is a recommendation to spend money on a selector. It must be
  // inferred from the kinds still IN the working set: recommending email tools
  // off a rejected email is the product arguing with the analyst.
  //
  // A QUARANTINED row is out of the working set for the same reason and one
  // stronger: since #518/#519 the dispatch guard REFUSES a `subject_unlinked`
  // selector before the live call, so a tool recommended off one cannot run at
  // all. On the 2026-09-12 `baig_azhar` export the case's only `url` artifact
  // was a name-only collision hit, and the report still recommended
  // http_fingerprint, archive_url, wayback_snapshots and urlscan_search
  // against it — four spend recommendations, all of them guaranteed refusals.
  // `isClusterIneligible` is the shared authority predicate (it honours a
  // `linkage_confirmed` release), the same one the clusters, graph and report
  // sections already consult.
  const gaps = inferToolGaps(buildToolAudit(
    artifacts.filter((a) => !isOutOfSet(a) && !isClusterIneligible(a)),
    reviews,
  ));
  const clusterReport = buildIdentityClusters(artifacts, seedValue, reviews);
  const isNameSearch = !!detectNameLocationSeed(seedValue);

  // Group artifacts for entity table and network connections
  const byGroup = new Map<Group, Artifact[]>();
  for (const a of artifacts) {
    const g = groupForKind(a.kind);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(a);
  }

  const exec = (() => {
    if (total === 0) {
      return `No artifacts have been recorded for this investigation yet. The agent has not produced any observations against the seed.`;
    }
    const parts: string[] = [];
    parts.push(`Observed ${total} artifact${total === 1 ? "" : "s"} across ${audit.tools.length} tool${audit.tools.length === 1 ? "" : "s"}.`);
    if (confirmed.length) parts.push(`${confirmed.length} finding${confirmed.length === 1 ? "" : "s"} corroborated by 2+ independent source classes.`);
    if (attested.length) parts.push(`${attested.length} item${attested.length === 1 ? "" : "s"} analyst-confirmed (a decision, not a second source).`);
    if (verify.length + low.length) parts.push(`${verify.length + low.length} item${verify.length + low.length === 1 ? "" : "s"} need verification before reporting.`);
    if (failed.length) parts.push(`${failed.length} item${failed.length === 1 ? "" : "s"} marked as false positive.`);
    if (reviewTally.verified || reviewTally.rejected || reviewTally.needs) {
      const bits: string[] = [];
      if (reviewTally.verified) bits.push(`${reviewTally.verified} analyst-verified`);
      if (reviewTally.rejected) bits.push(`${reviewTally.rejected} analyst-rejected`);
      if (reviewTally.needs) bits.push(`${reviewTally.needs} flagged for recheck`);
      parts.push(`Analyst review: ${bits.join(", ")}.`);
    }
    parts.push("All findings are presented as observations from named sources, not as confirmed identity claims.");
    return parts.join(" ");
  })();

  // Key Findings must stay consistent with the Artifact Table. If there are no
  // fully-CONFIRMED rows we do NOT just print "nothing" while the table shows
  // high-confidence INFERRED/CORRELATED rows — we surface the strongest
  // uncorroborated leads, clearly labelled, without promoting them.
  // "Key Findings" lists corroborated / analyst-confirmed ARTIFACTS; the
  // "Engine-adjudicated findings" section above it lists `record_finding` rows.
  // They are different populations, and the heading + lead say so when the
  // engine scored nothing — otherwise "adjudicated no findings" sat one heading
  // above a list of nine "findings" on a production export.
  const keyFindingsHeading = keyFindingsFraming(authority, {
    corroborated: confirmed.length,
    attested: attested.length,
  });
  const keyFindings = (() => {
    // An exclusion the analyst confirmed is an attested NON-finding: "this is not
    // the subject". It already has a home in the Collision section below; leading
    // Key Findings with it (production export 2026-09-20: the only Key Finding
    // was the excluded namesake) inverts what the heading promises.
    const strong = [...confirmed, ...attested].filter((a) => !isOutOfSet(a) && !isCollisionArtifact(a));
    if (strong.length) {
      return [
        ...(keyFindingsHeading.lead ? [keyFindingsHeading.lead, ""] : []),
        ...strong.slice(0, 10).map((a) =>
          `- **${a.kind}** — \`${a.value}\` _(${lbl(a) === "ATTESTED" ? "analyst-confirmed" : "corroborated"}; source indicates via ${humanizeSourceChain(a.source)}, confidence ${conf(a) ?? "—"})_`,
        ),
      ].join("\n");
    }
    const leads = artifacts
      .filter((a) => { const l = lbl(a); return (l === "CORRELATED" || l === "INFERRED") && !isOutOfSet(a); })
      .sort((a, b) => (conf(b) ?? 0) - (conf(a) ?? 0))
      .slice(0, 10);
    if (!leads.length) return "_No findings recorded yet._";
    return [
      "_No fully-corroborated findings yet (none reach CONFIRMED — 2+ independent source classes — and none is analyst-confirmed). Strongest uncorroborated leads:_",
      "",
      ...leads.map((a) =>
        `- **${a.kind}** — \`${sanitizeValueForLabel(a.value, false)}\` _(${lbl(a)}, confidence ${conf(a) ?? "—"}, via ${humanizeSourceChain(a.source)})_`,
      ),
    ].join("\n");
  })();

  const entityTable = buildEvidenceMatrixMarkdown(artifacts, reviews);

  // #6: collision-flagged artifacts (namesakes / unrelated entities) are
  // quarantined into their own section and kept out of the main network.
  const collisionArtifacts = artifacts.filter((a) => isCollisionArtifact(a));
  const collisionIds = new Set(collisionArtifacts.map((a) => a.id));
  // Conflict metadata the pipeline attaches inline (a different name/address
  // across breaches, a geo disagreement) WITHOUT quarantining the row. These
  // were never surfaced, so the section read "No collisions flagged" even when
  // an artifact's own metadata said "see Conflicts section". We list them here
  // (without quarantining — they stay in the main network) so the pointer
  // resolves and the analyst sees the discrepancy.
  // A probable same-name collision the pipeline noted in free text (reason_not_confirmed /
  // cluster label) WITHOUT excluding the row. These stay in the network but are surfaced
  // here so the section never reads "No collisions flagged" while such reasoning exists.
  const COLLISION_TEXT_RE = /\b(collision|namesake|same[-\s]?name|different\s+(?:person|people))\b/i;
  const collisionText = (m: Record<string, unknown>): string | null => {
    for (const k of ["reason_not_confirmed", "cluster", "reason"]) {
      const v = m[k];
      if (typeof v === "string" && COLLISION_TEXT_RE.test(v)) return v.trim();
    }
    return null;
  };
  /**
   * `subject_unlinked` is the strongest collision signal the pipeline emits —
   * the backend sets it, with a reason, on every row harvested from a name-only
   * query ("same-name collision axis; linkage to the subject is unproven").
   *
   * It was read NOWHERE in the frontend. On the leoseyes86 report that meant 20
   * quarantined artifacts rendered as ordinary Candidate Identity Clusters
   * (C003–C022) while this section printed "_No collisions flagged._" — directly
   * contradicting the report's own header banner, which had already warned that
   * a same-name collision was detected and that phone area codes disagreed.
   * The integrity work was done and then discarded at the presentation layer.
   *
   * The predicate now lives in `@/lib/quarantine` — the same one the pivot engine
   * consults to keep a quarantined selector out of the actionable list. One
   * definition, so the surface that DESCRIBES a collision and the surface that
   * refuses to ACT on it can never drift apart.
   */

  const conflictNoted = artifacts.filter((a) => {
    if (collisionIds.has(a.id)) return false;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    return (typeof m.conflict_note === "string" && m.conflict_note.trim().length > 0)
      || (typeof m.conflict === "string" && m.conflict.trim().length > 0)
      || m.geo_conflict === true
      || isSubjectUnlinked(m)
      || collisionText(m) !== null;
  });
  const conflictNote = (a: Artifact): string => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (typeof m.conflict_note === "string" && m.conflict_note.trim()) return m.conflict_note.trim();
    // The backend's own words for why this row is unlinked — quote them rather
    // than paraphrasing, so the report says exactly what the pipeline decided.
    if (isSubjectUnlinked(m) && typeof m.subject_unlinked_reason === "string" && m.subject_unlinked_reason.trim()) {
      return m.subject_unlinked_reason.trim();
    }
    if (isSubjectUnlinked(m)) return "harvested from a name-only query — linkage to the subject is unproven";
    if (typeof m.geo_conflict_note === "string" && m.geo_conflict_note.trim()) return m.geo_conflict_note.trim();
    if (typeof m.conflict === "string" && m.conflict.trim()) return m.conflict.trim();
    const ct = collisionText(m);
    if (ct) return ct;
    return "conflicting attributes across sources";
  };
  const collisionSection = (collisionArtifacts.length === 0 && conflictNoted.length === 0)
    ? "_No collisions flagged._"
    : [
        ...(collisionArtifacts.length
          ? [
              "_These artifacts were flagged as namesakes / unrelated entities. They do NOT belong to the subject and do NOT strengthen the main network._",
              "",
              ...collisionArtifacts.map((a) =>
                `- \`${sanitizeValueForLabel(a.value, false)}\` — ${reportDisplayKind(a) === a.kind ? displayKind(a) : "source_conflict"} _(${labelForArtifact(a)}, via ${humanizeSourceChain(a.source)})_`,
              ),
            ]
          : []),
        ...(conflictNoted.length
          ? [
              ...(collisionArtifacts.length ? [""] : []),
              "_Conflicts noted across sources — may indicate different people or data errors. Corroborate before merging._",
              "",
              // GROUPED BY REASON, not one line per artifact.
              //
              // A single name-only harvest produces dozens of rows that all carry
              // the SAME `subject_unlinked_reason`. Printed per row, one live run
              // published "harvested from a name-only query — same-name collision
              // axis; linkage to the subject is unproven" twenty-five times in one
              // section — the reader scrolls a wall of identical prose to find the
              // handful of rows whose reason actually differs.
              //
              // Every value and every reason still appears. The reason is simply
              // stated once for the set it applies to, which is also the truer
              // shape: these rows are not 25 independent judgements, they are one
              // judgement about 25 artifacts from one query.
              ...groupByReason(conflictNoted, conflictNote).flatMap(({ reason, items }) =>
                items.length === 1
                  ? [`- \`${sanitizeValueForLabel(items[0].value, false)}\` — ${reason} _(via ${humanizeSourceChain(items[0].source)})_`]
                  : [
                      `- **${items.length} artifacts** — ${reason}`,
                      ...items.map((a) =>
                        `  - \`${sanitizeValueForLabel(a.value, false)}\` _(via ${humanizeSourceChain(a.source)})_`),
                    ],
              ),
            ]
          : []),
      ].join("\n");

  const network = (() => {
    const sections: string[] = [];
    const line = (a: Artifact) => `- \`${sanitizeValueForLabel(a.value, lbl(a) === "CONFIRMED" || lbl(a) === "ATTESTED")}\` _(observed via ${humanizeSourceChain(a.source)})_`;
    // Threat/reputation rows (VirusTotal, IPQS, EmailRep…) are pulled into their
    // own section regardless of which group they land in — they may be
    // mis-kinded as `breach` (→ breach group) OR correctly kinded as
    // `threat_reputation`/`reputation_signal` (→ other group). Collecting by
    // isReputationArtifact() catches both so they never report as exposures.
    // "Network Connections" IS the subject's network, so listing a row here is an
    // AUTHORITY claim — the same claim clustering, graph edges and the confidence
    // dimensions already refuse to make for a quarantined row. Excluding it here
    // is not concealment: it stays in the Artifact/Entity Table, in the Timeline,
    // and in the Collision section under its own `subject_unlinked_reason`.
    //
    // A SEPARATE set from `collisionIds` on purpose. collisionIds is the
    // collision-SECTION membership test; adding quarantine to it would evict these
    // rows from `conflictNoted` (:1138), which is the only branch that quotes
    // their reason verbatim (:1151). See isClusterIneligible in report-hygiene.ts.
    // An analyst-rejected row (dismissed / wrong / legacy false_positive) is the
    // same authority claim refused by a human instead of the pipeline: it leaves
    // the network section too, and stays in the Artifact/Entity Table as FAILED.
    // A contradiction record, a weak-lead note or an engine finding describes
    // the case; it is not a node in the subject's network (isNonEntityArtifact).
    const networkExcluded = new Set(
      artifacts.filter((a) =>
        collisionIds.has(a.id) || isSubjectUnlinked(a.metadata) || isOutOfSet(a) || isNonEntityArtifact(a),
      ).map((a) => a.id),
    );
    const reputation = artifacts.filter((a) => isReputationArtifact(a) && !networkExcluded.has(a.id));
    const repIds = new Set(reputation.map((a) => a.id));
    for (const g of GROUP_ORDER) {
      const items = (byGroup.get(g) ?? []).filter((a) => !repIds.has(a.id) && !networkExcluded.has(a.id));
      if (!items.length) continue;
      sections.push(`**${GROUP_LABEL[g]}**\n` + items.map(line).join("\n"));
    }
    if (reputation.length) {
      sections.push(`**Threat / Reputation**\n` + reputation.map(line).join("\n"));
    }
    return sections.length ? sections.join("\n\n") : "_No correlated entities yet._";
  })();

  const timeline = (() => {
    const items = buildTimelineItems(
      artifacts,
      seedValue ? { value: seedValue, type: seedType, createdAt: null } : null,
      messages,
    );
    if (items.length === 0) return "_No events recorded._";
    // Tool-call events all inherit their parent message's single timestamp — a
    // final batch can collapse a dozen calls into one instant, which rendered as
    // a "timeline" where every row shared the same time. They also duplicate the
    // Activity Log's tool breakdown. The evidentiary chronology (seed, queries,
    // artifacts, report) carries real per-event timestamps, so render that.
    const chronology = items.filter((t) => t.type !== "tool_result");
    const source = chronology.length ? chronology : items;
    // A SILENT `.slice(-15)` on the chain-of-custody surface. On the
    // glitterkittens12 export it dropped the first user query and all 20
    // artifacts recorded in the run's opening four minutes, and said nothing —
    // the section still read "Timeline Summary" as though it were complete.
    // Truncation is fine; undisclosed truncation on an evidentiary chronology
    // is not.
    const shown = source.slice(-TIMELINE_MAX_EVENTS);
    const omitted = source.length - shown.length;
    return [
      ...(omitted > 0
        ? [`_Showing the ${shown.length} most recent of ${source.length} events; ${omitted} earlier event${omitted === 1 ? "" : "s"} omitted. The full chronology is in the Artifact / Entity Table._`, ""]
        : []),
      ...shown.map((t) =>
        `- \`${new Date(t.time).toISOString()}\` — **${t.type}** — ${t.title}${t.source ? ` _(via ${humanizeSourceChain(t.source)})_` : ""}`,
      ),
    ].join("\n");
  })();

  const activityLog = (() => {
    if (!messages || messages.length === 0) return "_No message activity recorded._";
    const userQueries = messages.filter((m) => m.role === "user");
    const msgToolCalls = messages.flatMap((m) => m.toolCalls.map((t) => ({ ...t, at: m.created_at })));
    // Prefer the authoritative tool_usage_log activity supplied by the UI — the
    // persisted message stream doesn't carry tool parts, so msgToolCalls is
    // usually empty (which rendered "Tool invocations: 0").
    const toolCalls = (toolActivity && toolActivity.length)
      ? toolActivity.map((t) => ({ toolName: t.toolName, at: "" }))
      : msgToolCalls;
    const reportMarkers = messages.filter((m) => m.role === "assistant" && /report/i.test(m.summary));
    const parts: string[] = [];
    parts.push(`- **User queries:** ${userQueries.length}`);
    parts.push(`- **Tool invocations:** ${toolInvocations ?? toolCalls.length}`);
    if (reportMarkers.length) parts.push(`- **Report markers:** ${reportMarkers.length}`);
    const toolCounts = new Map<string, number>();
    for (const tc of toolCalls) {
      toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1);
    }
    if (toolCounts.size) {
      const breakdown = Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `\`${name}\`×${n}`)
        .join(", ");
      parts.push(`- **Tool breakdown:** ${breakdown}`);
    }
    const recent = messages
      .filter((m) => m.role === "user" || m.toolCalls.length > 0 || /report/i.test(m.summary))
      .slice(-10);
    if (recent.length) {
      const lines = recent.map((m) => {
        const ts = new Date(m.created_at).toISOString();
        if (m.role === "user") return `- \`${ts}\` — **query** — ${m.summary}`;
        if (m.toolCalls.length) {
          return `- \`${ts}\` — **tools** — ${m.toolCalls.map((t) => `\`${t.toolName}\`${t.resultSummary ? `(${t.resultSummary})` : ""}`).join(", ")}`;
        }
        return `- \`${ts}\` — **report** — ${m.summary}`;
      });
      parts.push("", "**Recent activity:**", ...lines);
    }
    return parts.join("\n");
  })();

  const toolCoverage = audit.tools.length === 0
    ? "_No tools produced artifacts._"
    : audit.tools.map((t) =>
        `- ${toolActionLabel(auditEntryToolName(t))} — ${t.totalResults} result${t.totalResults === 1 ? "" : "s"}, ${t.highConf} high-confidence, ${t.attested ? `${t.attested} analyst-confirmed, ` : ""}${t.lowConf} need verification${t.cached ? `, ${t.cached} cached` : ""}${t.failed ? `, ${t.failed} failed` : ""}`,
      ).join("\n");

  const weakAreas = (() => {
    const expected: Group[] = ["identity", "contact", "social", "infrastructure"];
    const missing = expected.filter((g) => !byGroup.get(g)?.length);
    const parts: string[] = [];
    if (missing.length) parts.push(`- Missing coverage: ${missing.map((m) => GROUP_LABEL[m]).join(", ")}`);
    if (verify.length) parts.push(`- ${verify.length} item${verify.length === 1 ? "" : "s"} flagged as possible matches that need verification.`);
    if (low.length) parts.push(`- ${low.length} low-confidence lead${low.length === 1 ? "" : "s"} — treat as leads, not findings.`);
    return parts.length ? parts.join("\n") : "_No obvious gaps detected._";
  })();

  const nextSteps = gaps.length === 0
    ? "_No additional tool groups suggested._"
    : gaps.map((g) => `- **${g.kind}** — consider: ${g.suggested.map((t) => toolActionLabel(t)).join(", ")}`).join("\n");

  // Rejected evidence is PRESERVED and SEGREGATED, never deleted and never
  // active. It keeps its source, its timestamp and its exclusion reason so the
  // chain of custody survives, and it is stated plainly that it does not support
  // the subject identity — which is the thing the active sections were doing by
  // implication when a rejected row sat in "Network Connections".
  const excludedAppendix = (() => {
    const rows = artifacts.filter(isOutOfSet);
    if (!rows.length) return "_No evidence has been excluded by analyst review._";
    return [
      "_These rows were removed from every active section by analyst review. They are retained for chain of custody. They do NOT support the subject identity and must not be cited as corroboration._",
      "",
      ...rows.map((a) => {
        const why = rejectedIds.has(a.id)
          ? "analyst rejected"
          : "derived solely from rejected evidence";
        return `- \`${sanitizeValueForLabel(a.value, false)}\` — ${a.kind} _(via ${humanizeSourceChain(a.source)}, ${new Date(a.created_at).toISOString()}; **${why}**)_`;
      }),
    ].join("\n");
  })();

  const sourceAppendix = audit.tools.length === 0
    ? "_None._"
    : audit.tools.map((t) => `- ${toolActionLabel(auditEntryToolName(t))} — produced ${t.kinds.join(", ") || "—"}`).join("\n");

  if (reportType === "brief") {
    return [
      `# OSINT Investigation Brief`,
      "",
      `**Subject:** \`${display.selector}\` (${display.kind})`,
      "",
      `## Executive Summary`,
      exec,
      "",
      ...authoritySection(authority),
      `## ${keyFindingsHeading.heading}`,
      keyFindings,
      "",
      `## Recommended Next Steps`,
      nextSteps,
      "",
      `---`,
      `_Condensed brief — switch to the Full Dossier report type for the complete analysis. Observations from named sources; no identity claim is confirmed without independent corroboration._`,
    ].join("\n");
  }

  // #488 — geography and corroboration are SEPARATE claims, and a cluster can be
  // in either, both, or neither. The seed-location section reports a US-state
  // match; the corroboration section reports >=2 independent source classes.
  const locationMatched = clusterReport.clusters.filter((c) => c.matchesSeedLocation === true);
  const byCorroboration = clusterReport.clusters.map((c) => ({
    cluster: c,
    classes: clusterIndependentSourceClasses(c),
  }));
  const corroborated = byCorroboration.filter((x) => x.classes.length >= CLUSTER_CORROBORATION_MIN_CLASSES);
  const uncorroborated = byCorroboration.filter((x) => x.classes.length < CLUSTER_CORROBORATION_MIN_CLASSES);

  return [
    `# OSINT Investigation Report`,
    "",
    ...(clusterReport.warnings.length
      ? [
          `> ⚠️ **${clusterReport.warnings[0]}**`,
          ...clusterReport.warnings.slice(1).map((w) => `> ${w}`),
          "",
        ]
      : []),
    `## Executive Summary`,
    exec,
    "",
    `## Seed Details`,
    `- **Selector:** \`${display.selector}\``,
    `- **Type:** ${display.kind}`,
    ...(clusterReport.seedName ? [`- **Detected subject:** ${clusterReport.seedName}`] : []),
    ...(clusterReport.seedState ? [`- **Detected location target:** ${clusterReport.seedState}`] : []),
    `- **Artifacts recorded:** ${total}`,
    "",
    `## Candidate Identity Clusters`,
    buildClusterSection(clusterReport, { includeWarnings: false }),
    "",
    ...authoritySection(authority),
    `## ${keyFindingsHeading.heading}`,
    keyFindings,
    "",
    `## Artifact / Entity Table`,
    entityTable,
    "",
    `## Network Connections`,
    network,
    "",
    `## Collision / Likely Unrelated`,
    collisionSection,
    "",
    ...(isNameSearch
      ? [
          `## Seed-Location Match`,
          locationMatched.length
            ? locationMatched
                // "single source" was the old fallback here, and it fires only
                // when the token list is EMPTY — it labelled a cluster with no
                // recorded source as if it had one.
                .map((c) => `- ${c.label} — ${humanizeSourceChain(c.sources, "no source recorded")}`)
                .join("\n")
            : clusterReport.seedState
              ? `_No cluster matches the seed location (${clusterReport.seedState}) yet._`
              : "_No seed location was detected, so no cluster can be matched against one._",
          "",
          clusterReport.seedState
            ? `_Geography only — a ${clusterReport.seedState} match narrows the candidate set, it does not corroborate it. Out-of-area same-name matches must not be treated as the seed subject without further verification._`
            : "_A location match narrows the candidate set; it does not corroborate it._",
          "",
          // ⚠️ THE EMPTY-CLUSTER CASE IS EXPLICIT, and must stay that way.
          //
          // With zero clusters BOTH of these sections used to fire their
          // fallback, because both fallbacks are vacuously true of an empty set:
          // "No cluster is corroborated…" (nothing to corroborate) immediately
          // followed by "Every cluster reaches 2 or more…" (nothing that fails).
          // A published report carried both sentences, three lines apart,
          // flatly contradicting each other — observed on a live name-seed run
          // that produced 41 artifacts and 0 clusters.
          //
          // An empty set is not a corroboration result. Say so once.
          ...(byCorroboration.length === 0
            ? [
                `## Corroboration`,
                "_No identity clusters were formed, so there is nothing to corroborate or to fault. "
                  + "This is a statement about cluster formation, not about the strength of the artifacts below._",
                "",
              ]
            : [
                `## What Is Actually Corroborated`,
                corroborated.length
                  ? corroborated
                      .map(({ cluster, classes }) =>
                        `- ${cluster.label} — ${classes.length} independent source classes: ${humanizeSourceChain(classes)}`)
                      .join("\n")
                  : "_No cluster is corroborated by 2 or more independent source classes yet._",
                "",
                `## What Is Not Corroborated`,
                [
                  ...uncorroborated.map(({ cluster, classes }) =>
                    `- ${cluster.label} — ${classes.length} independent source class${classes.length === 1 ? "" : "es"}; needs a second before it can be reported as corroborated.`),
                  ...(clusterReport.seedState && !locationMatched.length
                    ? [`- Direct ${clusterReport.seedState} address/IP evidence for the subject.`]
                    : []),
                ].join("\n") || "_Every cluster reaches 2 or more independent source classes._",
                "",
              ]),
        ]
      : []),
    `## Timeline Summary`,
    timeline,
    "",
    `## Activity Log`,
    activityLog,
    "",
    `## Tool Coverage Summary`,
    toolCoverage,
    "",
    `## Weak Areas`,
    weakAreas,
    "",
    `## Recommended Next Steps`,
    nextSteps,
    "",
    `## Source Appendix`,
    sourceAppendix,
    "",
    `## Excluded by Analyst`,
    excludedAppendix,
    "",
    `---`,
    `_All items are presented as observations from named sources. Wording such as "observed", "source indicates", "possible match", and "needs verification" is used deliberately. No identity claim should be treated as confirmed without independent corroboration._`,
  ].join("\n");
}

// ---- Identity cluster separation --------------------------------------
//
// Goal: stop merging two same-name people. Group artifacts by hard
// identifiers first (email, phone, username, address, source linkage),
// then split by geographic conflict (different US state / area code /
// IP geo). This is heuristic and CLIENT-SIDE only — no fake data, no
// schema changes.

const US_STATE_TOKENS: Record<string, string> = {
  al: "AL", alabama: "AL", ak: "AK", alaska: "AK",
  az: "AZ", arizona: "AZ", ar: "AR", arkansas: "AR",
  ca: "CA", california: "CA", co: "CO", colorado: "CO",
  ct: "CT", connecticut: "CT", de: "DE", delaware: "DE",
  fl: "FL", florida: "FL", ga: "GA", georgia: "GA",
  hi: "HI", hawaii: "HI", id: "ID", idaho: "ID",
  il: "IL", illinois: "IL", in: "IN", indiana: "IN",
  ia: "IA", iowa: "IA", ks: "KS", kansas: "KS",
  ky: "KY", kentucky: "KY", la: "LA", louisiana: "LA",
  me: "ME", maine: "ME", md: "MD", maryland: "MD",
  ma: "MA", massachusetts: "MA", mi: "MI", michigan: "MI",
  mn: "MN", minnesota: "MN", ms: "MS", mississippi: "MS",
  mo: "MO", missouri: "MO", mt: "MT", montana: "MT",
  ne: "NE", nebraska: "NE", nv: "NV", nevada: "NV",
  nh: "NH", nj: "NJ", nm: "NM", ny: "NY", "new-york": "NY",
  nc: "NC", nd: "ND", oh: "OH", ohio: "OH",
  ok: "OK", oklahoma: "OK", or: "OR", oregon: "OR",
  pa: "PA", pennsylvania: "PA", ri: "RI", sc: "SC", sd: "SD",
  tn: "TN", tennessee: "TN", tx: "TX", texas: "TX",
  ut: "UT", utah: "UT", vt: "VT", va: "VA", virginia: "VA",
  wa: "WA", washington: "WA", wv: "WV", wi: "WI", wisconsin: "WI",
  wy: "WY", dc: "DC",
};

/** Words that make an adjacent "id" mean "identifier" rather than Idaho. */
const ACCOUNT_ID_CONTEXT_TOKENS = new Set([
  "discord", "steam", "roblox", "telegram", "twitter", "tiktok", "instagram", "snapchat",
  "twitch", "reddit", "github", "facebook", "xbox", "psn", "epic", "user", "account", "player", "uid",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

function extractStateFromText(s: string | null | undefined): string | null {
  if (!s) return null;
  // A US address ends "... <STATE> <ZIP>". Anchor on the 5-digit ZIP so a street
  // suffix that collides with a 2-letter state code — e.g. "Ct" (Court) → CT,
  // "Pa"/"Or"/"In" — can't be mistaken for the state. The token immediately before
  // the ZIP is the authoritative state. (Bug: "302 S Mason Ct, Baltimore MD 21231"
  // was read as Connecticut off the "Ct" street suffix, fabricating a phantom
  // state that then drove a false geographic collision.)
  const zipAnchored = s.match(/([A-Za-z][A-Za-z.-]{0,13})\s+\d{5}(?:-\d{4})?\b/);
  if (zipAnchored) {
    const st = US_STATE_TOKENS[zipAnchored[1].toLowerCase().replace(/[.-]+/g, "")];
    if (st) return st;
  }
  // Fallback for strings with no ZIP (clean metadata like "CA", or a name-location
  // seed like "sacramento ca"): first recognized state token.
  for (const tok of tokenize(s)) {
    const st = US_STATE_TOKENS[tok];
    if (st) return st;
  }
  return null;
}

/**
 * Do two CLUSTERS carry area codes that share none?
 *
 * The check used to union the codes of every cluster and warn "likely different people" whenever the
 * union held more than one — so a SINGLE cluster holding two phones from different area codes (one
 * person who moved, or who carries a number from their old city) tripped it, and the warning also
 * raised the same-name-collision banner. A conflict needs two clusters that each have a code and
 * have no code in common; one cluster's own mix of codes is not a disagreement with anyone.
 */
export function areaCodesDisagreeAcrossClusters(codesPerCluster: ReadonlyArray<ReadonlyArray<string>>): boolean {
  const withCodes = codesPerCluster.filter((codes) => codes.length > 0);
  for (let i = 0; i < withCodes.length; i++) {
    for (let j = i + 1; j < withCodes.length; j++) {
      if (!withCodes[i].some((c) => withCodes[j].includes(c))) return true;
    }
  }
  return false;
}

function extractAreaCode(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  // US: optionally leading 1, then 3-digit area code.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

// URL / URL-infrastructure tokens that must NEVER become a subject name. A seed
// that carries a URL tokenizes to fragments like "https youtu be watch v" — the
// live 3gfgct case surfaced "3gfgct https youtu" as the Detected subject on the
// report AND as the fallback label of every un-named cluster. Strip URLs first,
// then drop any residual infra tokens, so a URL-bearing seed yields NO phantom
// name rather than a garbage one.
const URL_INFRA_TOKENS = new Set([
  "http", "https", "www", "watch", "youtu", "youtube", "com", "net", "org",
  "be", "tv", "io", "co", "gg", "ly", "app", "gov", "edu", "html", "php", "aspx",
  "embed", "shorts", "channel", "playlist", "profile", "status", "reel", "video",
]);

/** Remove URL substrings from an otherwise free-form seed so their path/host
 *  fragments never leak into a derived subject name. */
function stripUrls(s: string): string {
  return s
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|be|tv|io|co|gg|ly|app|gov|edu)(?:\/\S*)?/gi, " ");
}

/** Best-effort name + location detection from a free-form seed string. */
export function detectNameLocationSeed(seedValue: string | null): { name: string | null; state: string | null } | null {
  if (!seedValue) return null;
  if (detectSeed(seedValue)?.kind !== "other") return null; // structured seed → not a name search
  // Strip embedded URL(s) BEFORE deriving a name. A clean URL seed is already
  // caught by the kind check above; this covers mixed "<handle> https://…" seeds
  // where the URL would otherwise dominate the tokenized name.
  const cleaned = stripUrls(seedValue);
  const toks = tokenize(cleaned).filter((t) => !URL_INFRA_TOKENS.has(t));
  // Fewer than two real tokens → not a name search. Returning null (not an
  // object) keeps `isNameSearch` false for URL/link seeds, so no phantom subject
  // is emitted and clusters fall back to their own names, not a URL fragment.
  if (toks.length < 2) return null;
  // A long digit run is an account identifier (Discord snowflake, Steam64, user
  // ID), never part of a person's name — ZIPs are 5 digits. Live case 2026-09-25:
  // "<19-digit id> discord ID" became subject "<id> discord", location "ID"
  // (Idaho), and a fabricated Seed-Location section.
  if (toks.some((t) => /^\d{6,}$/.test(t))) return null;
  // Beside a platform/account word, "id" is the word ID, not Idaho.
  const state = toks.includes("id") && toks.some((t) => ACCOUNT_ID_CONTEXT_TOKENS.has(t))
    ? extractStateFromText(toks.filter((t) => t !== "id").join(" "))
    : extractStateFromText(cleaned);
  const nameToks = toks.filter((t) => !US_STATE_TOKENS[t]);
  const name = nameToks.length ? nameToks.slice(0, 3).join(" ") : null;
  return { name, state };
}

/** Rendered in place of an identity when a cluster carries no name, email or
 *  username of its own. Never a person's name — see #485. `ClustersTab` matches
 *  this exact string to relabel an infrastructure-only cluster. */
export const UNATTRIBUTED_CLUSTER_LABEL = "unattributed cluster";

export type IdentityCluster = {
  id: string;
  label: string;
  artifacts: Artifact[];
  emails: string[];
  usernames: string[];
  phones: string[];
  addresses: string[];
  ips: string[];
  names: string[];
  states: string[];          // observed US state codes
  areaCodes: string[];
  sources: string[];
  confidence: number;        // 0-100, derived from artifact confidences
  warnings: string[];
  mergeReasons: string[];    // why these artifacts were merged (auditable)
  matchesSeedLocation: boolean | null;
};

export type ClusterReport = {
  clusters: IdentityCluster[];
  collision: boolean;
  warnings: string[];
  seedName: string | null;
  seedState: string | null;
};

const SHARED_INFRA_NAME_THRESHOLD = 3;
const SHARED_INFRA_KEY_PREFIXES = new Set(["ip", "address", "wallet", "parent"]);

/** T1-2 merge signals. Strength ordering: phone/email > handle ≈ infra. */
export type MergeSignal = "HANDLE_MATCH" | "EMAIL_MATCH" | "PHONE_MATCH" | "SHARED_INFRASTRUCTURE";

/**
 * Confidence each signal contributes to a merged cluster. Phone/email are the
 * strongest single proofs; a handle match is meaningful but must not overpower
 * them (T1-2 §3). Shared infrastructure is moderate and already gated by the
 * T1-1 fan-out guard.
 */
export const MERGE_SIGNAL_WEIGHT: Record<MergeSignal, number> = {
  EMAIL_MATCH: 35,
  PHONE_MATCH: 35,
  HANDLE_MATCH: 25,
  SHARED_INFRASTRUCTURE: 20,
};
/** Extra confidence per platform a handle appears on beyond the first two,
 * capped so a handle seen everywhere can't run away with the score (T1-2 §4). */
const HANDLE_REINFORCE_PER_PLATFORM = 10;
const HANDLE_REINFORCE_CAP = 20;

// A cluster whose ONLY merge evidence is repeated username/handle matches —
// with no corroborating identity evidence (email/phone/address/durable selector
// or an identity-bearing record) — is a LEAD, not a confirmed identity. A handle
// seen on many platforms is not proof of who the person is (the inverse, even —
// see the `over_broad_username` contradiction). Such clusters are capped in the
// VERIFY band (below the INFERRED≥65 / CONFIRMED≥85 thresholds in
// labelForArtifact) so cluster confidence can't inflate into confirmed/high-
// confidence territory and contradict the per-artifact labels.
const HANDLE_ONLY_CLUSTER_CAP = 60;
// Metadata keys whose presence means a record carries identity-bearing fields
// (a breach/profile row that ties the handle to a real PERSON).
//
// `address` is deliberately NOT here. It identifies a PLACE, not a person, and a
// place is shared by everyone who lives, works or receives mail there — so a row
// whose only identifying field was an address used to lift the handle-only cap
// through this door while the other two were closed. A row that genuinely names
// someone still qualifies via full_name / name / real_name, and one carrying a
// durable personal selector still qualifies via phone / dob / ssn.
const IDENTITY_BEARING_META_KEYS = ["full_name", "name", "real_name", "phone", "dob", "date_of_birth", "ssn"];

/**
 * Normalize a social handle for cross-platform identity matching (T1-2 §2).
 * Lowercases, trims, drops a leading "@", and removes the separators users
 * sprinkle inconsistently across platforms (`_ . -`). Alphanumerics are
 * preserved, so `nuh_deem`, `nuh.deem`, `NUH-DEEM` all converge to `nuhdeem`
 * while `nuhdeem1`, `realnuhdeem`, and `nuhdeem_backup` stay distinct.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "").replace(/[_.-]/g, "");
}

/**
 * Generic role addresses that must never link an email to a handle.
 *
 * Operator-specified. Exact match on the lowercased local-part; these are
 * mailbox roles, not people, and linking them would union every organisation in
 * the corpus into one entity.
 */
const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  "info", "admin", "contact", "hello", "support", "noreply", "no-reply",
  "postmaster", "webmaster", "mail", "help", "team", "sales", "billing",
]);

/** Minimum local-part length before an email may imply a handle. */
const MIN_EMAIL_HANDLE_LOCAL_PART = 8;

/**
 * The handle an email address implies, or null when the guard refuses it.
 *
 * WHY THIS EXISTS. An email emitted `email:<address>` and a profile emitted
 * `handle:<username>` — different keyspaces, so `vernjjulian@gmail.com` and
 * `hackerrank.com/vernjjulian` could never union. Measured on production thread
 * `b4e575a6`: three artifacts carrying the same literal token landed in three
 * clusters, so no cluster reached the two independent source classes CONFIRMED
 * requires, and the engine adjudicated zero findings on a case whose answer was
 * already in the table. Corpus-wide: 17 findings across 10,933 artifacts.
 *
 * THE GUARD IS THE WHOLE DESIGN. Emitting a handle for every email would merge
 * every `info@` in the corpus into one person. Both conditions must pass, and
 * the length floor is measured on the RAW lowercased local-part, before
 * `normalizeHandle` strips separators.
 *
 * The returned key is normalised, because it has to land in the SAME keyspace
 * the handle artifacts use or the merge it exists to enable cannot happen.
 *
 * Emission only. This adds a merge key; it does not touch confidence, caps or
 * the scoring chain.
 */
export function emailHandleKey(email: string): string | null {
  const at = email.indexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at).trim().toLowerCase();
  if (local.length < MIN_EMAIL_HANDLE_LOCAL_PART) return null;
  if (GENERIC_EMAIL_LOCAL_PARTS.has(local)) return null;
  const norm = normalizeHandle(local);
  // THE FLOOR IS MEASURED TWICE, ON PURPOSE. `normalizeHandle` strips `_ . -`,
  // so a local-part can clear the raw floor and land far below it: `m.newman`,
  // `t.sipply`, `dr_orian`, `chad-lfc`, `it.slife` are 8 raw characters and 7
  // after normalisation (all five are real production rows, measured
  // 2026-09-07 across the artifact corpus; 7 distinct local-parts, 8 rows).
  // Since the key that actually unions is the NORMALISED one, checking only
  // the raw length lets a 7-character initial+surname stub — the shape most
  // likely to collide across unrelated people — become a merge key.
  //
  // This SUBSUMES the raw check above — normalisation only ever shortens, so
  // `norm >= 8` implies `local >= 8` and no input can reach production through
  // one and not the other. A mutation run confirms it: deleting the raw check
  // kills no test. It is kept because the operator's rule is stated over both
  // forms and a reader should not have to re-derive the implication; do not
  // "discover" it later as dead code and drop it silently.
  if (norm.length < MIN_EMAIL_HANDLE_LOCAL_PART) return null;
  return norm || null;
}

/**
 * Flatten metadata cross-link values (string or string[]) into trimmed,
 * non-empty strings, for unioning clusters on concrete shared selectors a
 * record carries about its owner (an email row's `metadata.phone`, etc.).
 */
function collectStrings(...vals: unknown[]): string[] {
  const out: string[] = [];
  for (const val of vals) {
    if (typeof val === "string") {
      const t = val.trim();
      if (t) out.push(t);
    } else if (Array.isArray(val)) {
      for (const x of val) {
        if (typeof x === "string") {
          const t = x.trim();
          if (t) out.push(t);
        }
      }
    }
  }
  return out;
}

/**
 * Phone merge key: digits only, with a leading US/CA country code stripped, so
 * a breach row's `phones: ["8087838763"]` and the standalone `+18087838763`
 * artifact land on ONE key. Measured 2026-09-20 on thread d72fa44a: the Serus
 * row carried both 808 phones as bare digits, the phone artifacts carried them
 * in E.164, and the two never merged — two of the fifteen singleton clusters
 * that case produced for one person. Below 7 digits nothing is a phone.
 */
export function phoneMergeKey(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return `phone:${digits}`;
}

/**
 * `parent:`-namespaced key for "this row came from a lookup on selector X" (the
 * auto-persist `queried_selector`) and for X's own row, so the two union under
 * the weakest signal. Shape-gated: anything with whitespace is a person name
 * and is never a merge key; emails and phones are normalised like their
 * value-based keys so the namespaces cannot drift apart.
 */
export function recordMateKey(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t || /\s/.test(t) || t.length < 5) return null;
  if (t.includes("@")) return `parent:${t}`;
  const pk = phoneMergeKey(t);
  if (pk && /^[\d\s()+.-]+$/.test(t)) return `parent:${pk.slice("phone:".length)}`;
  const h = normalizeHandle(t);
  return h ? `parent:${h}` : null;
}

/**
 * Metadata keys that describe HOW a row was obtained, not what it contains.
 * They are excluded from the corroboration scan below — `queried_selector` is
 * itself stamped into metadata, so scanning it would make the check a no-op.
 */
const PROVENANCE_META_KEYS: ReadonlySet<string> = new Set([
  "queried_selector",
  "parent_selector",
  "parent",
  "parent_seed",
  "seed",
  "auto_persist_source",
  "via",
  "tool",
  "source",
]);

/**
 * Does the returned record ITSELF name the selector it was looked up on?
 *
 * ⚠️ Query provenance alone is NOT linkage. A lookup on A@example.com can return
 * a row that is about an unrelated B@example.com — a broker mis-hit, a shared
 * breach dump, a fuzzy provider match. Publishing `parent:A` for that row unions
 * B's cluster into A's on nothing but "this came back from that query", and
 * because both are well-formed emails the shape gate in `recordMateKey` cannot
 * see it. Two identities with no NAME rows then merge silently, since the
 * collision detector only splits on conflicting names.
 *
 * So the record-mate key is published only when the row's own content names the
 * selector — its value, or one of its non-provenance metadata fields.
 */
export function recordCorroboratesSelector(
  value: string,
  metadata: Record<string, unknown> | null | undefined,
  selector: string,
): boolean {
  const needle = selector.trim().toLowerCase();
  if (!needle) return false;
  if (namesSelector(value, needle)) return true;
  const meta = metadata ?? {};
  for (const [k, v] of Object.entries(meta)) {
    if (PROVENANCE_META_KEYS.has(k)) continue;
    if (typeof v === "string" && namesSelector(v, needle)) return true;
    // One level of nesting: providers commonly nest the matched record.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (PROVENANCE_META_KEYS.has(k2)) continue;
        if (typeof v2 === "string" && namesSelector(v2, needle)) return true;
      }
    }
  }
  return false;
}

/** Anything outside a selector's own character set separates two tokens. */
const SELECTOR_TOKEN_SPLIT = /[^a-z0-9_.%+@-]+/;

/**
 * Does `text` name `needle` as a WHOLE selector token?
 *
 * ⚠️ Never a substring test. `"johnsmith2".includes("johnsmith")` and
 * `"xa@example.com".includes("a@example.com")` are both true, so substring
 * corroboration lets a lookup on one identity publish its record-mate key on a
 * row about a different one — the union this gate exists to stop. `text` is
 * split on characters a selector cannot contain (spaces, `/`, `:`, `,`, …), so
 * a profile URL or a prose sentence still yields the selector as one token;
 * prose punctuation at a token's edge (`a@example.com.`) is trimmed, and an
 * `@handle` mention also names `handle`.
 */
function namesSelector(text: string, needle: string): boolean {
  for (const raw of text.toLowerCase().split(SELECTOR_TOKEN_SPLIT)) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (!t) continue;
    if (t === needle) return true;
    if (t.startsWith("@") && t.slice(1) === needle) return true;
    if (needle.startsWith("@") && t === needle.slice(1)) return true;
  }
  return false;
}

function normalizePersonName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isSharedInfraKey(key: string): boolean {
  return SHARED_INFRA_KEY_PREFIXES.has(key.split(":", 1)[0]);
}

/**
 * Build identity clusters from the artifact set. Conservative union-find:
 * artifacts merge only when they share a STRONG identifier
 * (email / phone / username / address / parent-seed). Then we split any
 * cluster that spans conflicting US states.
 */
export function buildIdentityClusters(
  artifacts: Artifact[],
  seedValue: string | null,
  reviews?: Record<string, ReviewAdjustment>,
): ClusterReport {
  const seedHint = detectNameLocationSeed(seedValue);
  const seedState = seedHint?.state ?? null;
  const seedName = seedHint?.name ?? null;

  // Map each strong-identifier value → cluster index.
  type Bucket = {
    artifacts: Artifact[];
    keys: Set<string>;
  };
  const buckets: Bucket[] = [];
  const keyToIdx = new Map<string, number>();

  // A merge signal is a single reason two artifacts may belong together. Every
  // key that can union a bucket maps to exactly one signal type — there is no
  // fuzzy/text path — which is what enforces the T1-2 §8 safety rule: clusters
  // only merge on handle / email / phone / shared-infrastructure, never on
  // display names, bios, or other free text.
  // `derived` marks a hit the artifact did NOT observe: the handle key an EMAIL
  // implies from its own local-part (see emailHandleKey). It unions like any
  // other key, but it is a restatement of the email's own string, not a second
  // observation — so the cap logic below has to be able to tell the two apart.
  type SignalHit = { key: string; signal: MergeSignal; raw: string; platform: string | null; derived?: true };
  const signalsFor = (a: Artifact): SignalHit[] => {
    const hits: SignalHit[] = [];
    // A lookup that found nothing links nothing: the selector it names (often a
    // guessed email permutation) was probed, not observed. See isNegativeResultArtifact.
    if (isNegativeResultArtifact(a)) return hits;
    const kind = a.kind.toLowerCase();
    const v = a.value.trim();
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const platform = typeof meta.platform === "string" && meta.platform.trim()
      ? meta.platform.trim().toLowerCase()
      : (a.source ?? null);

    if (kind === "email" && v) {
      hits.push({ key: `email:${v.toLowerCase()}`, signal: "EMAIL_MATCH", raw: v, platform });
      // The local-part is a handle. See emailHandleKey for the guard.
      const eh = emailHandleKey(v);
      if (eh) hits.push({ key: `handle:${eh}`, signal: "HANDLE_MATCH", raw: v, platform, derived: true });
    }
    if (kind === "phone" && v) {
      const pk = phoneMergeKey(v);
      if (pk) hits.push({ key: pk, signal: "PHONE_MATCH", raw: v, platform });
    }

    // Handle-bearing signals: the value of username/handle artifacts, plus a
    // `metadata.handle` on any artifact (social_profile, avatar, …). Display
    // names and bios are deliberately NOT consulted.
    const handleRaws: string[] = [];
    if ((kind === "username" || kind === "handle") && v) handleRaws.push(v);
    if (typeof meta.handle === "string" && meta.handle.trim()) handleRaws.push(meta.handle.trim());
    for (const raw of handleRaws) {
      const norm = normalizeHandle(raw);
      if (norm) hits.push({ key: `handle:${norm}`, signal: "HANDLE_MATCH", raw, platform });
    }

    if (["address", "ip", "wallet"].includes(kind) && v) {
      hits.push({ key: `${kind}:${v.toLowerCase()}`, signal: "SHARED_INFRASTRUCTURE", raw: v, platform });
    }
    const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim().toLowerCase();
    if (parent) hits.push({ key: `parent:${parent}`, signal: "SHARED_INFRASTRUCTURE", raw: parent, platform });
    // The auto-persist path stamps `queried_selector` — the selector the tool was
    // called on — on every row it writes (21 of 79 rows on thread d72fa44a,
    // 2026-09-20). Rows yielded by ONE lookup on one durable selector are
    // record-mates and union under the same weakest signal as `parent`. Gated on
    // shape, not kind: a selector with whitespace is a person name (the 19-identity
    // name-only harvest), and name equality is never linkage (T1-2 §8).
    // ⚠️ Gated on CORROBORATION, not merely on the stamp being present: a lookup
    // on A can return a row about an unrelated B, and unioning on provenance
    // alone puts two people in one identity cluster. See
    // recordCorroboratesSelector.
    const queriedRaw = String(meta.queried_selector ?? "");
    const queriedKey = recordMateKey(queriedRaw);
    if (
      queriedKey && queriedKey !== `parent:${parent}` &&
      recordCorroboratesSelector(v, meta, queriedRaw)
    ) {
      hits.push({ key: queriedKey, signal: "SHARED_INFRASTRUCTURE", raw: queriedRaw, platform });
    }
    // …and the selector's OWN row publishes the same key, so the email/phone/
    // username artifact and the rows a lookup on it yielded land together. Still
    // shared-infra: it says "came from the same lookup", never "corroborated".
    if (kind === "email" || kind === "phone" || kind === "username" || kind === "handle") {
      const own = recordMateKey(v);
      if (own) hits.push({ key: own, signal: "SHARED_INFRASTRUCTURE", raw: v, platform });
    }

    // Cross-link selectors carried in metadata: a breach/profile row commonly
    // names the OTHER concrete selectors of the same person (the email row lists
    // the owner's phone + instagram_handle; the address row's email). Union on
    // those shared CONCRETE selectors so one person's email / phone / handle /
    // address rows merge into a single cluster instead of fragmenting into
    // one-per-attribute clusters. Names and other free text are still NEVER
    // consulted (T1-2 §8), and these keys reuse the same `email:` / `phone:` /
    // `handle:` / `address:` namespace as the value-based keys above so a
    // metadata reference and the standalone artifact converge.
    for (const e of collectStrings(meta.email, meta.emails)) {
      if (!e.includes("@")) continue;
      hits.push({ key: `email:${e.toLowerCase()}`, signal: "EMAIL_MATCH", raw: e, platform });
      const eh = emailHandleKey(e);
      if (eh) hits.push({ key: `handle:${eh}`, signal: "HANDLE_MATCH", raw: e, platform, derived: true });
    }
    for (const p of collectStrings(meta.phone, meta.phones)) {
      const pk = phoneMergeKey(p);
      if (pk) hits.push({ key: pk, signal: "PHONE_MATCH", raw: p, platform });
    }
    // Breach extractors write the owner's OTHER handles as `usernames[]` and the
    // record-mate as `associated_username` / `associated_email` (the MyFitnessPal
    // row: "username LilDee808, email cnnamongirl90@…"). Same signal class as the
    // singular keys; reading them is what lets a handle seed reach the email it
    // co-occurs with in one breach record. Names stay out (T1-2 §8).
    for (const e of collectStrings(meta.associated_email, meta.associated_emails)) {
      if (!e.includes("@")) continue;
      hits.push({ key: `email:${e.toLowerCase()}`, signal: "EMAIL_MATCH", raw: e, platform });
    }
    for (const h of collectStrings(
      meta.instagram_handle, meta.instagram, meta.twitter, meta.username, meta.github, meta.tiktok,
      meta.usernames, meta.handles, meta.associated_username, meta.associated_usernames,
    )) {
      const norm = normalizeHandle(h);
      if (norm) hits.push({ key: `handle:${norm}`, signal: "HANDLE_MATCH", raw: h, platform });
    }
    for (const ad of collectStrings(meta.address, meta.current_address)) {
      if (ad.length >= 6) hits.push({ key: `address:${ad.toLowerCase()}`, signal: "SHARED_INFRASTRUCTURE", raw: ad, platform });
    }
    return hits;
  };
  const strongKeysFor = (a: Artifact): string[] => signalsFor(a).map((h) => h.key);

  // Collision-flagged artifacts (namesakes / unrelated entities the pipeline
  // already quarantined) must NOT seed or strengthen the subject's identity
  // clusters. They are surfaced separately in the report (collision section)
  // and remain in the artifact table for audit.
  const live = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (m.false_positive === true) return false;
    // Analyst verdict is authoritative. An artifact the analyst marked False
    // ("dismissed"/"wrong") must NOT seed or strengthen an identity cluster or
    // its confidence — the same exclusion the Evidence list already applies via
    // labelForArtifact. Without `reviews` threaded in, clustering silently
    // re-promoted analyst-dismissed artifacts into CONFIRMED clusters.
    const rev = reviews?.[a.id];
    if (rev === "dismissed" || rev === "wrong") return false;
    // isClusterIneligible, not isCollisionArtifact: the latter tests only the
    // legacy collision flags, and NONE of the 104 subject_unlinked artifacts in
    // production carry any of them (measured 2026-08-10 across all 4 affected
    // threads). The gate was not leaky — it was inapplicable, so every
    // quarantined row entered clustering and from there drove the report, the
    // Clusters tab, the graph, the Identity score and the cluster audit.
    if (isClusterIneligible(a)) return false;
    return true;
  });

  // Infrastructure and parent-seed selectors can fan out to unrelated people
  // (shared IPs, households, wallets, breach rows, or collection batches).
  // When one such selector carries three or more distinct names, it is no
  // longer safe to use that selector as an automatic identity-union key.
  const namesByParentKey = new Map<string, Set<string>>();
  for (const a of live) {
    const kind = a.kind.toLowerCase();
    if (kind !== "name" && kind !== "person") continue;
    const name = normalizePersonName(a.value);
    if (!name) continue;
    for (const key of strongKeysFor(a)) {
      if (!key.startsWith("parent:")) continue;
      const names = namesByParentKey.get(key) ?? new Set<string>();
      names.add(name);
      namesByParentKey.set(key, names);
    }
  }

  const namesBySharedKey = new Map<string, Set<string>>();
  for (const [key, names] of namesByParentKey) {
    namesBySharedKey.set(key, new Set(names));
  }
  for (const a of live) {
    const kind = a.kind.toLowerCase();
    if (!SHARED_INFRA_KEY_PREFIXES.has(kind) || kind === "parent") continue;
    const value = a.value.trim().toLowerCase();
    if (!value) continue;
    const selectorKey = `${kind}:${value}`;
    for (const parentKey of strongKeysFor(a).filter((key) => key.startsWith("parent:"))) {
      const linkedNames = namesByParentKey.get(parentKey);
      if (!linkedNames) continue;
      const names = namesBySharedKey.get(selectorKey) ?? new Set<string>();
      linkedNames.forEach((name) => names.add(name));
      namesBySharedKey.set(selectorKey, names);
    }
  }
  const sharedInfraKeys = new Set(
    Array.from(namesBySharedKey.entries())
      .filter(([, names]) => names.size >= SHARED_INFRA_NAME_THRESHOLD)
      .map(([key]) => key),
  );

  for (const a of live) {
    const keys = strongKeysFor(a).filter((key) => !sharedInfraKeys.has(key));
    if (keys.length === 0) {
      buckets.push({ artifacts: [a], keys: new Set() });
      continue;
    }
    const hits = new Set<number>();
    for (const k of keys) {
      const idx = keyToIdx.get(k);
      if (idx !== undefined) hits.add(idx);
    }
    if (hits.size === 0) {
      const idx = buckets.push({ artifacts: [a], keys: new Set(keys) }) - 1;
      for (const k of keys) keyToIdx.set(k, idx);
    } else {
      // Merge into the first hit, union others.
      const indices = Array.from(hits).sort((x, y) => x - y);
      const target = indices[0];
      buckets[target].artifacts.push(a);
      keys.forEach((k) => buckets[target].keys.add(k));
      for (let i = 1; i < indices.length; i++) {
        const src = buckets[indices[i]];
        buckets[target].artifacts.push(...src.artifacts);
        src.keys.forEach((k) => {
          buckets[target].keys.add(k);
          keyToIdx.set(k, target);
        });
        src.artifacts = [];
        src.keys.clear();
      }
      for (const k of buckets[target].keys) keyToIdx.set(k, target);
    }
  }

  /**
   * How many pieces would this group fall into WITHOUT the derived email→handle
   * links? Same union-find as the bucket pass above, run over observed keys only.
   *
   * `> 1` means the derived key is LOAD-BEARING: the only thing joining those
   * pieces is that an email's local-part spells the same string as a handle.
   */
  const componentsWithoutDerivedKeys = (group: Artifact[]): number => {
    const comps: { keys: Set<string>; n: number }[] = [];
    const keyOwner = new Map<string, number>();
    for (const a of group) {
      const keys = signalsFor(a)
        .filter((h) => !h.derived)
        .map((h) => h.key)
        .filter((k) => !sharedInfraKeys.has(k));
      const hits = new Set<number>();
      for (const k of keys) {
        const i = keyOwner.get(k);
        if (i !== undefined) hits.add(i);
      }
      if (hits.size === 0) {
        const idx = comps.push({ keys: new Set(keys), n: 1 }) - 1;
        for (const k of keys) keyOwner.set(k, idx);
        continue;
      }
      const indices = Array.from(hits).sort((x, y) => x - y);
      const target = indices[0];
      comps[target].n += 1;
      keys.forEach((k) => comps[target].keys.add(k));
      for (let i = 1; i < indices.length; i++) {
        const src = comps[indices[i]];
        comps[target].n += src.n;
        src.n = 0;
        src.keys.forEach((k) => comps[target].keys.add(k));
        src.keys.clear();
      }
      for (const k of comps[target].keys) keyOwner.set(k, target);
    }
    return comps.filter((c) => c.n > 0).length;
  };

  // Build descriptive clusters and split by geographic conflict.
  const summarize = (group: Artifact[]): Omit<IdentityCluster, "id" | "label" | "matchesSeedLocation"> => {
    const pick = (kind: string) =>
      Array.from(new Set(group.filter((a) => a.kind.toLowerCase() === kind).map((a) => a.value.trim()))).filter(Boolean);
    const emails = pick("email");
    const usernames = [...pick("username"), ...pick("handle")];
    const phones = pick("phone");
    const addresses = pick("address");
    const ips = pick("ip");
    const names = [...pick("name"), ...pick("person")];
    const states = Array.from(new Set([
      ...addresses.map(extractStateFromText),
      ...group.flatMap((a) => {
        const m = (a.metadata ?? {}) as Record<string, unknown>;
        return [extractStateFromText(String(m.region ?? "")), extractStateFromText(String(m.state ?? "")), extractStateFromText(String(m.geo ?? ""))];
      }),
    ].filter(Boolean))) as string[];
    const areaCodes = Array.from(new Set(phones.map(extractAreaCode).filter(Boolean))) as string[];
    const sources = Array.from(new Set(group.map((a) => a.source ?? "").filter(Boolean)));
    // Members enter the mean at their EFFECTIVE confidence (stored value floored
    // by the server's `confidence_cap_applied`), the same number every other
    // surface renders. Reading the raw column here let a member the server had
    // capped at 40 contribute 95 to the headline.
    const confidences = group.map((a) => effectiveConfidenceOrZero(a)).filter((n) => n > 0);
    const baseConfidence = confidences.length ? Math.round(confidences.reduce((s, n) => s + n, 0) / confidences.length) : 0;
    const memberMax = confidences.length ? Math.max(...confidences) : null;

    // T1-2: explain the merge and reward corroborating signals. Aggregate the
    // keys actually shared by >=2 artifacts in this group, skipping any
    // selector the T1-1 fan-out guard disqualified.
    const agg = new Map<string, { signal: MergeSignal; count: number; raws: Set<string>; platforms: Set<string> }>();
    for (const a of group) {
      // A merge needs the key shared by two distinct artifacts, so count each
      // artifact at most once per key — an artifact that repeats the same handle
      // in both its value and metadata.handle must not look like two sources.
      const countedHere = new Set<string>();
      for (const h of signalsFor(a)) {
        if (sharedInfraKeys.has(h.key)) continue;
        let entry = agg.get(h.key);
        if (!entry) agg.set(h.key, (entry = { signal: h.signal, count: 0, raws: new Set(), platforms: new Set() }));
        if (!countedHere.has(h.key)) {
          entry.count += 1;
          countedHere.add(h.key);
          if (h.platform) entry.platforms.add(h.platform);
        }
        entry.raws.add(h.raw.trim().toLowerCase());
      }
    }
    const signalsPresent = new Set<MergeSignal>();
    let maxHandlePlatforms = 0;
    const ranked: { rank: number; sub: number; text: string }[] = [];
    for (const [key, entry] of agg) {
      if (entry.count < 2) continue; // only one artifact carries it → not a merge
      signalsPresent.add(entry.signal);
      const value = key.slice(key.indexOf(":") + 1);
      if (entry.signal === "HANDLE_MATCH") {
        maxHandlePlatforms = Math.max(maxHandlePlatforms, entry.platforms.size || entry.count);
        ranked.push({ rank: 0, sub: 0, text: `HANDLE_MATCH: ${value}` });
        for (const raw of Array.from(entry.raws).sort()) {
          if (raw !== value) ranked.push({ rank: 0, sub: 1, text: `HANDLE_MATCH: ${raw} -> ${value}` });
        }
      } else if (entry.signal === "EMAIL_MATCH") {
        ranked.push({ rank: 1, sub: 0, text: `EMAIL_MATCH: ${value}` });
      } else if (entry.signal === "PHONE_MATCH") {
        ranked.push({ rank: 2, sub: 0, text: `PHONE_MATCH: ${value}` });
      } else {
        ranked.push({ rank: 3, sub: 0, text: `SHARED_INFRASTRUCTURE: ${key}` });
      }
    }
    ranked.sort((x, y) => x.rank - y.rank || x.sub - y.sub || x.text.localeCompare(y.text));
    const mergeReasons = ranked.map((r) => r.text);

    let bonus = 0;
    for (const s of signalsPresent) bonus += MERGE_SIGNAL_WEIGHT[s];
    if (signalsPresent.has("HANDLE_MATCH")) {
      bonus += Math.min(HANDLE_REINFORCE_CAP, HANDLE_REINFORCE_PER_PLATFORM * Math.max(0, maxHandlePlatforms - 2));
    }
    let confidence = Math.min(100, baseConfidence + bonus);
    // ⛔ THE HEADLINE NEVER EXCEEDS ITS STRONGEST MEMBER.
    //
    // Merge signals explain WHY rows were grouped and rank clusters against each
    // other; they are not a second source. Adding them on top of the mean,
    // bounded only by 100, printed cluster headers of 98 / 95 / 90 on a
    // production export whose members were never recorded above 70 — and the
    // report's own accuracy guardrails then flagged the case BLOCKED for
    // "a cluster declares a tier its evidence does not support". The analyst
    // reads the header as the confidence of the identity, so it is bounded by
    // the best evidence in it. Bonus still orders clusters below that ceiling.
    // A group with no usable member number keeps the legacy path (0 + bonus).
    if (memberMax !== null && confidence > memberMax) confidence = memberMax;

    // Corroborating identity evidence — anything beyond a repeated handle that
    // ties the cluster to a real person: an email/phone/address/IP selector in
    // the cluster, a non-handle merge signal (email/phone/shared-infrastructure),
    // or an identity-bearing record (breach/profile row carrying name/address/
    // phone/dob/etc.).
    const hasIdentityRecord = group.some((a) => {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      return IDENTITY_BEARING_META_KEYS.some((k) => typeof m[k] === "string" && (m[k] as string).trim().length > 0);
    });
    // ⛔ SHARED INFRASTRUCTURE IS NOT IDENTITY CORROBORATION.
    //
    // An address, IP, wallet or parent domain is shared BY CONSTRUCTION: a
    // household or building shares an address, a VPN exit / carrier NAT /
    // corporate egress shares an IP, every tenant of a hosting provider shares a
    // parent domain. None of them says WHO the person is, which is the only
    // question HANDLE_ONLY_CLUSTER_CAP exists to answer. Counting them here let
    // a subject and their landlord — or two strangers behind one CGNAT — reach
    // CONFIRMED (>=85) on username breadth alone.
    //
    // Removed from this predicate, deliberately: `addresses.length`, `ips.length`
    // and `signalsPresent.has("SHARED_INFRASTRUCTURE")`. Infra still MERGES the
    // cluster and still appears in mergeReasons — it is demoted from proof to
    // lead, not deleted. What remains lifts the cap because each names a person
    // or a durable personal selector: an email or phone in the cluster, an
    // EMAIL_MATCH / PHONE_MATCH merge, or a record carrying an identifying field.
    //
    // ⛔ AND AN EMAIL IS NOT CORROBORATION OF THE HANDLE IT IS SPELLED FROM.
    //
    // `emailHandleKey` lets an email union with a same-named handle. That link
    // is one string compared with itself: `vernjjulian@gmail.com` reaching
    // `hackerrank.com/vernjjulian` says the two names match, not that the two
    // accounts are one person. Measured on production thread `b4e575a6`
    // (2026-09-07): `oathnet_lookup(5307105091)` -> the email ->
    // `username_sweep(vernjjulian)` 19 seconds later — the sweep hits EXIST
    // because the local-part was pivoted, so counting them back as
    // corroboration of the email is circular. Corpus-wide, 95 (thread,
    // local-part) pairs union this way, and five of them carry the derivation
    // in the source string itself (`derived_from_email`, `email_localpart`,
    // `seed_derivation`, `derived from email … (local-part)`).
    //
    // So when the derived key is LOAD-BEARING — remove it and the cluster falls
    // apart — the email door to `hasIdentityCorroboration` is shut and the
    // handle-only cap stands. Everything else still lifts it: a phone, a
    // PHONE_MATCH, an identity-bearing record, and any email whose tie to the
    // cluster survives without the derived key (a shared `email:` address, a
    // metadata cross-link, a phone in common).
    //
    // NOTE THE BLAST RADIUS: derived keys did not exist before the email→handle
    // link was added, so a group that was ever connected without them stays at
    // one component and is untouched. This can only reach clusters that link
    // itself created.
    const derivedLinkIsLoadBearing = componentsWithoutDerivedKeys(group) > 1;
    const hasIdentityCorroboration =
      (!derivedLinkIsLoadBearing && (emails.length > 0 || signalsPresent.has("EMAIL_MATCH"))) ||
      phones.length > 0 || signalsPresent.has("PHONE_MATCH") ||
      hasIdentityRecord;

    // Handle-only / username-only cluster → cap into the VERIFY band. Platform
    // breadth still raised the raw score (lead strength), but it must not read
    // as a confirmed identity. Genuinely corroborated clusters are untouched.
    if (!hasIdentityCorroboration && confidence > HANDLE_ONLY_CLUSTER_CAP) {
      confidence = HANDLE_ONLY_CLUSTER_CAP;
    }

    return { artifacts: group, emails, usernames, phones, addresses, ips, names, states, areaCodes, sources, confidence, warnings: [], mergeReasons };
  };

  const out: IdentityCluster[] = [];
  let idx = 0;
  // Cluster-explosion guard: a single weak artifact with no durable selector
  // (account-existence checks, breach rows, lone sweep-only handles, "other"
  // notes) must NOT each become its own "candidate identity cluster". They
  // stay in the Artifact Table for audit; we only tally how many were withheld.
  let suppressedWeakSingletons = 0;
  for (const b of buckets) {
    if (b.artifacts.length === 0) continue;
    if (!bucketQualifiesAsCluster(b.artifacts, b.keys)) {
      suppressedWeakSingletons += b.artifacts.length;
      continue;
    }
    const base = summarize(b.artifacts);
    // Split by US state if a cluster spans more than one observed state.
    if (base.states.length > 1) {
      for (const st of base.states) {
        const subset = b.artifacts.filter((a) => {
          if (extractStateFromText(a.value) === st) return true;
          const m = (a.metadata ?? {}) as Record<string, unknown>;
          return [String(m.region ?? ""), String(m.state ?? ""), String(m.geo ?? "")]
            .some((s) => extractStateFromText(s) === st);
        });
        if (!subset.length) continue;
        const sub = summarize(subset);
        sub.warnings.push(`Split from larger cluster on state=${st}; verify before merging back.`);
        out.push({ ...sub, id: clusterDisplayId(idx), label: clusterLabel(idx, sub), matchesSeedLocation: seedState ? st === seedState : null });
        idx++;
      }
      continue;
    }
    const matches = seedState && base.states[0] ? base.states[0] === seedState : null;
    if (seedState && base.states[0] && base.states[0] !== seedState) {
      base.warnings.push(`Geography conflict: cluster ties to ${base.states[0]} but seed targets ${seedState}.`);
    }
    out.push({ ...base, id: clusterDisplayId(idx), label: clusterLabel(idx, base), matchesSeedLocation: matches });
    idx++;
  }

  // Detect same-name collision across clusters.
  const allNames = out.flatMap((c) => c.names.map((n) => n.toLowerCase()));
  const dupeName = allNames.some((n, i) => allNames.indexOf(n) !== i);
  const conflictingStates = new Set(out.map((c) => c.states[0]).filter(Boolean)).size > 1;
  const conflictingEmailRegions = (() => {
    // emails that don't overlap but clusters claim different states
    const withEmail = out.filter((c) => c.emails.length && c.states.length);
    const states = new Set(withEmail.map((c) => c.states[0]));
    return withEmail.length > 1 && states.size > 1;
  })();
  const conflictingAreaCodes = areaCodesDisagreeAcrossClusters(out.map((c) => c.areaCodes));
  const collision = dupeName || conflictingStates || conflictingEmailRegions || conflictingAreaCodes;

  const warnings: string[] = [];
  for (const key of sharedInfraKeys) {
    const names = Array.from(namesBySharedKey.get(key) ?? []);
    const kind = key.slice(0, key.indexOf(":"));
    warnings.push(
      `Shared-infrastructure split: one ${kind} selector links ${names.length} distinct names and was excluded from automatic identity merging. Manual corroboration is required.`,
    );
  }
  if (suppressedWeakSingletons > 0) {
    warnings.push(
      `${suppressedWeakSingletons} weak single-artifact signal${suppressedWeakSingletons === 1 ? "" : "s"} (account-existence checks, sweep-only handles, breach rows) are listed in the Artifact Table but are NOT shown as standalone identity clusters — they lack a durable selector or corroboration.`,
    );
  }
  if (collision) {
    warnings.push(
      "Potential same-name collision detected. The following artifacts may belong to different people and should not be merged without additional corroboration.",
    );
  }
  // An analyst-supplied name that record-derived names contradict is an OPEN QUESTION,
  // not something the model's prose gets to resolve. See name-conflict.ts.
  const nameConflict = detectNameConflict(artifacts);
  if (nameConflict) warnings.push(formatNameConflict(nameConflict));
  if (seedState && !out.some((c) => c.matchesSeedLocation)) {
    warnings.push(
      `No direct ${seedState} corroboration found in this run. Out-of-area same-name candidates are shown separately — do not conclude the subject is "not from ${seedState}".`,
    );
  }
  if (conflictingAreaCodes) {
    warnings.push(
      "Phone area codes differ between clusters. An area code shows where a number was issued, not where its holder lives — treat the difference as a lead for separating identities, not as proof of it.",
    );
  }

  // Minor-safety: surface a hard warning if any artifact carries a minor flag.
  const minorArtifacts = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    return m.possible_minor === true || m.minor_warning === true;
  });
  if (minorArtifacts.length) {
    warnings.unshift(
      "Possible minor-related signal detected in profile text. Do not expand or expose details without lawful purpose and manual review.",
    );
  }

  // Adult-platform × minor collision: never co-list an adult profile next to a
  // possible-minor artifact in the same primary identity cluster.
  const ADULT_HOSTS = /(onlyfans|fansly|pornhub|manyvids|chaturbate|stripchat|cam4|adultfriendfinder|xhamster|redtube|youporn|spankbang|brazzers)/i;
  const adultArtifacts = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const plats = Array.isArray(m.platforms) ? (m.platforms as string[]).join(" ") : "";
    return ADULT_HOSTS.test(a.value) || ADULT_HOSTS.test(plats) || ADULT_HOSTS.test(String(a.source ?? ""));
  });
  if (minorArtifacts.length && adultArtifacts.length) {
    warnings.unshift(
      "SAFETY COLLISION: adult-platform artifacts and possible-minor signals appear in this case. They are NOT confirmed to belong to the same person. Treat as a hard collision warning — manual review required before any further pivoting.",
    );
  }

  // Sort: seed-location matches first, then by confidence.
  out.sort((a, b) => {
    const am = a.matchesSeedLocation === true ? 1 : 0;
    const bm = b.matchesSeedLocation === true ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.confidence - a.confidence;
  });

  // RENUMBER AFTER THE SORT. `id`/`label` were assigned at construction, then
  // this sort reordered them, so the codes no longer matched presentation order
  // — the report printed "C002" above "C001". Worse, ClustersTab rendered
  // `clusterDisplayId(renderIndex)` instead of `c.id`, so the SAME cluster was
  // C001 in the workspace and C002 in the export (live: thread b74049ad, where
  // the unattributed cluster and the glitterkittens12 cluster swapped codes
  // between the two surfaces). An analyst citing "C001" has to mean one thing.
  for (let i = 0; i < out.length; i++) {
    out[i] = { ...out[i], id: clusterDisplayId(i), label: relabelCluster(out[i].label, i) };
  }

  return { clusters: out, collision, warnings, seedName, seedState };
}

/**
 * Rewrite the `Cxxx` code embedded in an already-built cluster label to match
 * its final position. The rest of the label (the identity it names) is
 * untouched — only the code moves.
 */
function relabelCluster(label: string, idx: number): string {
  return label.replace(/^Cluster C\d{3}\b/, `Cluster ${clusterDisplayId(idx)}`);
}

function clusterLabel(idx: number, c: Omit<IdentityCluster, "id" | "label" | "matchesSeedLocation">): string {
  // Deterministic, ASCII-safe id (C001, C002, …). Never String.fromCharCode —
  // that walked past 'Z' into punctuation/control characters once a run
  // produced >26 clusters. See report-hygiene.clusterDisplayId.
  const id = clusterDisplayId(idx);
  const loc = c.states[0] ?? c.addresses[0] ?? null;
  // #485: the seed's name USED to sit between `c.names[0]` and the cluster's own
  // email/username. That made the seed subject the default identity of every
  // cluster without a `name` artifact — so a second person, reached through his
  // own selectors, was published under the seed subject's name together with his
  // SSN, address, phone and arrest record (live thread 4a1bea49). The engine had
  // already separated the two and a collision_detector had fired; attribution
  // overrode all of it here.
  //
  // A cluster is named by ITS OWN evidence or not at all. Nothing legitimate is
  // lost: when the cluster really is the subject's, the subject's name IS in
  // `c.names`. And the label is never the place to assert linkage — the same-name
  // collision detector below reads `c.names`, never this string, so a borrowed
  // name is a duplicate identity that no downstream check can see.
  const who = c.names[0] ?? c.emails[0] ?? c.usernames[0] ?? UNATTRIBUTED_CLUSTER_LABEL;
  return loc ? `Cluster ${id} — ${who} (${loc})` : `Cluster ${id} — ${who}`;
}

// ---- Report integration -----------------------------------------------

/** Render an identity-cluster section + collision warning for the markdown report. */
export function buildClusterSection(
  report: ClusterReport,
  opts: { includeWarnings?: boolean } = {},
): string {
  if (report.clusters.length === 0) return "_No identity clusters extracted yet._";
  const parts: string[] = [];
  // The full report renders these warnings once at the top, so it opts out here
  // to avoid printing the banner twice; standalone callers keep them by default.
  if ((opts.includeWarnings ?? true) && report.warnings.length) {
    parts.push(`> ⚠️ **${report.warnings[0]}**`);
    for (const w of report.warnings.slice(1)) parts.push(`> ${w}`);
    parts.push("");
  }
  for (const c of report.clusters) {
    parts.push(`### ${c.label}`);
    parts.push(`- **Confidence:** ${c.confidence}`);
    if (c.matchesSeedLocation === true) parts.push(`- **Seed location match:** yes`);
    else if (c.matchesSeedLocation === false) parts.push(`- **Seed location match:** no — possible different person`);
    if (c.emails.length) parts.push(`- **Emails:** ${c.emails.join(", ")}`);
    if (c.usernames.length) parts.push(`- **Usernames:** ${c.usernames.join(", ")}`);
    if (c.phones.length) parts.push(`- **Phones:** ${c.phones.join(", ")} ${c.areaCodes.length ? `(area ${c.areaCodes.join(", ")})` : ""}`.trim());
    if (c.addresses.length) parts.push(`- **Addresses:** ${c.addresses.join(" • ")}`);
    if (c.states.length) parts.push(`- **States observed:** ${c.states.join(", ")}`);
    if (c.ips.length) parts.push(`- **IPs:** ${c.ips.join(", ")}`);
    if (c.sources.length) parts.push(`- **Source tools:** ${humanizeSourceChain(c.sources)}`);
    if (c.mergeReasons.length) parts.push(`- **Merge reasons:** ${c.mergeReasons.join("; ")}`);
    if (c.warnings.length) parts.push(`- **Warnings:** ${c.warnings.join(" / ")}`);
    parts.push("");
  }
  return parts.join("\n");
}
