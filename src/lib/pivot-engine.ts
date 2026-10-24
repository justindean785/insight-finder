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
import { entityKey, humanizeLeadReason, normalizeTarget } from "@/lib/next-step-cards";
import { isInert, quarantineSets } from "@/lib/quarantine";
import { buildDecisionSets, recheckPrompt } from "@/lib/analyst-decisions";
// The ENGINE's authority gate, imported rather than re-derived. `pivot-engine`
// is a leaf (only ChatWindow, PivotsTab and PivotCard import it), so the edge
// pivot-engine -> report-hygiene is safe; the reverse (quarantine -> report-hygiene)
// would be a cycle, which is why the predicate is injected below rather than
// imported inside `quarantine.ts`.
import { isClusterIneligible } from "@/lib/report-hygiene";
import { toDisplayPivots, type RecommendedPivot } from "@/lib/recommended-pivots";

export type PivotPriority = "high" | "medium" | "low";

/** The analyst decision, if any, that shaped this card. `key` raised its rank;
 *  `recheck` turned it into a verification task; `confirmed` is carried for
 *  display only. Rejected identities never reach this list at all. */
export type PivotDecision = "key" | "recheck" | "confirmed";

/** A ranked, display-ready pivot merged from the report + artifact generators. */
export type DisplayPivot = Pivot & {
  priority: PivotPriority;
  actionLabel: string;
  reason: string;
  detail: string;
  prompt: string;
  score: number;
  decision?: PivotDecision;
  /**
   * A report-recommended handle read from bare prose that the case does not
   * know: a candidate, not a selector. It validates as "choose a target" and
   * cannot be run.
   */
  unconfirmedTarget?: boolean;
};

export type ComputePivotsInput = {
  artifacts: Artifact[];
  seedValue: string | null;
  reportPivots: RecommendedPivot[];
  /** Normalized-target keys the user explicitly skipped (proximity:pivot-skip). */
  skipSet: Set<string>;
  /**
   * Normalized targets tools have ALREADY been run against (from
   * tool_usage_log). Any pivot on one of these is demoted to "searched" so the
   * chat never re-suggests an already-investigated lead. Optional — defaults to
   * empty, so existing callers/tests behave unchanged.
   */
  queriedSet?: Set<string>;
  /**
   * Analyst decisions by artifact id (from `useReviewStates`). Optional so
   * existing callers/tests behave unchanged; when present:
   *   - a rejected identity (dismissed / wrong / legacy `false_positive`) is
   *     removed by artifact id AND by `type:normalizedValue`, from BOTH origins;
   *   - a `key` identity ranks above comparable ordinary ones (priority only —
   *     its confidence is untouched);
   *   - a `recheck` identity becomes a verification task card.
   */
  reviews?: Record<string, string | null | undefined>;
};

// ---- Ranking weights ---------------------------------------------------
// Heuristic and unit-pinned in src/test/pivot-engine.test.ts. A "new" pivot
// must always outrank any "searched" one, so statusRank dominates every other
// term combined. Adjust with care.
const STATUS_RANK_NEW = 1000;
const TIER_SCORE: Record<PivotPriority, number> = { high: 300, medium: 200, low: 100 };
// An analyst's Key mark. Larger than any tier gap + confidence + yield + recency
// combined (300 + 60 + 40 + 40 = 440) so a Key lead outranks EVERY comparable
// ordinary lead of the same status, but smaller than STATUS_RANK_NEW so a Key
// lead that has already been searched still sits below an unsearched one. This
// is PRIORITY. It never touches `confidence`, which is copied through untouched.
const KEY_DECISION_BONUS = 500;
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
    // Same wording as a report recommendation (recommended-pivots.ts): the run
    // is a lookup, and no lookup proves who owns an address.
    case "email": return "Investigate email";
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
  const queriedSet = input.queriedSet ?? new Set<string>();

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
  // A handle recorded in another artifact's metadata (an email row carrying `metadata.handle`) is observed, so it
  // grounds an unmarked report handle. Deliberately NOT in existingValueSet: that set also marks pivots "searched".
  const metaHandleSet = new Set<string>();
  for (const a of artifacts) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    for (const key of ["handle", "username"]) {
      const v = meta[key];
      if (typeof v === "string" && v.trim()) metaHandleSet.add(normalizeTarget(v));
    }
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

  // --- analyst decisions -------------------------------------------------
  // Keyed in the SAME `type:normalizedValue` keyspace as the quarantine sets
  // and canonicalKey below, so a rejected `username` cannot be revived by (or
  // revive) a same-text `name`, and a re-record of the same selector under a
  // new artifact id is still out. Rejection is checked by id as well.
  const decisions = buildDecisionSets(
    artifacts,
    input.reviews,
    normalizeTarget,
    (kind) => KIND_TO_PIVOT[kind.toLowerCase()] ?? null,
  );

  // --- collision quarantine (`subject_unlinked`) --------------------------
  // The backend stamps every row harvested from a name-only query, and #434 bound
  // that flag across the edge function (graph nodes, recovery salvage, collision
  // corroboration). It stopped at the network boundary: the flag reached the
  // client as pure DESCRIPTION, read only by the report's collision section, so
  // the disputed selectors kept surfacing here as ordinary "Run this pivot" cards
  // — the one-click path onto a same-name stranger.
  //
  // Keyed by CANONICAL PIVOT IDENTITY (type + normalized value), not by value
  // alone: normalizeTarget collapses punctuation to spaces, so a `username`
  // "jordan.vale" and a `name` "Jordan Vale" share a normalized value, and a
  // value-only key let the ordinary name restore authority to the quarantined
  // handle. Non-pivotable kinds are excluded outright — they can never be the
  // subject of this decision, so they may neither quarantine nor restore.
  const quarantine = quarantineSets(
    artifacts,
    normalizeTarget,
    (kind) => KIND_TO_PIVOT[kind.toLowerCase()] ?? null,
    // ONE boundary. Dispatching a pivot is an authority decision, so it is gated
    // on the same predicate every other authority surface uses — never a copy of
    // it, and never a narrower subset. `isClusterIneligible` covers BOTH the
    // active quarantine (`subject_unlinked` with no `linkage_confirmed` release)
    // and the collision family, which is what this gate used to miss.
    isClusterIneligible,
  );

  // Findings already carry #185 filtering + status via buildPivots.
  const findings = buildPivots(artifacts, seedValue);
  const findingByKey = new Map<string, Pivot>();
  for (const f of findings) {
    const k = canonicalKey(f);
    if (!findingByKey.has(k)) findingByKey.set(k, f);
  }

  const recommended = toDisplayPivots(reportPivots);
  const isKnownSelector = (value: string): boolean => {
    const k = normalizeTarget(value);
    const ek = entityKey(value);
    return k === seedKey || metaHandleSet.has(k) || metaHandleSet.has(ek) || existingValueSet.has(k) || existingValueSet.has(ek) ||
      parentSet.has(k) || parentSet.has(ek) || queriedSet.has(k) || queriedSet.has(ek);
  };

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
    const detail: RecommendedDisplay & { unconfirmedTarget?: boolean } = {
      priority: meta.priority,
      actionLabel: meta.actionLabel,
      reason: meta.reason,
      detail: meta.detail,
      prompt: meta.prompt,
      // Grounded by the case itself: a recorded artifact, the seed, a parent
      // pointer or a tool-log selector. Anything else stays a candidate.
      ...(meta.ungrounded && !finding && !isKnownSelector(rec.value) ? { unconfirmedTarget: true } : {}),
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
    // ANALYST-REJECTED identity — never a suggested pivot, from either origin.
    // By canonical identity (so a report-recommended value the model retyped is
    // caught too) and by the source row's id (the direct expression of the
    // verdict). The row itself stays on the Evidence board; this removes the
    // ACTION, not the evidence.
    const ck = canonicalKey(c);
    if (decisions.rejectedKeys.has(ck) || decisions.rejectedIds.has(c.sourceArtifactId)) continue;
    // Quarantined identity — inert, never actionable. Applied to BOTH origins on
    // purpose: the metadata guard further down only inspects finding-origin
    // candidates, so a quarantined value the model wrote into the report's
    // "Recommended pivots" would otherwise walk straight past it. Keyed with
    // canonicalKey so it asks the same question the quarantine sets answered —
    // this candidate's TYPE and value, not any row that merely normalizes alike.
    // The row itself is untouched and still renders on the Evidence board and in
    // the report's collision section — this removes the ACTION, not the evidence.
    // A CONFIRMED decision does not clear this: confirmation answers "is this
    // value real?", never "is it this subject's?". Only `linkage_confirmed`
    // releases quarantine, and that is what `isClusterIneligible` consults.
    if (isInert(ck, quarantine)) continue;
    // Defensive: report recommendations for a value that later resolved to an
    // infra domain artifact should still never surface (buildPivots drops them,
    // extractRecommendedPivots drops them; this backstops any survivor).
    if ((c.type === "domain" || c.type === "url") && isInfraDomain(c.value)) continue;
    // Weak or path-bearing hosts are noise, not actionable subject identifiers
    // (carried over verbatim from the former ChatWindow fallback, #185
    // ChatWindow.tsx:1793-1794): a sub-40-confidence or path-bearing domain/url
    // was previously suppressed and must stay suppressed here.
    if (
      (c.type === "domain" || c.type === "url") &&
      (clamp(c.confidence ?? 0, 0, 100) < 40 || c.value.includes("/"))
    ) continue;
    // Safety guards carried over from the former ChatWindow artifact-fallback so
    // sensitive leads never surface: never pivot on a secret-bearing value, and
    // drop finding-origin candidates flagged as a collision or possible-minor.
    if (SECRET_VALUE_RE.test(c.value)) continue;
    // DELIBERATELY NOT `isClusterIneligible` HERE — see the note below.
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
    // WHY THE AUTHORITY GATE IS NOT REPEATED IN THAT BLOCK.
    //
    // It looks like the obvious place to also apply `isClusterIneligible`, and
    // doing so is wrong: this guard keys on ONE source row, so it blocks
    // unconditionally, while the authority boundary is per-ROW and restorable.
    // `isInert` above resolves a selector to inert only while EVERY row carrying
    // it is denied; a value that arrived once on the collision axis and once from
    // a provider that matched on the subject's own email stays pivotable, because
    // the second observation is genuinely linked.
    //
    // Adding the predicate here overrode that and cost three green tests in
    // `quarantine-pivot-boundary.test.ts` ("keeps a selector that ALSO has
    // independent, subject-linked evidence", "release is per-row", "restoration
    // requires the SAME pivot type") — `buildPivots` names the quarantined row as
    // the candidate's source, so the merged, legitimately-restored pivot was
    // dropped. Over-blocking is its own integrity failure, just a quieter one.
    //
    // The enumerated flags above are left exactly as they were: `possible_minor`
    // and `minor_warning` are a SAFETY ceiling that must never be restorable by
    // another row, and the two collision entries are pre-existing behaviour that
    // `isInert` now covers properly at the selector level.

    let status: Pivot["status"] = c.status;
    // A tool already run against this exact target is the strongest "already
    // investigated" signal we have (artifacts carry no parent lineage), so it
    // overrides the generator's optimistic "new" for both origins.
    // Compare on the ENTITY as well as the literal target. A persisted `name`
    // artifact is frequently a label — "hawkcapo - YouTube channel" — while the
    // tool log holds the bare selector "hawkcapo", so the literal comparison can
    // never match and the lead is re-offered forever. See `entityKey`.
    const ek = entityKey(c.value);
    if (parentSet.has(k) || queriedSet.has(k) || parentSet.has(ek) || queriedSet.has(ek)) status = "searched";
    else if (c.origin === "report" && (existingValueSet.has(k) || existingValueSet.has(ek))) status = "searched";

    // --- analyst decisions shape the CARD, never the evidence -----------
    let decision: DisplayPivot["decision"];
    let priority = c.priority;
    let actionLabel = c.actionLabel;
    let prompt = c.prompt;
    let reason = c.reason;
    let detail = c.detail;
    let keyBonus = 0;
    if (decisions.recheckKeys.has(ck)) {
      // A recheck is a VERIFICATION TASK: it stays actionable even if the
      // selector was already searched (the analyst asked for a fresh pass),
      // and it dispatches the scoped re-verification prompt rather than the
      // generic pivot prompt.
      decision = "recheck";
      status = "new";
      priority = "high";
      actionLabel = "Re-verify finding";
      reason = "Analyst asked for another look — independent re-verification requested";
      detail = `${c.value} · ${reason}`;
      prompt = recheckPrompt(c.value, c.type);
    } else if (decisions.keyKeys.has(ck)) {
      decision = "key";
      priority = "high";
      keyBonus = KEY_DECISION_BONUS;
    } else if (decisions.confirmedKeys.has(ck)) {
      decision = "confirmed";
    }

    // READ ONLY: the artifact's own confidence, untouched by any decision.
    const conf = clamp(c.confidence ?? 0, 0, 100);
    const recency = (newestOrder.get(c.sourceArtifactId) ?? 0) / denom;
    const score =
      (status === "new" ? STATUS_RANK_NEW : 0) +
      keyBonus +
      TIER_SCORE[priority] +
      conf * CONF_WEIGHT +
      TYPE_YIELD[c.type] * YIELD_WEIGHT +
      recency * RECENCY_WEIGHT;

    // Strip the internal origin tag from the public shape.
    const { origin: _origin, ...rest } = c;
    void _origin;
    out.push({
      ...rest, priority, actionLabel, reason, detail, prompt, status, score,
      ...(decision ? { decision } : {}),
    });
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
