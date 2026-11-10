// replay/attribution-rules.ts — SHADOW-ONLY sandbox for auto-corroboration rules.
//
// Nothing in product code imports this file. It evaluates candidate rules over a
// stored case and scores them against the analyst's own verdicts, so a rule can be
// judged before it is ever allowed to label a live row.
//
//   ruleV1 — the 2026-11-10 overhaul proposal: ">= 2 independent source classes
//            observe the same normalized email/phone/handle, at least one not
//            breach/aggregator". The proposal says neither which counter nor how
//            a row's selector is read, so it is evaluated all four ways:
//              literal  — distinct classes, as the sentence reads;
//              counted  — the repo's own `countIndependentClasses` (drops the
//                         NON_CORROBORATING classes, e.g. social_profile_passive);
//            × strict   — only rows whose whole value is the selector;
//              engine   — selectors read the way clustering reads them today,
//                         including handles and emails mentioned in prose.
//            Its flaw is structural: it corroborates a NODE (the selector exists in
//            two places), not an EDGE (the selector belongs to the subject). Two
//            sources seeing the same handle is exactly what a stranger with the same
//            handle looks like.
//   ruleV2 — the master-plan v2 edge rule: selector X is corroborated for the
//            subject only when X and an attributed ANCHOR are named together in one
//            source record (a declared co-record field), seen by >= 2 independent
//            classes, >= 1 first-party, from TOOL-derived rows only (never a row the
//            model or analyst typed), and X carries no contradiction, exclusion,
//            collision or analyst rejection.
//
// "Key" is an analyst's importance flag, not an attribution verdict: it is reported
// separately and never counted as a keep.
import {
  classifySource,
  countIndependentClasses,
  NON_CORROBORATING_CLASSES,
  OFFICIAL_CLASSES,
  type SourceClass,
} from "../../../functions/osint-agent/source-classification.ts";
import {
  collectKnownHandles,
  foldHandle,
  isExcluded,
  normEmail,
  strongTokens,
} from "../../../functions/osint-agent/lib/cluster.ts";
import { normPhoneE164 } from "../../../functions/osint-agent/lib/selector-normalize.ts";
import { CO_RECORD_FIELDS, CO_RECORD_MAX_TARGETS_PER_CLASS, type CoRecordClass } from "./co-record-fields.ts";
import {
  latestReviewState,
  REJECTING_STATES,
  type Snapshot,
  type SnapshotArtifact,
  toClusterArtifact,
} from "./snapshot.ts";

export const BREACH_OR_AGGREGATOR: ReadonlySet<string> = new Set(["breach", "data_broker", "property_aggregator"]);

/** Classes that speak for the subject's OWN surfaces or an official record. */
export const FIRST_PARTY: ReadonlySet<string> = new Set<string>([
  "social_profile_active",
  "official_profile_match",
  "professional_profile",
  ...OFFICIAL_CLASSES,
]);

/** Rows that are somebody's prose about the evidence, not evidence. */
const WRITTEN_KINDS: ReadonlySet<string> = new Set([
  "finding", "other", "note", "weak_lead", "contradiction", "summary", "analysis", "hypothesis",
]);

const HANDLE_KINDS: ReadonlySet<string> = new Set([
  "username", "handle", "social_profile", "social_account", "social", "github_account", "profile",
]);
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const BARE_HANDLE_RE = /^@?[a-z0-9][a-z0-9._-]{2,39}$/i;
const PHONE_SHAPE_RE = /^\+?[\d\s().-]{7,20}$/;

const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : String(x));
const meta = (a: SnapshotArtifact): Record<string, unknown> => a.metadata ?? {};
const status = (a: SnapshotArtifact): string => str(meta(a).status).trim().toLowerCase();

function handleFromValue(v: string): string | null {
  if (/^https?:\/\//i.test(v)) {
    try {
      const seg = new URL(v).pathname.split("/").filter(Boolean)[0] ?? "";
      const h = seg.replace(/^@/, "");
      return BARE_HANDLE_RE.test(h) ? h : null;
    } catch {
      return null;
    }
  }
  return BARE_HANDLE_RE.test(v) ? v.replace(/^@/, "") : null;
}

/**
 * The selector a row IS — only when its whole value is selector-shaped. A prose
 * row that merely mentions a selector has none: mentioning is not observing.
 */
export function selectorOf(a: SnapshotArtifact): string | null {
  const v = a.value.trim();
  if (!v) return null;
  if (EMAIL_RE.test(v)) return `email:${v.toLowerCase()}`;
  const kind = a.kind.trim().toLowerCase();
  if (kind === "phone") {
    if (!PHONE_SHAPE_RE.test(v)) return null;
    const p = normPhoneE164(v);
    return p ? `phone:${p}` : null;
  }
  if (HANDLE_KINDS.has(kind)) {
    const h = handleFromValue(v);
    if (!h) return null;
    const f = foldHandle(h);
    return f.length >= 3 ? `handle:${f}` : null;
  }
  return null;
}

/** Stored server classification when present (origin-aware), else the label's class. */
export function classesOf(a: SnapshotArtifact): string[] {
  const cat = meta(a).source_category;
  if (Array.isArray(cat) && cat.length && cat.every((c) => typeof c === "string" && c)) {
    return [...new Set(cat as string[])].sort();
  }
  return [classifySource(a.source)];
}

/** "tool" = written by a server extractor from a tool result; anything else was typed
 *  by the model or the analyst (record_artifacts / record_finding / pastes). */
export function originOf(a: SnapshotArtifact): "tool" | "recorded" {
  const m = meta(a);
  return m.auto_recorded === true || typeof m.auto_persist_source === "string" ? "tool" : "recorded";
}

export function isWrittenRow(a: SnapshotArtifact): boolean {
  if (WRITTEN_KINDS.has(a.kind.trim().toLowerCase())) return true;
  if (classesOf(a).includes("ai_summary")) return true;
  return /^minimax_correlate\b/i.test(str(a.source).trim());
}

function coRecordKey(cls: CoRecordClass, raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (cls === "email") return EMAIL_RE.test(t) ? `email:${t.toLowerCase()}` : null;
  if (cls === "phone") {
    const p = PHONE_SHAPE_RE.test(t) ? normPhoneE164(t) : null;
    return p ? `phone:${p}` : null;
  }
  const f = foldHandle(t.replace(/^@/, ""));
  return f.length >= 3 ? `handle:${f}` : null;
}

function strings(x: unknown): string[] {
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((v): v is string => typeof v === "string");
  return [];
}

/** Selectors this row's own record names in a declared co-record field (dump-guarded). */
export function coRecordTargets(a: SnapshotArtifact): string[] {
  const byClass = new Map<CoRecordClass, Set<string>>();
  for (const [field, cls] of Object.entries(CO_RECORD_FIELDS)) {
    for (const raw of strings(meta(a)[field])) {
      const k = coRecordKey(cls, raw);
      if (!k) continue;
      (byClass.get(cls) ?? byClass.set(cls, new Set()).get(cls)!).add(k);
    }
  }
  const out: string[] = [];
  for (const keys of byClass.values()) {
    if (keys.size > CO_RECORD_MAX_TARGETS_PER_CLASS) continue;
    out.push(...keys);
  }
  return out.sort();
}

/** The case's seed as a selector, read from the stored seed text. */
export function seedSelector(s: Snapshot): string | null {
  const raw = str(s.case.seed_value);
  const kind = str(s.case.seed_kind).toLowerCase();
  if (kind === "phone") {
    const p = normPhoneE164(raw);
    return p ? `phone:${p}` : null;
  }
  if (kind === "username") {
    const first = raw.trim().split(/\s+/)[0] ?? "";
    const f = foldHandle(first.replace(/^@/, ""));
    return f.length >= 3 ? `handle:${f}` : null;
  }
  const e = normEmail(raw);
  return e ? `email:${e}` : null;
}

/**
 * Selectors that must never be auto-corroborated: a row about them is contradicted,
 * excluded, a collision or analyst-rejected; or a contradiction artifact names them.
 * Errs on the side of vetoing — a veto fails safe.
 */
export function vetoedSelectors(s: Snapshot): Set<string> {
  const reviews = latestReviewState(s);
  const known = new Set<string>();
  for (const a of s.artifacts) {
    const sel = selectorOf(a);
    if (sel) known.add(sel);
  }
  const out = new Set<string>();
  for (const a of s.artifacts) {
    const sel = selectorOf(a);
    const st = status(a);
    const vetoRow = st === "contradicted" || st === "excluded" || a.kind.trim().toLowerCase() === "excluded_collision" ||
      !!meta(a).collision_value || REJECTING_STATES.has(reviews.get(a.id) ?? "");
    if (sel && vetoRow) out.add(sel);
    // Only an explicit contradiction ARTIFACT vetoes the selectors it names. A finding
    // whose server status is "contradicted" names the seed too, and would veto it.
    if (a.kind.trim().toLowerCase() === "contradiction") {
      for (const chunk of a.value.split(/[\s,()[\]{}|"'<>]+/)) {
        const e = EMAIL_RE.test(chunk) ? `email:${chunk.toLowerCase()}` : null;
        if (e && known.has(e)) out.add(e);
        const h = `handle:${foldHandle(handleFromValue(chunk) ?? chunk)}`;
        if (known.has(h)) out.add(h);
      }
    }
  }
  return out;
}

export interface RuleDecision {
  rule: string;
  artifact_id: string;
  selector: string;
  classes: string[];
}

export interface RuleScore {
  decisions: number;
  rows: number;
  selectors: number;
  keep: number;
  key_only: number;
  reject: number;
  wrong: number;
  unadjudicated: number;
  /** keep / (keep + reject); null when nothing it decided was adjudicated. */
  precision: number | null;
  /** Decisions on a selector the case itself contradicted, excluded or rejected. */
  on_vetoed_selectors: number;
}

function v1Eligible(a: SnapshotArtifact, reviews: Map<string, string>): boolean {
  if (isExcluded(toClusterArtifact(a))) return false;
  if (a.kind.trim().toLowerCase() === "excluded_collision" || meta(a).collision_value) return false;
  if (meta(a).possible_minor === true) return false;
  return !REJECTING_STATES.has(reviews.get(a.id) ?? "");
}

/**
 * How a row's selectors are read:
 *   strict — only a row whose whole value IS a selector (see `selectorOf`);
 *   engine — the way `lib/cluster.ts` reads rows today (`strongTokens`), which also
 *            pulls established handles and the first email out of prose.
 */
export type SelectorReading = "strict" | "engine";

const SELECTOR_TOKEN = /^(?:email|phone|handle):/;

/** The v1 proposal, read literally or with the repo's independence counter. */
export function ruleV1(s: Snapshot, mode: "literal" | "counted", reading: SelectorReading = "strict"): RuleDecision[] {
  const reviews = latestReviewState(s);
  const known = collectKnownHandles(s.artifacts.map(toClusterArtifact));
  const selectorsFor = (a: SnapshotArtifact): string[] => {
    if (reading === "strict") {
      const sel = selectorOf(a);
      return sel ? [sel] : [];
    }
    return strongTokens(toClusterArtifact(a), known).filter((t) => SELECTOR_TOKEN.test(t));
  };
  const groups = new Map<string, SnapshotArtifact[]>();
  for (const a of s.artifacts) {
    if (!v1Eligible(a, reviews)) continue;
    for (const sel of selectorsFor(a)) (groups.get(sel) ?? groups.set(sel, []).get(sel)!).push(a);
  }
  const out: RuleDecision[] = [];
  for (const [sel, rows] of [...groups].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const classes = [...new Set(rows.flatMap(classesOf))].sort();
    const notWeak = mode === "literal"
      ? classes.some((c) => !BREACH_OR_AGGREGATOR.has(c))
      : classes.some((c) => !BREACH_OR_AGGREGATOR.has(c) && !NON_CORROBORATING_CLASSES.has(c as SourceClass));
    const enough = mode === "literal"
      ? classes.length >= 2
      : countIndependentClasses(classes as SourceClass[]) >= 2;
    if (!enough || !notWeak) continue;
    for (const a of rows) out.push({ rule: `v1_${mode}_${reading}`, artifact_id: a.id, selector: sel, classes });
  }
  return out;
}

export interface RuleV2Report {
  decisions: RuleDecision[];
  anchors: number;
  candidates: number;
  vetoed: number;
  /** Would qualify if model/analyst-typed rows counted — evidence the structure is missing, not that the rule is wrong. */
  blocked_by_origin: number;
  insufficient_corroboration: number;
  /** Non-anchor selectors with no declared co-record edge to anything. */
  selectors_without_edges: number;
}

/** The master-plan v2 edge rule. */
export function ruleV2(s: Snapshot): RuleV2Report {
  const reviews = latestReviewState(s);
  const anchors = new Set<string>();
  const seed = seedSelector(s);
  if (seed) anchors.add(seed);
  for (const a of s.artifacts) {
    const sel = selectorOf(a);
    if (sel && reviews.get(a.id) === "confirmed") anchors.add(sel);
  }
  const vetoed = vetoedSelectors(s);

  type Obs = { id: string; classes: string[]; origin: "tool" | "recorded"; written: boolean };
  const obsFor = new Map<string, Obs[]>();
  const withEdges = new Set<string>();
  const allSelectors = new Set<string>();
  for (const a of s.artifacts) {
    const own = selectorOf(a);
    if (own) allSelectors.add(own);
    if (!own) continue;
    const ob: Obs = { id: a.id, classes: classesOf(a), origin: originOf(a), written: isWrittenRow(a) };
    for (const t of coRecordTargets(a)) {
      if (t === own) continue;
      withEdges.add(own);
      withEdges.add(t);
      const [x, anchor] = anchors.has(own) && !anchors.has(t) ? [t, own] : anchors.has(t) && !anchors.has(own) ? [own, t] : [null, null];
      if (!x || !anchor) continue;
      (obsFor.get(x) ?? obsFor.set(x, []).get(x)!).push(ob);
    }
  }

  const qualifies = (obs: Obs[]): boolean => {
    const classes = [...new Set(obs.flatMap((o) => o.classes))];
    return countIndependentClasses(classes as SourceClass[]) >= 2 && classes.some((c) => FIRST_PARTY.has(c));
  };

  const report: RuleV2Report = {
    decisions: [],
    anchors: anchors.size,
    candidates: obsFor.size,
    vetoed: 0,
    blocked_by_origin: 0,
    insufficient_corroboration: 0,
    selectors_without_edges: [...allSelectors].filter((x) => !anchors.has(x) && !withEdges.has(x)).length,
  };
  for (const [x, obs] of [...obsFor].sort(([p], [q]) => (p < q ? -1 : 1))) {
    if (vetoed.has(x)) { report.vetoed++; continue; }
    const strict = obs.filter((o) => o.origin === "tool" && !o.written);
    if (qualifies(strict)) {
      const classes = [...new Set(strict.flatMap((o) => o.classes))].sort();
      for (const a of s.artifacts) {
        if (selectorOf(a) === x && v1Eligible(a, reviews)) {
          report.decisions.push({ rule: "v2_edge", artifact_id: a.id, selector: x, classes });
        }
      }
    } else if (qualifies(obs.filter((o) => !o.written))) {
      report.blocked_by_origin++;
    } else {
      report.insufficient_corroboration++;
    }
  }
  return report;
}

/** Score a rule's decisions against the analyst's latest verdict on each decided row. */
export function scoreDecisions(s: Snapshot, decisions: RuleDecision[]): RuleScore {
  const reviews = latestReviewState(s);
  const vetoed = vetoedSelectors(s);
  const rows = new Set(decisions.map((d) => d.artifact_id));
  const score: RuleScore = {
    decisions: decisions.length,
    rows: rows.size,
    selectors: new Set(decisions.map((d) => d.selector)).size,
    keep: 0, key_only: 0, reject: 0, wrong: 0, unadjudicated: 0,
    precision: null,
    on_vetoed_selectors: decisions.filter((d) => vetoed.has(d.selector)).length,
  };
  for (const id of [...rows].sort()) {
    const st = reviews.get(id) ?? "";
    if (st === "confirmed") score.keep++;
    else if (st === "key") score.key_only++;
    else if (REJECTING_STATES.has(st)) {
      score.reject++;
      if (st === "wrong") score.wrong++;
    } else score.unadjudicated++;
  }
  const judged = score.keep + score.reject;
  score.precision = judged ? Math.round((score.keep / judged) * 1000) / 1000 : null;
  return score;
}
