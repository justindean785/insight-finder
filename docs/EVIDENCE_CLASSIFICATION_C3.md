# C-3 — Evidence classification beyond `soft`

Branch: `feat/evidence-classification` (off `main`). **Not deployed** (per brief).

## What shipped
Evidence rows now carry an analyst-facing **grade** derived from the C-1 cluster
tier, instead of every row being flat `soft`.

- **Grade enum** (`lib/evidence_classify.ts`): `verified | probable | weak | contradicted | rejected | unclassified`.
- **Derivation** (single source of truth = C-1 `tierFor`): `Confirmed→verified`,
  `Likely→probable`, `Possible/Weak/Unverified→weak`, contradiction /
  needs_review / `excluded_collision` / `Excluded` tier `→contradicted`.
  Precedence: user verdict > contradiction > tier > promoted_confidence > `unclassified`.
- **Storage**: NEW **non-hashed** `evidence_log.classification_grade` column. The
  hashed `classification` (hard/soft) that feeds the tamper-evident chain is left
  **untouched** — the migration's `append_evidence` hash input is byte-for-byte
  identical to the prior RPC (verified), so the chain of custody is preserved and
  the end-of-cycle reclassification pass can rewrite the grade freely.
- **Append sites**: `cache.ts` auto-path writes `unclassified` (pre-cluster);
  `record_artifact(s)` derive the grade from artifact metadata.
- **Reclassification** (`index.ts`, right after `applyClusteringToThread`): re-grades
  the whole thread off live state each pass and writes only rows whose grade
  changed — so a later-discovered contradiction can DEMOTE an earlier `verified`.
- **Report**: grade tag (`[verified]` …) renders next to the badge in the
  `evidence-export` PDF.

## ⚠️ Deploy ordering (Lovable mirror) — do in THIS order
1. **Apply the migration** `20260709020000_evidence_classification_grade.sql` to
   Supabase `skzqwbyvmwqarfgfvyky` FIRST. If the functions deploy before the
   column/RPC exist, `append_evidence` calls fail (no 12-arg fn) and
   `evidence-export` 500s (missing column) — evidence logging breaks silently.
2. Verify **exactly one** `append_evidence` function exists post-migration (the
   `DROP ... IF EXISTS` targets the 11-arg signature; if prod ever drifted from
   migration history you could end up with both an 11-arg and 12-arg overload →
   PostgREST ambiguity). `SELECT oid::regprocedure FROM pg_proc WHERE proname='append_evidence';`
3. Then sync the functions (`osint-agent`, `evidence-export`) to the mirror.

## Verification done
- `deno test lib/evidence_classify_test.ts` → **14/14** (each tier, contradiction,
  no-meta=unclassified, 0-unclassified pass, M1 name-bridge, M1 conservative merge,
  M2 live-state demotion).
- Full `osint-agent` suite: 609 pass / 2 pre-existing timer-leak failures
  (`crash_resilience`, `gemini_parallel_pairing` — unrelated, fail identically on
  `main`). Type-error count on `index.ts`: 47, identical to `origin/main` baseline.

## Remaining risks / follow-ups
- **Live SQL distribution not produced.** The brief's `SELECT classification, COUNT(*)…`
  needs a real run against a deployed migration; deploy is out of scope here. Run
  it post-deploy: `SELECT classification_grade, COUNT(*) FROM evidence_log WHERE thread_id='<t>' GROUP BY 1;`
  (query the new `classification_grade` column, not `classification`).
- **L1 (under-flag).** A contradicted cluster *member* (capped ≤40 but without its
  own `contradiction`/`status` marker) grades `weak`, not `contradicted` — the
  contradiction shows only on the sibling `contradiction` artifact. Never
  over-verifies. Proper fix = have C-1 `applyClusteringToThread` stamp a
  `contradiction`/`needs_review` marker on capped members; that's a sign-off-gated
  C-1 change, deliberately NOT done here.
- **Multi-cycle churn.** Re-grading the whole thread each completed run is O(rows);
  writes are limited to changed rows. Fine at current scale (≤~250 rows/thread).
- **Existing `soft` rows** left as-is (backfill optional per brief); their
  `classification_grade` is NULL until a run reclassifies their thread.
