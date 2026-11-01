// evidence-artifact-link.ts — find the artifact id an evidence row belongs to.
//
// `append_evidence` has always taken `_artifact_id`, and every writer sent null:
// on 2026-10-30 all 17,575 production evidence_log rows had artifact_id NULL. The
// custody link was built and never wired.
//
// This module reads the ids back AFTER the artifact insert, keyed by (kind,
// value) within one thread, newest first so the row this call just wrote wins
// over an older duplicate. It never throws: any fault returns an empty map and
// the caller writes null, which is exactly the old behaviour.
//
// `artifact_id` is not part of the evidence hash chain (append_evidence hashes
// tool, source, url, class, confidence, kind, value, snapshot and metadata), so
// filling it in cannot change a hash or break chain verification.

type Row = { kind?: unknown; value?: unknown };
type IdRow = { id?: unknown; kind?: unknown; value?: unknown };

/** Upper bound on distinct values looked up per call (one record_artifacts batch). */
export const ARTIFACT_LINK_MAX_VALUES = 200;

export function evidenceArtifactKey(kind: unknown, value: unknown): string {
  return `${String(kind ?? "")}\u0000${String(value ?? "")}`;
}

/** The one query shape this module issues; the Supabase client satisfies it. */
type LinkQuery = {
  select(cols: string): LinkQuery;
  eq(col: string, v: string): LinkQuery;
  in(col: string, vs: string[]): LinkQuery;
  order(col: string, o: { ascending: boolean }): LinkQuery;
  limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
};
type Db = { from(table: string): unknown };

export async function lookupArtifactIdsForEvidence(
  supabase: Db,
  threadId: string,
  rows: readonly Row[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const values = [...new Set(rows.map((r) => String(r.value ?? "")).filter(Boolean))]
      .slice(0, ARTIFACT_LINK_MAX_VALUES);
    if (values.length === 0) return out;
    const { data, error } = await (supabase.from("artifacts") as LinkQuery)
      .select("id,kind,value")
      .eq("thread_id", threadId)
      .in("value", values)
      .order("created_at", { ascending: false })
      .limit(values.length * 4);
    if (error || !Array.isArray(data)) return out;
    for (const a of data as IdRow[]) {
      if (typeof a.id !== "string") continue;
      const key = evidenceArtifactKey(a.kind, a.value);
      if (!out.has(key)) out.set(key, a.id);
    }
  } catch (e) {
    console.warn("[record_artifacts] evidence artifact link lookup failed:", (e as Error)?.message ?? e);
  }
  return out;
}
