/**
 * Association likelihood — a graded "how likely are these the same operator"
 * measurement (0–100) computed from the case's own structure. Stage 1 of the
 * signed-off rollout (2026-11-08): frontend-only, display-only, READS
 * everything and WRITES nothing. It never feeds readiness, the review queue,
 * or the report.
 *
 * Why this exists: the engine could only say "confirmed or not", so a strong
 * co-occurrence pattern rendered as nothing (0 evidence links on a case whose
 * data clearly connected), while an LLM-authored finding printed "52% — Weak"
 * with no structural link behind it. This module replaces both failure modes
 * with one deterministic number, computed per case from the actual data, with
 * its reasons attached — never a fixed threshold, never a model guess.
 *
 * Hard rules (pinned by tests):
 *  1. NEVER shown as "confirmed". The word "confirmed" belongs to the analyst.
 *     Bands are Strong / Likely / Possible / Weak — the same rungs the cluster
 *     board and `linkageWord` already use (80 / 60 / 40).
 *  2. Analyst verdicts are AUTHORITY, not evidence. A rejected row is removed
 *     from scoring entirely; a confirmed row gets NO score change (the
 *     operator's 2026-11-02 decision, same as confidence.ts). This deliberately
 *     deviates from the draft proposal's "confirmed raises the score" line.
 *  3. A selector is withheld only when it has NO clean witness. Quarantine is
 *     per-row: quarantined rows still REGISTER their selectors (the gate must
 *     know them) but contribute NO evidence — no co-occurrence weight, no
 *     declaration bonus, no attributes. When any non-quarantined artifact
 *     observes the same selector (e.g. an analyst-uploaded breach row naming
 *     a mailbox an earlier name-only harvest had quarantined), the selector
 *     scores from its clean witnesses alone. Inherited quarantine cannot
 *     silently zero a live link — and a fully quarantined selector still gets
 *     no figure, because linkage is exactly what quarantine says is unproven.
 *     Display-only: nothing here releases quarantine authority anywhere else
 *     (linkage_confirmed, labels, clustering are all untouched).
 *  4. Mirrors are not corroboration. Independence is counted in SOURCE
 *     CLASSES (intel.independentSourceClasses), so five resold copies of one
 *     leak count as one observation.
 *  5. Infrastructure never implies identity. A pair supported only by shared
 *     IP/address caps at 35 — the existing shared-host cap semantics.
 *  6. Model-authored rows are OUTPUT, not evidence. `finding` rows, meta
 *     decisions, and minimax/correlate summary rows are excluded from
 *     extraction; otherwise the engine's own prose would feed the score
 *     that is supposed to check it (circularity).
 *  7. Contradictions lower the score multiplicatively, each with a stated
 *     reason in `opposing`. Nothing is silently dropped.
 *
 * Pure and deterministic: same artifacts + same reviews in, same report out.
 * Verified 2026-11-08 against a live 70-artifact case export: the pair carried
 * by one analyst-uploaded breach row scored Possible (45 — one observation,
 * one weight), the pair carried by a structured provider declaration scored
 * Likely (65), the pair an LLM prose finding had asserted at "52%" scored
 * Weak with its reasons exposed, and every namesake pair (~299) withheld —
 * matching the analyst's read of the case.
 */

import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  buildIdentityClusters,
  independentSourceClasses,
  isNegativeResultArtifact,
  normalizeHandle,
  type ReviewAdjustment,
} from "@/lib/intel";
import { isClusterIneligible } from "@/lib/report-hygiene";
import { isRejectedArtifact } from "@/lib/analyst-decisions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SelectorKind = "email" | "phone" | "handle" | "ip" | "address" | "wallet" | "name";

export interface CaseSelector {
  /** Stable identity, e.g. "email:alpha@example.com". */
  key: string;
  kind: SelectorKind;
  /** Display value (first-seen raw form). */
  value: string;
  /** Artifacts that carry this selector (own value or a declared field). */
  artifactIds: string[];
  /** Rule 3: true only when EVERY carrying artifact is quarantined. */
  withheld: boolean;
}

export type AssociationBand =
  | "strong"     // ≥ 80
  | "likely"     // ≥ 60
  | "possible"   // ≥ 40
  | "weak"       // > 0, < 40
  | "unlinked"   // no supporting signal
  | "withheld"   // rule 3 — no figure
  | "excluded";  // rule 2 — analyst rejected a member row

export interface AssociationScore {
  /** The two selector keys, sorted. */
  a: string;
  b: string;
  /** 0–100, or null when the band is withheld / excluded. */
  score: number | null;
  band: AssociationBand;
  /** Why the score reads as it does — one line per contributing signal. */
  reasons: string[];
  /** What weighs against it — contradictions, dampeners, caps. */
  opposing: string[];
  /** Independent source classes that contributed (mirrors collapsed). */
  sourceClasses: string[];
  /** True when shared IP/address is the ONLY support (caps at 35). */
  infraOnly: boolean;
  /** Display values for the two selectors. */
  aValue: string;
  bValue: string;
  aKind: SelectorKind;
  bKind: SelectorKind;
}

export interface ClusterAssociation {
  clusterId: string;
  otherClusterId: string;
  label: string;
  otherLabel: string;
  score: number;
  band: AssociationBand;
  /** The strongest cross pairs that produced this aggregate. */
  topPairs: AssociationScore[];
}

export interface AssociationReport {
  pairs: AssociationScore[];
  clusters: ClusterAssociation[];
  stats: {
    artifacts: number;
    selectors: number;
    scoredPairs: number;
    withheld: number;
    excluded: number;
  };
}

// ---------------------------------------------------------------------------
// Weights — tuned so ONE observation never reaches "Likely" on its own and
// mirrors can never stack. Combined with noisy-OR: p = 1 − Π(1 − wᵢ).
//
// ONE ROW = ONE OBSERVATION. Selectors regex'd out of a composite VALUE (a
// breach row's "email / handle / ip" text) earn the shared-record weight and
// nothing else — the same sighting cannot also collect the declaration bonus.
// The CO_RECORD bonus is reserved for STRUCTURED declarations: linking
// metadata fields and concrete_values, where the record itself asserts the
// association rather than merely containing both strings.
//
// Verified against the live case export: one breach row naming email+handle
// lands at 45 (Possible); a structured email declaration lands at 65 (Likely).
// ---------------------------------------------------------------------------

/** Base weight for two selectors observed together in ONE source class. */
const PAIR_WEIGHT: Record<string, number> = {
  "email:email": 0.5,
  "email:phone": 0.5,
  "phone:phone": 0.45,
  "email:handle": 0.45,
  "handle:phone": 0.4,
  "handle:handle": 0.3,
  "email:name": 0.2,
  "name:phone": 0.2,
  "handle:name": 0.15,
  "name:name": 0.1,
  "email:wallet": 0.45,
  "handle:wallet": 0.35,
  "phone:wallet": 0.35,
  "wallet:wallet": 0.4,
  "name:wallet": 0.15,
};

/** Any pair touching infrastructure only ever earns this much per class. */
const INFRA_WEIGHT = 0.15;
/** A STRUCTURED declared linking field (email_associated, concrete_values, …)
 *  naming the other selector. Never earned by value-text scans. */
const CO_RECORD_WEIGHT = 0.3;
/** Infrastructure-only support can never pass the shared-host rung. */
const INFRA_CAP = 35;

/** Attribute agreement weights — only count when seen in ≥2 independent classes. */
const ATTRIBUTE_WEIGHT = {
  dob: 0.35,
  state: 0.12,
  areaCode: 0.1,
  name: 0.12,
} as const;

/** A handle seen with more than this many distinct emails is a weak linker. */
const COMMON_HANDLE_EMAIL_THRESHOLD = 2;
const COMMON_HANDLE_DAMPENER = 0.5;

/** Contradiction factors — multiplicative, each disclosed in `opposing`. */
const FACTOR_GEO_CONFLICT = 0.75;
const FACTOR_DOB_CONFLICT = 0.6;

/** Band rungs — identical to the cluster board / linkageWord (80 · 60 · 40). */
export const BAND_STRONG_MIN = 80;
export const BAND_LIKELY_MIN = 60;
export const BAND_POSSIBLE_MIN = 40;

export function bandFor(score: number): AssociationBand {
  if (score >= BAND_STRONG_MIN) return "strong";
  if (score >= BAND_LIKELY_MIN) return "likely";
  if (score >= BAND_POSSIBLE_MIN) return "possible";
  if (score > 0) return "weak";
  return "unlinked";
}

// ---------------------------------------------------------------------------
// Row eligibility (rule 2 + rule 6)
// ---------------------------------------------------------------------------

/** Kinds whose VALUE is a composite observation worth scanning for selectors. */
const SCAN_KINDS = new Set([
  "breach_exposure",
  "other",
  "weak_lead",
  "account_id",
  "infrastructure",
  "social_footprint",
]);

/** Rule 6: model-authored rows are output, not evidence. */
function isModelAuthored(a: Artifact): boolean {
  const k = String(a.kind ?? "").toLowerCase();
  if (k === "finding" || k === "triage_decision" || k === "cluster_decision") return true;
  const src = String(a.source ?? "").toLowerCase();
  if (src.includes("minimax")) return true;
  if (String(a.value ?? "").startsWith("Identity cluster:")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Selector extraction
// ---------------------------------------------------------------------------

function normIp(v: string): string {
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return m.slice(1).map((n) => String(parseInt(n, 10))).join(".");
  return v.toLowerCase();
}

function normPhone(v: string): string | null {
  const d = v.replace(/\D+/g, "");
  return d.length >= 7 && d.length <= 15 ? d : null;
}

function selectorKey(kind: SelectorKind, raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  switch (kind) {
    case "email":
      return v.includes("@") ? `email:${v.toLowerCase()}` : null;
    case "phone": {
      const d = normPhone(v);
      return d ? `phone:${d}` : null;
    }
    case "handle": {
      const n = normalizeHandle(v);
      return n ? `handle:${n}` : null;
    }
    case "ip":
      return `ip:${normIp(v)}`;
    case "address": {
      const n = v.toLowerCase().replace(/\s+/g, " ");
      return n.length >= 8 ? `address:${n}` : null;
    }
    case "wallet":
      return v.length >= 20 ? `wallet:${v.toLowerCase()}` : null;
    case "name": {
      const n = v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
      const words = n.split(" ").filter(Boolean);
      return words.length >= 2 ? `name:${n}` : null;
    }
  }
}

/**
 * Metadata fields a record can use to DECLARE a co-selector. Only plain string
 * values on known keys are read, and they are weighted as co-record evidence,
 * never as identity proof.
 */
const DECLARED_FIELDS: Array<{ key: string; kind: SelectorKind }> = [
  { key: "email_associated", kind: "email" },
  { key: "email", kind: "email" },
  { key: "handle", kind: "handle" },
  { key: "username", kind: "handle" },
  { key: "phone", kind: "phone" },
  { key: "ip", kind: "ip" },
  { key: "address", kind: "address" },
  { key: "name_in_breach", kind: "name" },
  { key: "wallet", kind: "wallet" },
];

const KIND_MAP: Record<string, SelectorKind> = {
  email: "email",
  phone: "phone",
  username: "handle",
  handle: "handle",
  social: "handle",
  ip: "ip",
  ip_address: "ip",
  address: "address",
  wallet: "wallet",
  crypto_wallet: "wallet",
  crypto: "wallet",
  name: "name",
  person: "name",
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function ownSelector(a: Artifact): { kind: SelectorKind; key: string } | null {
  const kind = KIND_MAP[String(a.kind ?? "").toLowerCase()];
  if (!kind) return null;
  const key = selectorKey(kind, String(a.value ?? ""));
  return key ? { kind, key } : null;
}

/**
 * Selectors a row carries beyond its own value, in two evidence grades:
 *
 *  - `declared: true` — a STRUCTURED declaration: a linking metadata field or
 *    the provider's concrete_values dict. The record itself asserts the
 *    association, so these earn the CO_RECORD bonus on top of co-occurrence.
 *  - `declared: false` — CONTAINMENT only: a `queried_selector` provenance
 *    stamp (the row exists because a lookup ran on that selector — it says
 *    nothing about what the record contains) or a string regex'd out of a
 *    composite value. These earn co-occurrence weight only. One sighting of
 *    two strings in one text is ONE observation; counting it as a declaration
 *    as well was the double-count that inflated single-record pairs (measured
 *    2026-11-08: six "likely" pairs at 62–69% that were each one text row).
 */
function declaredSelectors(
  a: Artifact,
  knownHandles: ReadonlySet<string>,
): Array<{ kind: SelectorKind; key: string; declared: boolean }> {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const out = new Map<string, { kind: SelectorKind; declared: boolean }>();
  const add = (kind: SelectorKind, raw: unknown, declared: boolean) => {
    if (typeof raw !== "string") return;
    const key = selectorKey(kind, raw);
    if (!key) return;
    // A structured declaration outranks a containment sighting for the same key.
    const prev = out.get(key);
    if (!prev || (declared && !prev.declared)) out.set(key, { kind, declared });
  };

  // 1) Structured declared fields
  for (const f of DECLARED_FIELDS) {
    const raw = meta[f.key];
    const values = Array.isArray(raw) ? raw.slice(0, 3) : [raw]; // a dump naming many is not a link
    for (const v of values) add(f.kind, v, true);
  }

  // 2) concrete_values.usernames (oathnet-style dict) — provider-structured
  const cv = meta.concrete_values;
  if (cv && typeof cv === "object" && !Array.isArray(cv)) {
    const us = (cv as Record<string, unknown>).usernames;
    if (Array.isArray(us)) for (const u of us.slice(0, 5)) add("handle", u, true);
  }

  // 3) queried_selector — kind-aware, PROVENANCE only. A name query is NEVER a
  //    handle, and "this row came from a lookup on X" is never a declaration
  //    that the record links X to anything.
  const qs = meta.queried_selector;
  if (typeof qs === "string" && qs.trim()) {
    const qts = Array.isArray(meta.query_types) ? meta.query_types.map(String) : [];
    if (qs.includes("@")) add("email", qs, false);
    else if (qts.includes("username") || qts.includes("handle")) add("handle", qs, false);
    else if (qts.includes("ip")) add("ip", qs, false);
    else if (qts.includes("phone")) add("phone", qs, false);
    // person/name queries register nothing — names are attributes, not selectors
  }

  // 4) Composite-value scan ("email / handle / ip" breach rows). CONTAINMENT
  //    only. Document rows are skipped: a PDF filename like
  //    "export<seed>@example.com_….pdf" manufactures phantom selectors.
  const kind = String(a.kind ?? "").toLowerCase();
  const isDocument = typeof meta.content_type === "string" || /\.pdf\b/i.test(String(a.value ?? ""));
  if (SCAN_KINDS.has(kind) && !isDocument) {
    const text = String(a.value ?? "");
    for (const m of text.matchAll(EMAIL_RE)) add("email", m[0], false);
    for (const m of text.matchAll(IP_RE)) add("ip", m[0], false);
    // Compare in normalized form: `knownHandles` holds normalizeHandle output
    // (separators stripped), so a raw-text regex would miss "quiet_falcon77".
    // Whole tokens only, so a mailbox's local part is not read as a handle.
    if (knownHandles.size > 0) {
      for (const tok of text.split(/[\s,;|/()<>"'[\]{}]+/)) {
        if (!tok || tok.includes("@")) continue;
        const n = normalizeHandle(tok.replace(/^[:.-]+|[:.-]+$/g, ""));
        if (n && knownHandles.has(n)) add("handle", n, false);
      }
    }
  }

  return [...out.entries()].map(([key, v]) => ({ kind: v.kind, key, declared: v.declared }));
}

// ---------------------------------------------------------------------------
// Attribute extraction (state / area code / DOB / name agreement)
// ---------------------------------------------------------------------------

const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md",
  "ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc",
  "sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

const STATE_TAIL_RE = /,\s*([A-Z]{2})(?:\s*,|\s+\d{5}|\s*$|\s)/g;
const DOB_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/;

function statesOf(a: Artifact): Set<string> {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const out = new Set<string>();
  if (typeof meta.state === "string" && US_STATES.has(meta.state.toLowerCase())) out.add(meta.state.toLowerCase());
  if (Array.isArray(meta.states)) {
    for (const s of meta.states) {
      if (typeof s === "string" && US_STATES.has(s.toLowerCase())) out.add(s.toLowerCase());
    }
  }
  // Address tails only ("…, Example City, ID 83687") — never free text, so an
  // "IN" or "OR" inside prose cannot fabricate geography.
  const value = String(a.value ?? "");
  if (String(a.kind).toLowerCase() === "address") {
    for (const m of value.matchAll(STATE_TAIL_RE)) {
      const s = m[1].toLowerCase();
      if (US_STATES.has(s)) out.add(s);
    }
  }
  return out;
}

function areaCodeOf(a: Artifact): string | null {
  if (String(a.kind).toLowerCase() !== "phone") return null;
  const d = normPhone(String(a.value ?? ""));
  if (!d) return null;
  const local = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return local.length >= 10 ? local.slice(0, 3) : null;
}

function dobOf(a: Artifact): string | null {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const cv = meta.concrete_values;
  if (cv && typeof cv === "object" && !Array.isArray(cv)) {
    const d = (cv as Record<string, unknown>).dob;
    if (typeof d === "string") {
      const m = d.match(DOB_RE);
      if (m) return m[0];
    }
  }
  for (const key of ["dob", "date_of_birth", "birthdate"]) {
    const v = meta[key];
    if (typeof v === "string") {
      const m = v.match(DOB_RE);
      if (m) return m[0];
    }
  }
  const m = String(a.value ?? "").match(DOB_RE);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Score every selector pair the case's data connects, plus cross-cluster
 * aggregates. READ-ONLY: reviews are consulted only to EXCLUDE rejected rows
 * (rule 2) — a verdict never adds points.
 */
export function scoreAssociations(
  artifacts: Artifact[],
  seedValue: string | null,
  reviews?: Record<string, ReviewAdjustment>,
  /** Test seam: override source-class resolution. Production uses
   *  intel.independentSourceClasses — never pass this in app code. */
  deps?: { classesOf?: (a: Artifact) => string[] },
): AssociationReport {
  const classesOf = deps?.classesOf ?? independentSourceClasses;
  const sorted = [...artifacts].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // ---- Pass 1: own selectors (learns the case's handle vocabulary) --------
  const eligible: Artifact[] = [];
  const quarOf = new Map<string, boolean>();
  const ownOf = new Map<string, { kind: SelectorKind; key: string } | null>();
  let excluded = 0;
  /** Rule 2 at selector level: a rejected row's own selector stays out even when
   *  another row re-records it (same contract as analyst-decisions buildDecisionSets). */
  const rejectedKeys = new Set<string>();

  for (const a of sorted) {
    const review = reviews?.[a.id];
    if (isRejectedArtifact(a, review)) {
      excluded++;
      const own = ownSelector(a);
      if (own) rejectedKeys.add(own.key);
      continue; // rule 2
    }
    if (isNegativeResultArtifact(a)) continue; // a lookup that found nothing names nothing
    if (isModelAuthored(a)) continue; // rule 6
    eligible.push(a);
    quarOf.set(a.id, isClusterIneligible(a));
    ownOf.set(a.id, ownSelector(a));
  }

  const knownHandles = new Set<string>();
  for (const a of eligible) {
    const own = ownOf.get(a.id);
    if (own?.kind === "handle" && !rejectedKeys.has(own.key)) knownHandles.add(own.key.slice("handle:".length));
  }

  /** One evidence class per row: a canonical (sorted, de-duplicated) key, so the
   *  same classes in a different order are not a new independent observation. */
  const classKey = (a: Artifact): string => {
    const cs = [...new Set(classesOf(a))].sort();
    return cs.length > 0 ? cs.join("+") : "unclassed";
  };

  // ---- Pass 2: full registration ------------------------------------------
  interface SelAccum {
    kind: SelectorKind;
    value: string;
    artifactIds: string[];
    cleanWitness: boolean;
    withheldWitness: boolean;
  }
  const selectors = new Map<string, SelAccum>();
  /** Evidence bags per artifact. `declared` = structured declarations only;
   *  `linked` = containment (provenance stamps, value-text sightings). */
  const artifactSels = new Map<string, { own: string[]; declared: string[]; linked: string[] }>();

  const register = (
    a: Artifact,
    kind: SelectorKind,
    key: string,
    raw: string,
    bag: "own" | "declared" | "linked",
  ) => {
    if (rejectedKeys.has(key)) return; // rule 2: a rejected selector cannot be revived
    const quar = quarOf.get(a.id) ?? false;
    let s = selectors.get(key);
    if (!s) {
      s = { kind, value: raw, artifactIds: [], cleanWitness: false, withheldWitness: false };
      selectors.set(key, s);
    }
    if (!s.artifactIds.includes(a.id)) s.artifactIds.push(a.id);
    if (quar) s.withheldWitness = true;
    else s.cleanWitness = true;
    const bags = artifactSels.get(a.id) ?? { own: [], declared: [], linked: [] };
    if (!bags[bag].includes(key)) bags[bag].push(key);
    artifactSels.set(a.id, bags);
  };

  for (const a of eligible) {
    const own = ownOf.get(a.id);
    if (own) register(a, own.kind, own.key, String(a.value ?? ""), "own");
    for (const d of declaredSelectors(a, knownHandles)) {
      if (d.key !== own?.key) {
        register(a, d.kind, d.key, d.key.split(":").slice(1).join(":"), d.declared ? "declared" : "linked");
      }
    }
  }

  // ---- Handle rarity map (common-handle dampener) --------------------------
  // Clean rows only: quarantined sightings are unproven and cannot make a
  // handle look common (rule 3 — they contribute nothing, not even suspicion).
  const handleEmails = new Map<string, Set<string>>();
  for (const [key, s] of selectors) {
    if (s.kind !== "handle") continue;
    const emails = new Set<string>();
    for (const id of s.artifactIds) {
      if (quarOf.get(id)) continue;
      const bags = artifactSels.get(id);
      if (!bags) continue;
      for (const k of [...bags.own, ...bags.declared, ...bags.linked]) {
        if (k.startsWith("email:")) emails.add(k);
      }
    }
    handleEmails.set(key, emails);
  }

  // ---- Attribute evidence per selector (clean rows only) -------------------
  type AttrMap = Map<string, Map<string, Set<string>>>;
  const attrsOf = new Map<string, AttrMap>();
  const bump = (selKey: string, attr: string, value: string, cls: string) => {
    let am = attrsOf.get(selKey);
    if (!am) attrsOf.set(selKey, (am = new Map()));
    let vm = am.get(attr);
    if (!vm) am.set(attr, (vm = new Map()));
    let cs = vm.get(value);
    if (!cs) vm.set(value, (cs = new Set()));
    cs.add(cls);
  };

  for (const a of eligible) {
    if (quarOf.get(a.id)) continue; // rule 3: quarantined rows testify nothing
    const bags = artifactSels.get(a.id);
    if (!bags) continue;
    const selKeys = [...bags.own, ...bags.declared, ...bags.linked];
    if (selKeys.length === 0) continue;
    const cls = classKey(a);
    for (const st of statesOf(a)) for (const k of selKeys) bump(k, "state", st, cls);
    const ac = areaCodeOf(a);
    if (ac) for (const k of selKeys) bump(k, "areaCode", ac, cls);
    const dob = dobOf(a);
    if (dob) for (const k of selKeys) bump(k, "dob", dob, cls);
    const kind = String(a.kind).toLowerCase();
    if (kind === "name" || kind === "person") {
      const nk = selectorKey("name", String(a.value ?? ""));
      if (nk) for (const k of selKeys) bump(k, "name", nk, cls);
    }
  }

  // ---- Pair evidence (clean rows only) --------------------------------------
  const coCount = new Map<string, Map<string, number>>();
  const coRecord = new Map<string, Set<string>>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}__${y}` : `${y}__${x}`);

  for (const a of eligible) {
    if (quarOf.get(a.id)) continue; // rule 3: quarantined rows testify nothing
    const bags = artifactSels.get(a.id);
    if (!bags) continue;
    const cls = classKey(a);
    const all = [...new Set([...bags.own, ...bags.declared, ...bags.linked])].sort();
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const pk = pairKey(all[i], all[j]);
        let m = coCount.get(pk);
        if (!m) coCount.set(pk, (m = new Map()));
        m.set(cls, (m.get(cls) ?? 0) + 1);
        // The declaration bonus is earned by STRUCTURED declarations only —
        // never by a provenance stamp or a string we scanned out of the value.
        if (bags.declared.includes(all[i]) || bags.declared.includes(all[j])) {
          let s = coRecord.get(pk);
          if (!s) coRecord.set(pk, (s = new Set()));
          s.add(cls);
        }
      }
    }
  }

  // ---- Attribute agreement / conflict per pair --------------------------------
  const agreedClasses = (ak: string, bk: string, attr: string): { value: string; classes: Set<string> } | null => {
    const am = attrsOf.get(ak)?.get(attr);
    const bm = attrsOf.get(bk)?.get(attr);
    if (!am || !bm) return null;
    let best: { value: string; classes: Set<string> } | null = null;
    for (const [value, ca] of am) {
      const cb = bm.get(value);
      if (!cb) continue;
      const union = new Set([...ca, ...cb]);
      if (!best || union.size > best.classes.size) best = { value, classes: union };
    }
    return best && best.classes.size >= 2 ? best : null;
  };

  const attrConflict = (ak: string, bk: string, attr: string): boolean => {
    const am = attrsOf.get(ak)?.get(attr);
    const bm = attrsOf.get(bk)?.get(attr);
    if (!am || !bm || am.size === 0 || bm.size === 0) return false;
    for (const v of am.keys()) if (bm.has(v)) return false;
    return true;
  };

  // ---- Score every pair --------------------------------------------------------
  const pairs: AssociationScore[] = [];
  let withheldCount = 0;
  const keys = [...selectors.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const A = selectors.get(keys[i])!;
      const B = selectors.get(keys[j])!;
      const pk = pairKey(keys[i], keys[j]);
      const shared = coCount.get(pk) ?? new Map<string, number>();
      const declared = coRecord.get(pk) ?? new Set<string>();

      const base: AssociationScore = {
        a: keys[i],
        b: keys[j],
        aValue: A.value,
        bValue: B.value,
        aKind: A.kind,
        bKind: B.kind,
        score: null,
        band: "unlinked",
        reasons: [],
        opposing: [],
        sourceClasses: [],
        infraOnly: false,
      };

      // Rule 3: withheld only when a member has NO clean witness.
      if (!A.cleanWitness || !B.cleanWitness) {
        base.band = "withheld";
        base.reasons.push("Linkage unproven — every witness for a member is quarantined; no figure by rule 3.");
        pairs.push(base);
        withheldCount++;
        continue;
      }

      const weights: number[] = [];
      const classesOut = new Set<string>();
      const kinds = [A.kind, B.kind].sort().join(":");
      const touchesInfra = A.kind === "ip" || A.kind === "address" || B.kind === "ip" || B.kind === "address";
      let infraOnly = touchesInfra;

      // 1) shared records, per independent source class
      for (const [cls] of [...shared.entries()].sort()) {
        let w = touchesInfra ? INFRA_WEIGHT : (PAIR_WEIGHT[kinds] ?? 0.15);
        if (!touchesInfra) infraOnly = false;
        for (const s of [A, B]) {
          if (s.kind === "handle" && (handleEmails.get(keys[s === A ? i : j])?.size ?? 0) > COMMON_HANDLE_EMAIL_THRESHOLD) {
            w *= COMMON_HANDLE_DAMPENER;
            base.opposing.push(`Handle ${s.value} is seen with many emails — common-handle dampener ×${COMMON_HANDLE_DAMPENER}.`);
          }
        }
        weights.push(w);
        classesOut.add(cls);
        base.reasons.push(`Seen together in ${cls} (${A.kind}↔${B.kind}, +${Math.round(w * 100)}).`);
      }

      // 2) structured declared co-record links, per independent source class.
      //    A declaration of an INFRASTRUCTURE selector is still infrastructure
      //    evidence: it adds weight, but it must NEVER clear infraOnly — a
      //    record naming "this email sat behind this IP" does not make an IP
      //    identity-grade (rule 5; the cap below does its job either way).
      for (const cls of [...declared].sort()) {
        weights.push(CO_RECORD_WEIGHT);
        classesOut.add(cls);
        if (!touchesInfra) infraOnly = false;
        base.reasons.push(`Named in a declared linking field (${cls}, +${Math.round(CO_RECORD_WEIGHT * 100)}).`);
      }

      // 3) attribute agreement — ≥2 independent classes, rarity-weighted
      for (const [attr, w] of Object.entries(ATTRIBUTE_WEIGHT)) {
        const agree = agreedClasses(keys[i], keys[j], attr);
        if (agree) {
          weights.push(w);
          for (const c of agree.classes) classesOut.add(c);
          if (attr === "dob") infraOnly = false; // a shared DOB is person-grade
          const label = attr === "areaCode" ? "area code" : attr;
          base.reasons.push(`${label[0].toUpperCase()}${label.slice(1)} '${attr === "name" ? agree.value.replace(/^name:/, "") : agree.value}' agrees across ${agree.classes.size} independent records (+${Math.round(w * 100)}).`);
        }
      }

      if (weights.length === 0) continue; // genuinely unlinked — don't list it

      let p = 1;
      for (const w of weights) p *= 1 - w;
      let score = 100 * (1 - p);

      // 4) contradictions — multiplicative, disclosed
      if (attrConflict(keys[i], keys[j], "state")) {
        score *= FACTOR_GEO_CONFLICT;
        base.opposing.push(`Conflicting geography (no shared state) — ×${FACTOR_GEO_CONFLICT}.`);
      }
      if (attrConflict(keys[i], keys[j], "dob")) {
        score *= FACTOR_DOB_CONFLICT;
        base.opposing.push(`Conflicting DOB — ×${FACTOR_DOB_CONFLICT}.`);
      }

      // 5) infrastructure-only cap
      if (infraOnly && score > INFRA_CAP) {
        base.opposing.push(`Infrastructure-only evidence — capped at ${INFRA_CAP}.`);
        score = INFRA_CAP;
      }

      base.score = Math.max(0, Math.min(100, Math.round(score)));
      base.band = bandFor(base.score);
      base.infraOnly = infraOnly;
      base.sourceClasses = [...classesOut].sort();
      pairs.push(base);
    }
  }

  pairs.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || (x.a < y.a ? -1 : 1));

  // ---- Cluster aggregation ------------------------------------------------------
  // Reuse the identity clusterer READ-ONLY for grouping; the aggregate is the
  // noisy-OR of the cross-cluster pair scores, so each new corroboration
  // re-scores the link instead of passing a fixed count.
  const clusterReport = buildIdentityClusters(sorted, seedValue, reviews);
  const clusterOf = new Map<string, { id: string; label: string }>();
  for (const c of clusterReport.clusters) {
    for (const a of c.artifacts) {
      const bags = artifactSels.get(a.id);
      if (!bags) continue;
      for (const k of [...bags.own, ...bags.declared, ...bags.linked]) clusterOf.set(k, { id: c.id, label: c.label });
    }
  }

  const clusterPairs = new Map<string, { aId: string; bId: string; aLabel: string; bLabel: string; pairs: AssociationScore[] }>();
  for (const pr of pairs) {
    if (pr.score === null) continue;
    const ca = clusterOf.get(pr.a);
    const cb = clusterOf.get(pr.b);
    if (!ca || !cb || ca.id === cb.id) continue;
    const key = ca.id < cb.id ? `${ca.id}__${cb.id}` : `${cb.id}__${ca.id}`;
    let entry = clusterPairs.get(key);
    if (!entry) {
      const [aId, bId, aLabel, bLabel] = ca.id < cb.id ? [ca.id, cb.id, ca.label, cb.label] : [cb.id, ca.id, cb.label, ca.label];
      clusterPairs.set(key, (entry = { aId, bId, aLabel, bLabel, pairs: [] }));
    }
    entry.pairs.push(pr);
  }

  const clusters: ClusterAssociation[] = [];
  for (const entry of clusterPairs.values()) {
    let p = 1;
    for (const pr of entry.pairs) p *= 1 - (pr.score ?? 0) / 100;
    const score = Math.round(100 * (1 - p));
    clusters.push({
      clusterId: entry.aId,
      otherClusterId: entry.bId,
      label: entry.aLabel,
      otherLabel: entry.bLabel,
      score,
      band: bandFor(score),
      topPairs: entry.pairs.slice(0, 3),
    });
  }
  clusters.sort((x, y) => y.score - x.score || (x.clusterId < y.clusterId ? -1 : 1));

  return {
    pairs,
    clusters,
    stats: {
      artifacts: sorted.length,
      selectors: selectors.size,
      scoredPairs: pairs.filter((pr) => pr.score !== null).length,
      withheld: withheldCount,
      excluded,
    },
  };
}

/** Display helper — the "Likely linked (73%)" register. Never say "confirmed". */
export function associationLabel(s: Pick<AssociationScore, "score" | "band">): string {
  switch (s.band) {
    case "strong":
      return `Strong link (${s.score}%)`;
    case "likely":
      return `Likely linked (${s.score}%)`;
    case "possible":
      return `Possibly linked (${s.score}%)`;
    case "weak":
      return `Weak link (${s.score}%) — treat as a lead`;
    case "withheld":
      return "Withheld — linkage unproven (quarantined)";
    case "excluded":
      return "Excluded by analyst";
    default:
      return "Unlinked";
  }
}
