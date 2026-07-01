/**
 * Single source of truth for the "Next steps" / pivot surfaces.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pivots used to be computed by three uncoordinated generators (report-markdown
 * parse, artifact-derived findings, and an inline chat fallback), each with its
 * own dedupe key and none of them filtered against what had already been run.
 * Worse, the report parse was persisted to localStorage and never recomputed, so
 * the cards froze for the whole investigation.
 *
 * `computePivots` composes the two EXISTING pure generators — `buildPivots`
 * (artifact-driven) and `extractRecommendedPivots` → `toDisplayPivots`
 * (report-driven) — over LIVE state on every call. It never re-implements the
 * #185 infra-domain / seed / false-positive filtering: those live inside
 * `buildPivots` and `extractRecommendedPivots`, so delegating to them keeps that
 * behavior correct by construction.
 *
 * Everything here READS artifact confidence/metadata; it never mutates evidence
 * or re-tunes confidence math.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  buildPivots,
  isInfraDomain,
  KIND_TO_PIVOT,
  type Pivot,
  type PivotType,
} from "@/lib/intel";
import { humanizeLeadReason, normalizeTarget } from "@/lib/next-step-cards";
import { toDisplayPivots, type RecommendedPivot } from "@/lib/recommended-pivots";

export type PivotPriority = "high" | "medium" | "low";

/** A ranked, display-ready pivot merged from the report + artifact generators. */
export type DisplayPivot = Pivot & {
  priority: PivotPriority;
  actionLabel: string;
  reason: string;
  detail: string;
  prompt: string;
  score: number;
};

export type ComputePivotsInput = {
  artifacts: Artifact[];
  seedValue: string | null;
  reportPivots: RecommendedPivot[];
  /** Normalized-target keys the user explicitly skipped (proximity:pivot-skip). */
  skipSet: Set<string>;
};

// ---- Ranking weights ---------------------------------------------------
// Heuristic and unit-pinned in src/test/pivot-engine.test.ts. A "new" pivot
// must always outrank any "searched" one, so statusRank dominates every other
// term combined. Adjust with care.
const STATUS_RANK_NEW = 1000;
const TIER_SCORE: Record<PivotPriority, number> = { high: 300, medium: 200, low: 100 };
const CONF_WEIGHT = 0.6; // source-artifact confidence (READ only, 0..100)
const YIELD_WEIGHT = 0.5; // expected linkage fan-out per type
const RECENCY_WEIGHT = 40; // favor the newest discoveries so the list moves
// Expected linkage fan-out: emails/usernames pivot widest; infra-ish
// domains/urls narrowest.
const TYPE_YIELD: Record<PivotType, number> = {
  email: 80,
  username: 70,
  phone: 60,
  wallet: 55,
  name: 50,
  ip: 45,
  domain: 30,
  url: 25,
};

// A value that carries a credential/secret must never become a pivot chip.
const SECRET_VALUE_RE = /\b(password|hash|secret|token|cookie|session|credential)\b/i;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Canonical dedupe key: type + normalized target collapses spacing/case/apostrophe variants. */
export function canonicalKey(p: Pick<Pivot, "type" | "value">): string {
  return `${p.type}:${normalizeTarget(p.value)}`;
}

type Candidate = DisplayPivot & { origin: "report" | "finding" };

/** Priority for an artifact-derived finding, matching the former ChatWindow fallback. */
function priorityForFinding(type: PivotType, confidence: number): PivotPriority {
  if (type === "domain" || type === "url") return confidence >= 75 ? "medium" : "low";
  return confidence >= 75 ? "high" : confidence >= 50 ? "medium" : "low";
}

/** Action headline for an artifact-derived finding, matching the former ChatWindow fallback. */
function actionLabelForFinding(type: PivotType): string {
  switch (type) {
    case "email": return "Verify email ownership";
    case "phone": return "Check phone association";
    case "domain":
    case "url": return "Review domain footprint";
    case "ip": return "Check IP attribution";
    case "username": return "Verify username linkage";
    default: return "Review lead";
  }
}

function findingDisplay(p: Pivot): Omit<DisplayPivot, "score"> {
  const confidence = clamp(p.confidence ?? 0, 0, 100);
  const priority = priorityForFinding(p.type, confidence);
  const actionLabel = actionLabelForFinding(p.type);
  const reason = humanizeLeadReason(p.why || p.fanout || "Artifact-derived lead");
  const detail = reason.toLowerCase().includes(p.value.toLowerCase())
    ? reason
    : `${p.value} · ${reason}`;
  const prompt = `Run this pivot.\n\nAction: ${actionLabel}\nTarget: ${p.value}\nType: ${p.type}\nReason: ${reason}\n\nUse authorized public-source methods only. Return corroborating sources and how this changes the case.`;
  return { ...p, priority, actionLabel, reason, detail, prompt };
}

/**
 * Compute the live, ranked pivot list from current state. Pure — no I/O, no
 * localStorage; both the chat rail and the Pivots tab call this so they never
 * disagree.
 */
export function computePivots(input: ComputePivotsInput): DisplayPivot[] {
  const { artifacts, seedValue, reportPivots, skipSet } = input;

  // --- already-run signal sets (all keyed with normalizeTarget) -----------
  const seedKey = normalizeTarget(seedValue ?? "");
  const parentSet = new Set<string>();
  const existingValueSet = new Set<string>();
  for (const a of artifacts) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim();
    if (parent) parentSet.add(normalizeTarget(parent));
    if (KIND_TO_PIVOT[a.kind.toLowerCase()]) existingValueSet.add(normalizeTarget(a.value));
  }

  // Newest-first recency index: later created_at ⇒ larger index ⇒ higher score.
  const ordered = [...artifacts].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  );
  const newestOrder = new Map<string, number>();
  ordered.forEach((a, i) => newestOrder.set(a.id, i));
  const denom = Math.max(1, ordered.length - 1);

  // Backfill: a live artifact whose value matches a report pivot lets us show a
  // real confidence instead of the recommendation's synthetic 0.
  const confByKey = new Map<string, number>();
  for (const a of artifacts) {
    const pType = KIND_TO_PIVOT[a.kind.toLowerCase()];
    if (!pType) continue;
    const key = `${pType}:${normalizeTarget(a.value)}`;
    if (!confByKey.has(key)) confByKey.set(key, clamp(a.confidence ?? 0, 0, 100));
  }

  const artifactById = new Map(artifacts.map((a) => [a.id, a]));

  // Findings already carry #185 filtering + status via buildPivots.
  const findings = buildPivots(artifacts, seedValue);
  const findingByKey = new Map<string, Pivot>();
  for (const f of findings) {
    const k = canonicalKey(f);
    if (!findingByKey.has(k)) findingByKey.set(k, f);
  }

  const recommended = toDisplayPivots(reportPivots);

  const candidates: Candidate[] = [];
  const consumed = new Set<string>();

  // 1) Report recommendations lead. Merge with a matching finding when one
  //    exists (finding brings the real status/source/confidence; the
  //    recommendation brings the richer action/reason/priority copy).
  recommended.forEach((rec, i) => {
    const meta = reportPivots[i];
    if (!meta) return;
    const key = canonicalKey(rec);
    if (consumed.has(key)) return; // an earlier recommendation already covered this target
    const finding = findingByKey.get(key);
    const detail: RecommendedDisplay = {
      priority: meta.priority,
      actionLabel: meta.actionLabel,
      reason: meta.reason,
      detail: meta.detail,
      prompt: meta.prompt,
    };
    if (finding) {
      consumed.add(key);
      candidates.push({ ...finding, ...detail, origin: "finding", score: 0 });
    } else {
      consumed.add(key);
      const backfilled = confByKey.get(key) ?? rec.confidence;
      candidates.push({ ...rec, confidence: backfilled, ...detail, origin: "report", score: 0 });
    }
  });

  // 2) Remaining artifact-derived findings fill in behind the recommendations.
  for (const f of findings) {
    const key = canonicalKey(f);
    if (consumed.has(key)) continue;
    consumed.add(key);
    candidates.push({ ...findingDisplay(f), origin: "finding", score: 0 });
  }

  // 3) Resolve live status + drop hard-hidden candidates, then score.
  const out: DisplayPivot[] = [];
  for (const c of candidates) {
    const k = normalizeTarget(c.value);
    if (skipSet.has(k) || (seedKey && k === seedKey)) continue; // hard-hide
    // Defensive: report recommendations for a value that later resolved to an
    // infra domain artifact should still never surface (buildPivots drops them,
    // extractRecommendedPivots drops them; this backstops any survivor).
    if ((c.type === "domain" || c.type === "url") && isInfraDomain(c.value)) continue;
    // Safety guards carried over from the former ChatWindow artifact-fallback so
    // sensitive leads never surface: never pivot on a secret-bearing value, and
    // drop finding-origin candidates flagged as a collision or possible-minor.
    if (SECRET_VALUE_RE.test(c.value)) continue;
    if (c.origin === "finding") {
      const meta = (artifactById.get(c.sourceArtifactId)?.metadata ?? {}) as Record<string, unknown>;
      if (
        meta.collision === true ||
        meta.excluded_collision === true ||
        meta.possible_minor === true ||
        meta.minor_warning === true ||
        meta.auto_pivot_blocked === true
      ) continue;
    }

    let status: Pivot["status"] = c.status;
    if (parentSet.has(k)) status = "searched";
    else if (c.origin === "report" && existingValueSet.has(k)) status = "searched";

    const conf = clamp(c.confidence ?? 0, 0, 100);
    const recency = (newestOrder.get(c.sourceArtifactId) ?? 0) / denom;
    const score =
      (status === "new" ? STATUS_RANK_NEW : 0) +
      TIER_SCORE[c.priority] +
      conf * CONF_WEIGHT +
      TYPE_YIELD[c.type] * YIELD_WEIGHT +
      recency * RECENCY_WEIGHT;

    // Strip the internal origin tag from the public shape.
    const { origin: _origin, ...rest } = c;
    void _origin;
    out.push({ ...rest, status, score });
  }

  // Stable sort by score desc: equal scores keep source order (recommendations
  // before findings), which JS's stable Array.prototype.sort preserves.
  return out.map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.score - a.p.score || a.i - b.i)
    .map(({ p }) => p);
}

type RecommendedDisplay = Pick<
  DisplayPivot,
  "priority" | "actionLabel" | "reason" | "detail" | "prompt"
>;
