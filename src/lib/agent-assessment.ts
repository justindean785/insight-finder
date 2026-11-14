/**
 * Agent assessment — the AI's reading of every artifact, in two numbers and
 * plain words (Case-desk revamp R2, JD's decision 2026-11-02).
 *
 * The prototype shows, per finding, "Finding support %" and "Subject linkage %",
 * a delta since the previous assessment, reasons, opposing evidence, and a group
 * (supported / unresolved / conflict / quarantined). This module derives all of
 * that from engines that already exist; it invents no score of its own:
 *
 *  - finding support   = `displayConfidence(a).effective` — the server-computed,
 *                        capped confidence. "How sure are we the value is real?"
 *  - subject linkage   = the identity-cluster engine's score for the cluster the
 *                        artifact shares with the seed (`buildIdentityClusters`),
 *                        or 100 for the seed row itself. "How sure are we it is
 *                        the SUBJECT's?" Null when no email / phone / handle /
 *                        shared-infrastructure signal joins it to the seed — that
 *                        is "unresolved", not zero.
 *  - group             = quarantined (`isClusterIneligible`: active quarantine or
 *                        a collision flag) > conflict (the row contradicts the
 *                        case record) > supported (linkage ≥ 60, the cluster
 *                        board's "Likely link" rung) > unresolved.
 *
 * Rules that must hold, and are pinned by tests:
 *  - A quarantined row gets NO linkage figure. Linkage to the subject is exactly
 *    what quarantine says is unproven; printing a percentage would re-assert it.
 *  - A name-only match tops out at unresolved. The cluster engine never merges
 *    on names (T1-2 §8), so a `name` / `person` row is only ever linked through a
 *    concrete selector it carries. Without one, linkage stays null.
 *  - This module never writes a review. It READS the analyst's verdicts only to
 *    pass them to the cluster engine, as every production call site must
 *    (`review-authority-propagation.test.ts`): a row the analyst rejected may
 *    not lend linkage to its neighbours. The verdict itself is shown beside the
 *    assessment and overrides it on the surface; it is not folded into the
 *    number (JD's decision).
 *  - Confidence math (`confidence.ts`, `record_finding`) and authority
 *    (`authority.ts`) are untouched. Every number here is theirs.
 */
import { seedWithoutAttachments } from "@/lib/attachments";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isMetaArtifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityClusters, independentSourceClasses, isNegativeResultArtifact, type IdentityCluster, type ReviewAdjustment } from "@/lib/intel";
import { displayConfidence } from "@/lib/display-confidence";
import { isClusterIneligible, isCollisionArtifact } from "@/lib/report-hygiene";
import { isQuarantined, quarantineReason } from "@/lib/quarantine";
import { evidenceStatus } from "@/lib/evidence-status";
import { tierOf, type ConfidenceTier } from "@/lib/confidence-tier";

export type AssessmentGroup = "supported" | "unresolved" | "conflict" | "quarantined";

export interface AgentAssessment {
  artifactId: string;
  group: AssessmentGroup;
  /** 0–100, `displayConfidence(a).effective`; null when the row carries no usable score. */
  findingSupport: number | null;
  /** 0–100 from the cluster engine; null = unresolved (or withheld, when quarantined). */
  subjectLinkage: number | null;
  /** The AI's verdict in plain words. Never "confirmed": that word is the analyst's. */
  verdict: string;
  /** Why the linkage reads as it does. Engine strings, quoted — never invented here. */
  reasons: string[];
  /** What weighs against it: contradictions, caps, collision and quarantine reasons. */
  opposing: string[];
  /** The frontend cluster this row sits in (`IdentityCluster.id`), or null. */
  clusterId: string | null;
  /** Members of that cluster, this row included. 0 when unclustered. */
  clusterSize: number;
  /** Whether the row shares its cluster with the seed. */
  linkedToSeed: boolean;
  /** Independent corroborating source classes behind the row (`independentSourceClasses`). */
  independentClasses: string[];
  /** The backend union-find's cluster id (`artifacts.cluster_id`, else `metadata.cluster_id`) when it wrote one. */
  backendClusterId: string | null;
  /** The backend's tier word (`metadata.confidence_tier`) when it wrote a known one; else the tier of the support score. */
  tier: ConfidenceTier;
  /** True for the seed row itself. */
  isSeed: boolean;
}

export interface AssessmentReport {
  items: AgentAssessment[];
  byId: Record<string, AgentAssessment>;
  counts: Record<AssessmentGroup, number>;
  /** `IdentityCluster.id` of the cluster holding the seed, or null when no row carries the seed. */
  seedClusterId: string | null;
  clusters: IdentityCluster[];
}

/** Change in the two figures between two assessments of the same row. */
export interface AssessmentDelta {
  linkage: number | null;
  support: number | null;
  /** Group moved (e.g. unresolved → supported). */
  from: AssessmentGroup | null;
  to: AssessmentGroup;
}

/** The identity-cluster rungs (Strong ≥ 80 · Likely ≥ 60 · Possible ≥ 40), so the words agree everywhere. */
export const SUPPORTED_LINKAGE_MIN = 60;
/** Bars read amber below this (prototype). */
export const LINKAGE_ATTENTION_BELOW = 70;

const TIER_WORDS: ReadonlySet<string> = new Set(["confirmed", "likely", "possible", "weak", "unverified"]);

/**
 * Same canonicalisation `useThreadArtifacts` applies before dedup, kept local so the seed match needs no hook import.
 * Exported so a surface that groups rows by value (the report's Name) calls two
 * rows the same name exactly when the seed match here would.
 */
export function canonical(kind: string, raw: string): string {
  const v = (raw ?? "").trim().toLowerCase();
  const k = kind.toLowerCase();
  if (!v) return v;
  if (k === "phone") return v.replace(/[^\d+]/g, "");
  if (k === "username" || k === "handle" || k === "social") return v.replace(/^@+/, "");
  if (k === "name" || k === "person") return v.replace(/\s*\(.*\)\s*$/, "").trim();
  return v;
}

function seedForms(seedValue: string | null): Set<string> {
  const out = new Set<string>();
  const v = (seedValue ?? "").trim().toLowerCase();
  if (!v) return out;
  out.add(v);
  out.add(v.replace(/^@+/, ""));
  const digits = v.replace(/[^\d+]/g, "");
  if (digits.length >= 7) out.add(digits);
  return out;
}

function isSeedRow(a: Artifact, forms: Set<string>): boolean {
  if (forms.size === 0) return false;
  const c = canonical(a.kind, a.value);
  return c !== "" && forms.has(c);
}

function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x.trim() : typeof x === "object" && x && "reason" in x ? String((x as { reason: unknown }).reason).trim() : "")).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Plain words for a linkage figure. Mirrors the cluster board's rungs. */
export function linkageWord(linkage: number | null, group: AssessmentGroup): string {
  if (group === "quarantined") return "Withheld — linkage to the subject is unproven";
  if (group === "conflict") return "Contradicts the case record";
  if (linkage === null) return "Unresolved — no selector links this to the subject yet";
  if (linkage >= 100) return "The seed itself";
  if (linkage >= 80) return "Likely the same person — strong link";
  if (linkage >= SUPPORTED_LINKAGE_MIN) return "Likely the same person";
  if (linkage >= 40) return "Possibly the same person — needs one more selector";
  return "Weak link — treat as a lead";
}

/**
 * Assess every artifact of a case. Pure: same inputs, same output. Meta rows
 * (`triage_decision`, `cluster_decision`) are skipped, as every counting surface
 * skips them. `reviews` reaches the cluster engine only (a rejected row must not
 * link its neighbours); nothing here reads a verdict into a figure or a word.
 */
export function assessArtifacts(
  artifacts: Artifact[],
  seedValue: string | null,
  reviews?: Record<string, ReviewAdjustment>,
): AssessmentReport {
  const rows = artifacts.filter((a) => !isMetaArtifact(a));
  // Typed text plus an upload stores the attachment block in the seed; no row
  // equals that, so nothing was ever linked to the seed. See seedWithoutAttachments.
  seedValue = seedWithoutAttachments(seedValue);
  const report = buildIdentityClusters(rows, seedValue, reviews);
  const clusterOf = new Map<string, IdentityCluster>();
  for (const c of report.clusters) for (const a of c.artifacts) clusterOf.set(a.id, c);

  const forms = seedForms(seedValue);
  const seedRows = rows.filter((a) => isSeedRow(a, forms));
  const seedCluster = seedRows.map((a) => clusterOf.get(a.id)).find(Boolean) ?? null;

  const items: AgentAssessment[] = rows.map((a) => {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const cluster = clusterOf.get(a.id) ?? null;
    const isSeed = isSeedRow(a, forms);
    const linkedToSeed = Boolean(seedCluster && cluster && cluster.id === seedCluster.id);
    const quarantined = isClusterIneligible(a);
    const conflict = !quarantined && (meta.conflict === true || meta.collision === true || String(a.kind).toLowerCase().endsWith("_conflict") || String(a.kind).toLowerCase() === "contradiction");
    const dc = displayConfidence(a);
    const status = evidenceStatus(a);
    const classes = independentSourceClasses(a);

    // ── Linkage ────────────────────────────────────────────────────────────
    let linkage: number | null = null;
    if (!quarantined) {
      if (isSeed) linkage = 100;
      else if (linkedToSeed && cluster) linkage = Math.max(0, Math.min(100, Math.round(cluster.confidence)));
    }

    // ── Group ──────────────────────────────────────────────────────────────
    const group: AssessmentGroup = quarantined
      ? "quarantined"
      : conflict
        ? "conflict"
        : linkage !== null && linkage >= SUPPORTED_LINKAGE_MIN
          ? "supported"
          : "unresolved";

    // ── Reasons: the engines' own words ────────────────────────────────────
    const reasons: string[] = [];
    if (isSeed) reasons.push("This is the seed the case started from.");
    if (linkedToSeed && cluster && !isSeed) {
      for (const r of cluster.mergeReasons.slice(0, 3)) reasons.push(r);
      if (cluster.artifacts.length > 1) {
        reasons.push(`Shares an identity cluster with ${cluster.artifacts.length - 1} other finding${cluster.artifacts.length === 2 ? "" : "s"}, including the seed.`);
      }
    }
    if (!isSeed && !linkedToSeed && !quarantined && !conflict) {
      if (isNegativeResultArtifact(a)) {
        reasons.push("A lookup that found nothing links nothing: the selector was probed, not observed.");
      } else if (/^(name|person)$/i.test(a.kind)) {
        reasons.push("A name alone is never linkage: a matching name is not evidence of the same person.");
      } else if (cluster && cluster.artifacts.length > 1) {
        reasons.push(`Clusters with ${cluster.artifacts.length - 1} other finding${cluster.artifacts.length === 2 ? "" : "s"}, but none of them is the seed.`);
      } else {
        reasons.push("No shared email, phone, handle or infrastructure joins this to the seed.");
      }
    }
    if (classes.length > 0) {
      reasons.push(`${classes.length} independent source class${classes.length === 1 ? "" : "es"}: ${classes.join(", ")}.`);
    } else {
      reasons.push("No independent corroborating source class yet.");
    }
    if (status.basis) reasons.push(status.basis);

    // ── Opposing evidence ──────────────────────────────────────────────────
    const opposing: string[] = [];
    if (isQuarantined(meta)) {
      const q = quarantineReason(meta);
      if (q) opposing.push(q);
    } else if (quarantined && isCollisionArtifact(a)) {
      opposing.push(readString(meta.reason_not_confirmed) ?? "Flagged as a possible name collision — a namesake, not the subject.");
    }
    for (const s of asStrings(meta.contradictions)) opposing.push(s);
    const note = readString(meta.conflict_note);
    if (note) opposing.push(note);
    if (!quarantined) {
      const rnc = readString(meta.reason_not_confirmed);
      if (rnc && !opposing.includes(rnc)) opposing.push(rnc);
    }
    for (const c of dc.ceilings) {
      if (c.kind === "recorded" && dc.clamped) opposing.push(`Confidence capped at ${c.value}: ${c.reason}.`);
      if (c.kind === "possible_minor") opposing.push(c.reason);
    }
    if (cluster && linkedToSeed) for (const w of cluster.warnings.slice(0, 2)) opposing.push(w);

    const tierWord = readString(meta.confidence_tier)?.toLowerCase() ?? null;
    const tier: ConfidenceTier = tierWord && TIER_WORDS.has(tierWord) ? (tierWord as ConfidenceTier) : tierOf(dc.effective);

    return {
      artifactId: a.id,
      group,
      findingSupport: dc.effective,
      subjectLinkage: linkage,
      verdict: linkageWord(linkage, group),
      reasons: dedupe(reasons),
      opposing: dedupe(opposing),
      clusterId: cluster?.id ?? null,
      clusterSize: cluster?.artifacts.length ?? 0,
      linkedToSeed,
      independentClasses: classes,
      backendClusterId: readString(a.cluster_id) ?? readString(meta.cluster_id),
      tier,
      isSeed,
    };
  });

  const byId: Record<string, AgentAssessment> = {};
  const counts: Record<AssessmentGroup, number> = { supported: 0, unresolved: 0, conflict: 0, quarantined: 0 };
  for (const it of items) {
    byId[it.artifactId] = it;
    counts[it.group] += 1;
  }
  return { items, byId, counts, seedClusterId: seedCluster?.id ?? null, clusters: report.clusters };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs.map((s) => s.trim()).filter(Boolean)));
}

/**
 * What moved between two assessments. `prev` is the earlier `byId` (null on the
 * first assessment). A row that is new, or whose figure was null on either side,
 * reports a null delta for that figure — never a fabricated "+86".
 */
export function diffAssessments(
  prev: Record<string, AgentAssessment> | null,
  next: Record<string, AgentAssessment>,
): Record<string, AssessmentDelta> {
  const out: Record<string, AssessmentDelta> = {};
  for (const [id, n] of Object.entries(next)) {
    const p = prev?.[id] ?? null;
    const num = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
    out[id] = {
      linkage: p ? num(p.subjectLinkage, n.subjectLinkage) : null,
      support: p ? num(p.findingSupport, n.findingSupport) : null,
      from: p?.group ?? null,
      to: n.group,
    };
  }
  return out;
}

/** Signed, rounded, for a delta line: "+12", "−4", or null for nothing to say. */
export function formatDelta(d: number | null): string | null {
  if (d === null || !Number.isFinite(d) || Math.round(d) === 0) return null;
  const r = Math.round(d);
  return r > 0 ? `+${r}` : `−${Math.abs(r)}`;
}
