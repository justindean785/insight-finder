import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { AssessmentReport } from "@/lib/agent-assessment";
import { effectiveConfidenceOrZero } from "@/lib/display-confidence";

/**
 * Evidence ledger search and sort (Case desk R4, JD's prototype 2026-11-02).
 *
 * Search matches the row's value, kind, source and the pipeline's recorded
 * reasons — never scores. Sort modes mirror the prototype's menu:
 *  - linkage     "Linkage confidence ↓" — the R2 assessment's subject linkage,
 *                unresolved rows last, ties by finding support;
 *  - confidence  "Finding support ↓"    — displayConfidence(a).effective;
 *  - newest      "Newest first";
 *  - name        "Name A–Z";
 *  - strength    "Authority"            — the ledger's authority rank, applied by
 *                the caller because it needs the analyst's verdicts.
 * Every comparator is deterministic (ties fall to the id) so a re-render never
 * reorders rows the analyst is reading.
 */
export type EvidenceSortMode = "linkage" | "confidence" | "strength" | "newest" | "name";

export const EVIDENCE_SORT_LABEL: Record<EvidenceSortMode, string> = {
  linkage: "Linkage confidence",
  confidence: "Finding support",
  strength: "Authority",
  newest: "Newest first",
  name: "Name A–Z",
};

function haystack(a: Artifact): string {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const bits: string[] = [a.value, a.kind, a.source ?? ""];
  for (const k of ["reason_not_confirmed", "subject_unlinked_reason", "conflict_note", "platform", "handle", "queried_selector"]) {
    const v = meta[k];
    if (typeof v === "string") bits.push(v);
  }
  const sources = meta.sources;
  if (Array.isArray(sources)) for (const s of sources) if (typeof s === "string") bits.push(s);
  return bits.join(" \n ").toLowerCase();
}

/** Case-insensitive, every whitespace-separated term must appear. An empty query matches everything. */
export function matchesQuery(a: Artifact, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const h = haystack(a);
  return terms.every((t) => h.includes(t));
}

/** Support figure for sorting: a flagged false positive sinks below every real score. */
export function supportScore(a: Artifact): number {
  const fp = ((a.metadata ?? {}) as Record<string, unknown>).false_positive === true;
  return fp ? -1 : effectiveConfidenceOrZero(a);
}

/** Linkage for sorting: null (unresolved / withheld) sorts after every figure. */
export function linkageScore(a: Artifact, report: AssessmentReport | null): number {
  const l = report?.byId[a.id]?.subjectLinkage;
  return l === null || l === undefined ? -1 : l;
}

/**
 * The comparator for every mode but `strength`, which the ledger builds itself
 * from the authority rank. Returns negative when `a` should come first.
 */
export function compareEvidence(mode: Exclude<EvidenceSortMode, "strength">, report: AssessmentReport | null) {
  return (a: Artifact, b: Artifact): number => {
    let d = 0;
    if (mode === "linkage") {
      d = linkageScore(b, report) - linkageScore(a, report);
      if (d === 0) d = supportScore(b) - supportScore(a);
    } else if (mode === "confidence") {
      d = supportScore(b) - supportScore(a);
    } else if (mode === "newest") {
      d = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    } else {
      d = a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true });
    }
    return d !== 0 ? d : a.id.localeCompare(b.id);
  };
}
