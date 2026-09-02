# Analyst decisions → the next investigation (trace and contract)

Dated 2026-09-02, measured on `442ecbc` (base) and fixed in the
`claude/analyst-decisions-propagation-ni2l8d` branch. This is the trace the PR
was built from. Read it as a **measurement**, not a state: re-grep before
trusting any line number.

## The four decisions and what each may change

| Decision | What it is | May change | Must NOT change |
|---|---|---|---|
| **Confirm** (`confirmed`) | an analyst-accepted proposition | model context (do not re-litigate) | confidence, source count, corroboration, `subject_unlinked` quarantine |
| **Key** (`key`) | an investigative priority | model context (priority), pivot ORDER | confidence, source classes, corroboration |
| **Recheck** (`recheck`) | a durable verification task | model context (task), pivot surface (verification card), chat launch **after** commit | confidence |
| **False** (`dismissed`; `wrong` = False + memory lesson) | a rejection | removed from working set, pivots, dispatch, clustering, synthesis, authoritative report sections — by artifact id **and** normalized `kind:value` | its existence: the row, its confidence and its history are preserved |

`metadata.false_positive` is a **legacy** per-artifact flag with the same meaning
as `dismissed`. It is still *read* as a rejection by every frontend consumer
(`isRejectedArtifact` in `src/lib/analyst-decisions.ts`) so old rows keep their
status, but the drawer no longer writes it. The one visible False action is the
review verdict.

## Root cause by consumer (before → after)

| # | Consumer | Before (`442ecbc`) | After |
|---|---|---|---|
| 1 | Review mutation (`src/lib/review.ts`) | `set` returned `void`; reset/delete, `setNote`, `clear` discarded errors and kept optimistic state; `save_agent_memories` RPC result never read (an RPC failure resolves, it does not throw); Recheck buttons fired `void set()` and the chat launch on the same tick | every write returns `ReviewWriteResult`; every path rolls back and toasts on failure; RPC `{error}` checked (`memoryTaught`); `startRecheck` launches only after commit; hook exposes `revision` |
| 2 | Review load (edge `reviews.ts`) | loaded `artifact_id,state` only; resolved rows for **rejected** ids only, so Confirm/Key/Recheck could not be named; `applyReviewsToArtifacts` applied **+20 / +25 / −20 to evidence confidence** | loads `note`; resolves every reviewed row (`reviewedRows`, with quarantine flag); `applyReviewsToArtifacts` tags `review_state` and never touches `confidence` |
| 3 | Orchestrator prompt (`index.ts` ~734) | rejection-only block (`renderAnalystRejectionBlock`) | one structured `## ANALYST DECISIONS` block: confirmed propositions → key priorities → recheck tasks → ANALYST-REJECTED, headed by the rule that no decision changes confidence |
| 4 | `computePivots()` (`src/lib/pivot-engine.ts`) | no review input at all; only `metadata.false_positive` filtered (and only for artifact-origin) | `reviews` input; rejected removed by id + `type:normalizedValue` from both origins; Key adds a rank bonus (confidence untouched); Recheck becomes a "Re-verify finding" task card; confirmed-but-quarantined stays inert |
| 5 | Dispatch — manual (`proximity:run-pivot` → `ChatWindow.sendText`) | no check | `isManualDispatchRefused` guard on the bus; refusal is toasted and logged |
| 5 | Dispatch — model-requested (`cache.ts` `wrapToolsWithCache`) | quarantine guard only | `lib/dispatch-rejection.ts` guard, loaded once per run from `artifact_reviews`, keyed `type:normalizedValue` (kind aliases folded), `force` does not override; fails **open** on a load error with a warning (documented: dispatch is a spend control, the authoritative consumers below fail closed) |
| 6 | Cache write (`index.ts` ~1680) | applied confidence deltas; **never stamped `cache_version`/`origin_thread_id`** — the stamp from `9122327` was lost in the 07-20 rollback, so the client rejected every hit as unversioned (replay was dead while its contract pointed at a field nothing wrote) | delta-free tagging; stamp restored |
| 6 | Cache replay (`checkCachedHitSafety`) | rejected/recheck blocked; **confirmed/key replayed** and the clone landed as an unreviewed row (decision discarded) | any non-new decision on the origin or a clone blocks replay (no review-lineage transfer exists); every non-new write evicts the cache row |
| 7 | Backend clustering (`lib/cluster.ts`) | rejected rows filtered from union-find but their persisted `cluster_id`/`subject_id` (+ `promoted_confidence`/`confidence_tier` in metadata) were never cleared; confidence deltas applied before promotion | `dropRejectedArtifacts` (recorded confidence enters promotion); stale assignments cleared with `cluster_cleared_reason: "analyst_rejected"`; result carries `cleared` |
| 8 | `finding-synthesis-sweep.ts` | **never read `artifact_reviews`**: a rejected row supplied a source class to the corroboration bar and was republished in `supporting_artifact_ids` under a new finding id | loads reviews **fail-closed** (skip thread, count error); drops rejected by id + `kind|value` before selection and contradiction scoping |
| 9 | Report / Evidence Matrix (`src/lib/intel.ts`) | labels honoured reviews, but `buildEvidenceMatrixMarkdown(artifacts)` got no reviews (rejected row exported with its active label) and Network Connections excluded only quarantine/collision | matrix labels through the verdict (row kept, reads FAILED); Network Connections excludes rejected |
| 9 | Recovery stub (`recovery.ts` ~632) | comment said fail-closed, code fell back to the **raw** fetch when reviews were unreadable | `[]` on unavailable |
| 10 | `metadata.false_positive` | a third "false" written by the drawer's "Mark false positive", invisible to the backend review reads | unified: read as rejection everywhere on the frontend; no longer written |
| — | Evidence Board (`ResourcesPanel.tsx`) | counts memo `[items]`, grouped memo without review — stale until an unrelated artifact arrived | both memos depend on `review.revision` |
| — | Confidence wording | Matrix legend "Confirm +20"; `REVIEW_HELP` "+20 / +25 / −20"; `explainConfidence` popover +15/+18/−12/−40 | decision wording only; popover discloses the decision at delta 0 |

## What deliberately did not change

- `adjustedConfidence` in `intel.ts` (a classification score that feeds the
  label ladder and is never displayed), the label ladder, caps, source classes,
  `confidence.ts` on the edge function, `record_finding`.
- Quarantine (`subject_unlinked` / `linkage_confirmed`): Confirm still does not
  release it; PR #529 (the release UI) is untouched.
- Finalize and termination: no work added inside the finalize window; the
  decisions block is built where the rejection block already was.

## Fail-closed vs fail-open, by consumer

| Consumer | On unreadable `artifact_reviews` |
|---|---|
| prompt block | "REVIEW STATE UNAVAILABLE" note (unchanged) |
| salvage, cache write, clustering | skipped (unchanged) |
| synthesis sweep | **skipped, error counted** (new) |
| recovery stub | **no artifacts listed** (fixed) |
| Evidence Record, report authority | withheld (unchanged) |
| model-requested dispatch | open, warning logged (documented) |
| manual dispatch | open (the hook's `availability` is surfaced elsewhere) |

## Pinned by

Edge: `reviews_test.ts`, `reviews_wiring_test.ts`, `rejected_dispatch_test.ts`,
`finding_synthesis_reviews_test.ts`, `cluster_rejected_clear_test.ts`.
Frontend: `review-write-contract.test.ts`, `pivot-engine-decisions.test.ts`,
`analyst-decisions.test.ts`, `report-rejected-exclusion.test.ts`,
`evidence-board-reactivity.test.ts`, `review.test.ts`, `confidence.test.ts`.
