/**
 * report-hygiene.ts — pure, deterministic helpers for OSINT report rendering.
 *
 * These live at the PRESENTATION layer only. They never change a finding's
 * canonical confidence, status, or integrity label (`labelForArtifact`,
 * `applyEvidenceCaps`, `deriveStatus`). They make the rendered report
 * deterministic, ASCII-safe, internally consistent, and conservative about
 * weak/uncorroborated signals — without promoting anything.
 */

import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isUsernameSweepSource, labelForArtifact, type ConfLabel, type ReviewAdjustment } from "@/lib/intel";
import { isRejectedReview } from "@/lib/review";
import { isQuarantined } from "@/lib/quarantine";

// ---------------------------------------------------------------------------
// #1 — Deterministic, ASCII-safe cluster IDs.
//
// Root cause of the corrupted IDs ("Cluster ^", "Cluster {", blank glyphs):
// labels were built with String.fromCharCode(65 + idx). Past idx=25 ('Z')
// this walks into punctuation (`[ \ ] ^ _ \``), then a–z, then `{ | } ~`,
// then DEL (127) and non-printable control characters — exactly the garbage
// seen once an investigation produced >26 clusters.
// ---------------------------------------------------------------------------

/** Stable, zero-padded, ASCII-only cluster id: 0 -> "C001", 25 -> "C026". */
export function clusterDisplayId(idx: number): string {
  const n = Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : 0;
  return `C${String(n + 1).padStart(3, "0")}`;
}

/** True if a string contains only printable ASCII (space..~). Used by tests. */
export function isAsciiSafe(s: string): boolean {
  return /^[\x20-\x7E]*$/.test(s);
}

// ---------------------------------------------------------------------------
// #3 — Strip promotional "CONFIRMED" wording from a rendered artifact VALUE
// when the backend integrity label is NOT actually CONFIRMED. The model
// sometimes writes "… — CONFIRMED via two independent classes" into the value
// string itself; that must not read as a confirmation when the row is VERIFY.
// Render-only: the underlying artifact is untouched (audit trail preserved).
// ---------------------------------------------------------------------------

// Deliberately case-SENSITIVE (no `i` flag): the promotional wording this
// targets is the model echoing the bracketed evidence-label vocabulary
// ("[CONFIRMED]") into a value string, e.g. "— CONFIRMED via two independent
// classes". An `i` flag also matched ordinary lowercase prose use of the verb
// "confirmed" (e.g. "Phone +19165299191 confirmed in 5 breach corpora:
// Digido.ph, ...") and deleted everything from "confirmed" up to the next
// `.`/`;`/`|`, mangling unrelated legitimate report text — live case caught in
// the "Collision / Likely Unrelated" section, where the value silently lost
// "confirmed in 5 breach corpora: Digido" and rendered as "...191 .ph, 1win, ...".
const CONFIRMED_WORDING_RE = /\s*[—–\-:|(]*\s*\bCONFIRMED\b[^.;|]*/g;

export function sanitizeValueForLabel(value: string, isConfirmed: boolean): string {
  if (isConfirmed) return value;
  if (!/\bCONFIRMED\b/.test(value)) return value;
  const cleaned = value.replace(CONFIRMED_WORDING_RE, " ").replace(/\s{2,}/g, " ").replace(/\s*[—–\-:|]\s*$/, "").trim();
  return cleaned.length ? cleaned : value.replace(/\bCONFIRMED\b/g, "reported").trim();
}

function displayJsonKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * Keep structured artifact payloads out of analyst-facing report cells.
 * Canonical values remain untouched for exports and audit; this only produces
 * a compact presentation string for valid JSON objects/arrays.
 */
export function formatArtifactDisplayValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return "No structured details";
    if (parsed.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      return parsed.map(String).join(", ");
    }
    return `${parsed.length} structured record${parsed.length === 1 ? "" : "s"}`;
  }

  if (parsed && typeof parsed === "object") {
    const fields = Object.entries(parsed as Record<string, unknown>)
      .filter(([, item]) => item != null && ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 4)
      .map(([key, item]) => `${displayJsonKey(key)}: ${String(item)}`);
    return fields.length ? fields.join(" · ") : "Structured details";
  }

  return value;
}

// ---------------------------------------------------------------------------
// #6 — Collision quarantine. Artifacts the pipeline already flagged as a
// namesake/unrelated-entity collision must not seed or strengthen the main
// subject network; they belong in a separate "Collision / likely unrelated"
// section.
// ---------------------------------------------------------------------------

/**
 * The structural shape the two collision predicates actually read.
 *
 * Widening the PARAMETER TYPE is not the same thing as widening the PREDICATE.
 * The note at #6b below forbids the latter — `isCollisionArtifact` is also the
 * report's collision-SECTION membership test, so adding a signal to it moves
 * rows between report sections. This changes nothing about what either function
 * MATCHES; it only lets a caller holding a lighter projection ask the question.
 *
 * It exists so `quarantineSets` (which owns a structural `QuarantineInput`, and
 * deliberately imports nothing from this layer) can be handed
 * `isClusterIneligible` as an injected predicate instead of re-implementing it.
 * A full `Artifact` and a `QuarantineInput` are both assignable here.
 */
export type AuthorityInput = {
  kind: string;
  metadata?: Record<string, unknown> | null;
};

export function isCollisionArtifact(a: AuthorityInput): boolean {
  const kind = (a.kind ?? "").toLowerCase();
  if (kind === "excluded_collision") return true;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  // metadata.status === "excluded" is the pipeline's definitive "not the subject"
  // signal (a namesake / unrelated entity). It must quarantine like an excluded_collision
  // so a same-name profile can neither seed the subject's identity clusters nor let the
  // report read "No collisions flagged" while such rows exist. (The React Evidence panel
  // already buckets status:"excluded" as excluded — this aligns the markdown report + clustering.)
  if (typeof m.status === "string" && m.status.toLowerCase() === "excluded") return true;
  return m.excluded_collision === true || m.collision === true || m.possible_collision === true;
}

// ---------------------------------------------------------------------------
// #6b — The PROMOTE boundary for `subject_unlinked`.
//
// WHY THIS IS A SEPARATE PREDICATE AND NOT A WIDENED `isCollisionArtifact`.
// Widening the one above is the obvious one-line fix and it is wrong twice over:
//
//  1. `isCollisionArtifact` is also the report's collision-SECTION membership
//     test (`intel.ts:1099` → `collisionIds`).
//  2. `intel.ts:1137` builds `conflictNoted` with `if (collisionIds.has(a.id))
//     return false;` — and `conflictNoted` is the branch that quotes a row's own
//     `subject_unlinked_reason` verbatim (`intel.ts:1150`).
//
// So folding quarantine into `isCollisionArtifact` would MOVE every quarantined
// row out of the section that states exactly why the pipeline distrusted it and
// into the generic collision list, replacing the backend's own words with
// boilerplate. The report would get quietly worse while the clustering bug
// looked fixed. Keeping quarantine a distinct signal preserves both surfaces.
//
// AUTHORITY, NOT EVIDENCE. This makes a quarantined row inert; it never hides
// it. The row stays on the Evidence board, stays in the report's collision
// section with its reason, and stays a node in the entity graph — flagged. What
// it may no longer do is seed or strengthen the subject's identity.
// ---------------------------------------------------------------------------

/**
 * May this artifact seed or strengthen the subject's identity?
 *
 * `false` for a legacy collision flag OR an ACTIVE `subject_unlinked` quarantine.
 * Use at every surface that grants identity authority — clustering, graph edges,
 * confidence dimensions — so the two signals can never drift apart again.
 *
 * ACTIVE, via `isQuarantined` — not the raw `isSubjectUnlinked` flag. The two
 * predicates answer different questions and only one of them is about authority:
 *
 *   isSubjectUnlinked  Was this row ever machine-flagged as having unproven
 *                      linkage? — history, and the basis for DISCLOSURE. The
 *                      report's collision section (`conflictNoted` in intel.ts)
 *                      still keys on this, correctly: releasing a row must not
 *                      erase the fact that it arrived on the collision axis.
 *   isQuarantined      Does that flag CURRENTLY deny the row authority? — false
 *                      once an analyst records `linkage_confirmed`.
 *
 * This function is an authority decision, so it takes the second. It previously
 * took the first, which made it (with `quarantineSets`) one of two boundaries
 * that ignored the release hatch while three others honoured it —
 * `labelForArtifact`, `evidenceStatus` and `adjustedConfidence` all restore full
 * authority on `linkage_confirmed`, and `adjustedConfidence` documents the
 * distinction explicitly. An adjudicated row therefore read CONFIRMED at the
 * label and still could not enter a cluster, a graph edge, or a confidence
 * dimension. (Ultrareview #448 `bug_006`.)
 *
 * Release does not rewrite history: the row keeps `subject_unlinked` and its
 * `subject_unlinked_reason`, and keeps appearing in the collision disclosure.
 * What it regains is only the authority the analyst explicitly granted it.
 */
export function isClusterIneligible(a: AuthorityInput): boolean {
  return isCollisionArtifact(a) || isQuarantined(a.metadata);
}

// ---------------------------------------------------------------------------
// #7 — Reserved / fictional phone numbers (e.g. NANPA 555-01xx). The backend
// already flags them with metadata.reserved_number; render-level we mark them
// non-actionable and annotate the value. We do NOT change canonical status and
// do NOT delete the artifact (audit trail preserved).
// ---------------------------------------------------------------------------

export function isReservedNumber(a: Artifact): boolean {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return m.reserved_number === true;
}

export function reservedNumberAnnotation(a: Artifact): string | null {
  if (!isReservedNumber(a)) return null;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const reason = typeof m.reserved_reason === "string" ? m.reserved_reason : "reserved/example range — no real subscriber";
  return `⚠ non-actionable: ${reason}`;
}

// ---------------------------------------------------------------------------
// #8 — Source/claim discrepancies mis-kinded as legal_record. A row like
// "Bond: $2,500 (Local 10) vs 'to be set' (TMZ) — discrepancy noted" is a
// SOURCE conflict, not a criminal/legal record. We override the DISPLAY kind
// to "source_conflict" at render only (backend kind untouched). Harm-bearing
// legal records keep their kind and conservative language.
// ---------------------------------------------------------------------------

const DISCREPANCY_RE = /\b(discrepanc(y|ies)|conflict(ing)?)\b|\bvs\.?\b|\bversus\b/i;

/** True when a legal_record value is actually a reporting/source discrepancy. */
export function isSourceDiscrepancy(a: Artifact): boolean {
  const kind = (a.kind ?? "").toLowerCase();
  if (kind !== "legal_record") return false;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  if (m.discrepancy === true || m.source_conflict === true) return true;
  return DISCREPANCY_RE.test(a.value ?? "");
}

/** Display kind for the report. Reclassifies source discrepancies away from
 *  legal_record so a reporting disagreement isn't presented as a criminal
 *  record. All other kinds pass through unchanged. */
export function reportDisplayKind(a: Artifact): string {
  if (isSourceDiscrepancy(a)) return "source_conflict";
  return a.kind;
}

// ---------------------------------------------------------------------------
// #2 — Cluster-explosion guard. A single-artifact bucket should only be shown
// as a candidate IDENTITY cluster when it is anchored by a durable selector.
// Weak singletons (account-existence checks, breach rows, "other" notes, lone
// sweep-only handles) stay in the Artifact Table but do not each spawn a
// cluster. Multi-artifact buckets (merged on a real signal) always qualify.
// ---------------------------------------------------------------------------

const NAME_KINDS = new Set(["name", "person"]);

/**
 * Whether a bucket should appear as a standalone candidate IDENTITY cluster.
 *
 * Qualification is driven by the bucket's STRONG-SELECTOR keys (the same keys
 * the clustering engine uses to merge: email/phone/handle/address/ip/parent),
 * NOT by a hardcoded kind list — so a `social_profile` carrying
 * `metadata.handle` still counts, while an `account_id` existence-check that
 * carries no selector does not.
 *
 * Rules:
 *  - merged bucket (≥2 artifacts)            → qualifies (real hypothesis)
 *  - lone name/person                        → qualifies (identity anchor)
 *  - lone artifact with no strong key        → suppressed (account checks, breach
 *                                              rows, "other" notes, …)
 *  - lone handle-only hit from username_sweep → suppressed unless corroborated
 *  - lone artifact with email/phone/address/ip/non-sweep handle → qualifies
 */
export function bucketQualifiesAsCluster(group: Artifact[], strongKeys?: Set<string>): boolean {
  if (group.length === 0) return false;
  if (group.length >= 2) return true;
  const a = group[0];
  if (NAME_KINDS.has((a.kind ?? "").toLowerCase())) return true;
  const keys = strongKeys ?? new Set<string>();
  if (keys.size === 0) return false; // no durable selector → not a cluster
  // A lone handle is not enough on its own when it's a sweep-only existence hit.
  const onlyHandleKeys = Array.from(keys).every((k) => k.startsWith("handle:"));
  if (onlyHandleKeys && isUsernameSweepSource(a.source)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// #5 (classification only — NOT wired to canonical labels; see report).
// Source-quality of a username_sweep account hit, for future renderer use.
// Promotion to CORRELATED would loosen the sweep-only VERIFY clamp and is
// intentionally NOT applied here pending sign-off.
// ---------------------------------------------------------------------------

export type SweepRouteQuality = "route_only" | "exists" | "content";

export function sweepRouteQuality(a: Artifact): SweepRouteQuality {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const text = `${a.value ?? ""} ${String(m.note ?? "")} ${a.source ?? ""}`.toLowerCase();
  // "HTTP 200 but no content retrieved" / 404-behind-200 / 202 → route only.
  if (/no content retrieved|profile returned 404|\b202\b|ad tracker only|empty\/abandoned/.test(text)) {
    return "route_only";
  }
  if (m.profile_content === true || /profile|bio|avatar/.test(text)) return "content";
  return "exists";
}

// ---------------------------------------------------------------------------
// Conservative breach-dataset dedup.
//
// The pipeline sometimes records the SAME breach dataset twice under name
// variants from the same source pair — e.g. "Synthient Credential Stuffing 2025
// (1.9B)" (kind breach_exposure) and "Synthient Credential Stuffing Threat Data
// (1.9B records, April 2025)" (kind weak_lead). The hash-based insert dedup keys
// on exact value+kind, so name variants slip through and double-list in both the
// Artifact Table and Network Connections.
//
// This collapses two breach artifacts ONLY when ALL of the following hold:
//   • both are breach-dataset kinds (breach_exposure / weak_lead),
//   • the same normalized source string,
//   • the same record-count magnitude token (1.9b / 220m / 73k),
//   • the same year, AND
//   • they share at least one significant (≥4-char) word.
// Different breaches, different sources, or a shared number alone never collapse.
// ---------------------------------------------------------------------------

const BREACH_DEDUP_KINDS = new Set(["breach_exposure", "weak_lead"]);
const BREACH_COUNT_RE = /(\d+(?:\.\d+)?)\s*(b|m|k|billion|million|thousand)\b/i;
const BREACH_YEAR_RE = /\b(?:19|20)\d{2}\b/;

function breachMagnitude(unit: string): string {
  const u = unit.toLowerCase();
  if (u === "billion") return "b";
  if (u === "million") return "m";
  if (u === "thousand") return "k";
  return u;
}

function breachCountToken(value: string): string | null {
  const m = value.match(BREACH_COUNT_RE);
  return m ? `${m[1]}${breachMagnitude(m[2])}` : null;
}

function breachSignificantWords(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

function normalizedBreachSource(source: string | null | undefined): string {
  return (source ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Higher rank wins as the surviving representative: prefer the more specific
 *  breach_exposure kind, then higher confidence, then richer metadata. */
function breachRepRank(a: Artifact): number {
  let r = 0;
  if (a.kind === "breach_exposure") r += 1000;
  r += a.confidence ?? 0;
  r += Object.keys(a.metadata ?? {}).length;
  return r;
}

export function dedupeBreachDatasets(artifacts: Artifact[]): Artifact[] {
  type Cand = { a: Artifact; words: Set<string> };
  const groups = new Map<string, Cand[]>();
  for (const a of artifacts) {
    if (!BREACH_DEDUP_KINDS.has(a.kind)) continue;
    const count = breachCountToken(a.value);
    const year = a.value.match(BREACH_YEAR_RE)?.[0] ?? null;
    if (!count || !year) continue; // require BOTH a count magnitude and a year
    const key = `${normalizedBreachSource(a.source)}::${count}::${year}`;
    const arr = groups.get(key) ?? [];
    arr.push({ a, words: breachSignificantWords(a.value) });
    groups.set(key, arr);
  }

  const dropIds = new Set<string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const [rep, ...rest] = [...members].sort((x, y) => breachRepRank(y.a) - breachRepRank(x.a));
    for (const m of rest) {
      // Only collapse when the variant shares a significant word with the rep —
      // guards against two genuinely different datasets that happen to share a
      // source pair, count magnitude, and year.
      if ([...m.words].some((w) => rep.words.has(w))) dropIds.add(m.a.id);
    }
  }

  return dropIds.size ? artifacts.filter((a) => !dropIds.has(a.id)) : artifacts;
}
// ---------------------------------------------------------------------------
// #8 — The CaseReport Identity panel authority gate.
//
// The workspace Report tab's Identity panel (CaseReport.tsx) is the surface an
// analyst actually reads. "Real name", "Phone", "Alt email" are IDENTITY-
// AUTHORITY claims — they assert the row belongs to the subject. A quarantined
// row appearing there as "Alt email" asserts the very linkage `subject_unlinked`
// says is unproven, which is the same class of leak #448 closed in clusters,
// graph edges, confidence dimensions, and the generated report.
//
// This was extracted from CaseReport.tsx (where it lived as a private function)
// so it is testable without exporting from the component, and so the quarantine
// gate uses the SAME `isClusterIneligible` predicate as the other four surfaces
// — the two signals can never drift apart here either.
//
// AUTHORITY, NOT EVIDENCE. A quarantined row stays on the Evidence board, in
// the report's collision section, and as a flagged node in the entity graph.
// It simply may not appear as a subject identity field. Same rule as everywhere
// else in this boundary.
// ---------------------------------------------------------------------------

export type IdentityRow = { field: string; value: string; label: ConfLabel };

function pickBestIdentity(
  artifacts: Artifact[],
  kinds: string[],
  reviews?: Record<string, ReviewAdjustment>,
): Artifact | null {
  // An analyst-rejected row is not a candidate for an identity field at all.
  // These fields are AUTHORITY claims (see the #8 banner above) — rendering a
  // rejected row as "Real name" with a FAILED pill still asserts it IS the
  // subject's name. Same exclusion `buildIdentityClusters` applies to cluster
  // membership (intel.ts:1865): a dismissed/wrong row may not seed or
  // strengthen identity. The row keeps its place in the evidence tables.
  const pool = artifacts.filter(
    (a) =>
      kinds.includes(String(a.kind ?? "").toLowerCase()) &&
      !isClusterIneligible(a) &&
      !isRejectedReview(reviews?.[a.id]),
  );
  if (!pool.length) return null;
  const rank: Record<ConfLabel, number> = {
    CONFIRMED: 6, CORRELATED: 5, INFERRED: 4, VERIFY: 3, LOW: 2, CONFLICT: 1, FAILED: 0,
  };
  // Rank through the verdict too, so an attested row outranks an unreviewed one
  // instead of the ordering being decided before the analyst is consulted.
  return pool.slice().sort((a, b) => {
    const ra = rank[labelForArtifact(a, reviews?.[a.id])] ?? 0;
    const rb = rank[labelForArtifact(b, reviews?.[b.id])] ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

function pickAllEmailsIdentity(
  artifacts: Artifact[],
  reviews?: Record<string, ReviewAdjustment>,
): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of artifacts.filter(
    (x) =>
      String(x.kind ?? "").toLowerCase() === "email" &&
      !isClusterIneligible(x) &&
      !isRejectedReview(reviews?.[x.id]),
  )) {
    const k = String(a.value ?? "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function buildIdentityRows(artifacts: Artifact[], reviews?: Record<string, ReviewAdjustment>): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const name = pickBestIdentity(artifacts, ["name", "person"], reviews);
  if (name) rows.push({ field: "Real name", value: name.value, label: labelForArtifact(name, reviews?.[name.id]) });

  const dob = pickBestIdentity(artifacts, ["dob"], reviews);
  if (dob) rows.push({ field: "Date of birth", value: dob.value, label: labelForArtifact(dob, reviews?.[dob.id]) });

  const age = pickBestIdentity(artifacts, ["age"], reviews);
  if (age && !dob) rows.push({ field: "Age", value: age.value, label: labelForArtifact(age, reviews?.[age.id]) });

  const phone = pickBestIdentity(artifacts, ["phone"], reviews);
  if (phone) rows.push({ field: "Phone", value: phone.value, label: labelForArtifact(phone, reviews?.[phone.id]) });

  const region = pickBestIdentity(artifacts, ["location", "geo", "address"], reviews);
  if (region) rows.push({ field: "Likely region", value: region.value, label: labelForArtifact(region, reviews?.[region.id]) });

  const emails = pickAllEmailsIdentity(artifacts, reviews);
  emails.forEach((e, i) => {
    rows.push({
      field: i === 0 ? "Primary email" : i === 1 ? "Alt email" : `Email ${i + 1}`,
      value: e.value,
      label: labelForArtifact(e, reviews?.[e.id]),
    });
  });

  const gender = pickBestIdentity(artifacts, ["gender"], reviews);
  if (gender) rows.push({ field: "Gender (implied)", value: gender.value, label: labelForArtifact(gender, reviews?.[gender.id]) });

  return rows;
}
