// analyst-feedback.ts — read analyst artifact_reviews and feed the planner +
// scoring engine. Closes the learning loop (Phase 4): UI writes reviews;
// osint-agent reads them for pivot planning and confidence deltas.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type AnalystReviewState = "confirmed" | "key" | "recheck" | "dismissed";

export interface AnalystReviewArtifact {
  id: string;
  kind: string;
  value: string;
  source: string | null;
  confidence: number | null;
}

export interface AnalystReview {
  artifact_id: string;
  state: AnalystReviewState;
  note: string | null;
  artifact: AnalystReviewArtifact | null;
}

/** Confidence delta applied after cap/relevance/penalties (aligned with scoring_test key +25). */
export const ANALYST_REVIEW_DELTA: Record<AnalystReviewState, number> = {
  confirmed: 20,
  key: 25,
  recheck: -20,
  dismissed: -40,
};

/** Load thread-scoped analyst reviews joined with artifact kind/value/source. */
export async function loadAnalystReviews(
  supabase: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<AnalystReview[]> {
  const { data: reviews, error } = await supabase
    .from("artifact_reviews")
    .select("artifact_id, state, note")
    .eq("thread_id", threadId)
    .eq("user_id", userId);
  if (error) throw error;
  if (!reviews?.length) return [];

  const ids = reviews.map((r) => r.artifact_id as string);
  const { data: artifacts, error: artErr } = await supabase
    .from("artifacts")
    .select("id, kind, value, source, confidence")
    .in("id", ids);
  if (artErr) throw artErr;

  const byId = new Map(
    (artifacts ?? []).map((a) => [
      a.id as string,
      {
        id: a.id as string,
        kind: String(a.kind ?? ""),
        value: String(a.value ?? ""),
        source: (a.source as string | null) ?? null,
        confidence: (a.confidence as number | null) ?? null,
      },
    ]),
  );

  return reviews.map((r) => ({
    artifact_id: r.artifact_id as string,
    state: r.state as AnalystReviewState,
    note: (r.note as string | null) ?? null,
    artifact: byId.get(r.artifact_id as string) ?? null,
  }));
}

/** Review delta for a single artifact id (0 when unreviewed or unknown state). */
export function getReviewDeltaForArtifact(
  artifactId: string,
  reviews: AnalystReview[],
): number {
  const hit = reviews.find((r) => r.artifact_id === artifactId);
  if (!hit) return 0;
  return ANALYST_REVIEW_DELTA[hit.state] ?? 0;
}

function summarizeSource(review: AnalystReview): string | null {
  const src = review.artifact?.source?.trim();
  if (src) return src.split(/[+:,]/)[0]?.trim() || src;
  return null;
}

function clip(s: string, max = 80): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Compact planner prompt block summarizing analyst marks for this thread. */
export function buildFeedbackContext(reviews: AnalystReview[]): string {
  if (!reviews.length) return "";

  const byState: Record<AnalystReviewState, AnalystReview[]> = {
    confirmed: [],
    key: [],
    recheck: [],
    dismissed: [],
  };
  for (const r of reviews) {
    if (r.state in byState) byState[r.state as AnalystReviewState].push(r);
  }

  const lines: string[] = [
    "ANALYST FEEDBACK (honor these — confirmed/key artifacts are trusted; dismissed ones must NOT be re-proposed without new independent corroboration; recheck needs a different source):",
  ];

  const formatRow = (r: AnalystReview) => {
    const art = r.artifact;
    const head = art
      ? `${art.kind}:${clip(art.value)}${art.source ? ` via ${clip(art.source, 40)}` : ""}`
      : `artifact ${r.artifact_id.slice(0, 8)}`;
    return r.note ? `  - ${head} — note: ${clip(r.note, 120)}` : `  - ${head}`;
  };

  if (byState.key.length) {
    lines.push(`Key findings (${byState.key.length}):`);
    for (const r of byState.key.slice(0, 8)) lines.push(formatRow(r));
  }
  if (byState.confirmed.length) {
    lines.push(`Confirmed (${byState.confirmed.length}):`);
    for (const r of byState.confirmed.slice(0, 8)) lines.push(formatRow(r));
  }
  if (byState.recheck.length) {
    lines.push(`Needs recheck (${byState.recheck.length}) — propose VERIFY pivots with a different tool class:`);
    for (const r of byState.recheck.slice(0, 6)) lines.push(formatRow(r));
  }
  if (byState.dismissed.length) {
    lines.push(`Dismissed (${byState.dismissed.length}) — do NOT treat as evidence; avoid repeating the same source+selector unless VERIFY with independent proof:`);
    for (const r of byState.dismissed.slice(0, 6)) lines.push(formatRow(r));
  }

  const sourceScore = new Map<string, { up: number; down: number }>();
  for (const r of reviews) {
    const src = summarizeSource(r);
    if (!src) continue;
    const bucket = sourceScore.get(src) ?? { up: 0, down: 0 };
    if (r.state === "confirmed" || r.state === "key") bucket.up++;
    if (r.state === "dismissed" || r.state === "recheck") bucket.down++;
    sourceScore.set(src, bucket);
  }
  if (sourceScore.size) {
    const hints = [...sourceScore.entries()]
      .map(([src, { up, down }]) => `${src} (+${up}/-${down} analyst marks)`)
      .slice(0, 12);
    lines.push(`Source trust hints from your marks: ${hints.join("; ")}`);
  }

  return `\n\n${lines.join("\n")}`;
}
