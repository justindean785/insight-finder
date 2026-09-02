# Decision log — 2026-09-02 — analyst decisions propagation (#534)

Recorded here because the Unabyss MCP decision store was not connected in this
session. Each entry follows the decision-log shape: decision, reason,
alternatives, revisit trigger.

**[Decision] Analyst decisions are authority, priority and workflow state — never
evidence confidence.** — 2026-09-02. We decided that Confirm, Key, Recheck and
False change what the agent may assert, prioritise, re-verify or use, and never
move a confidence number, add a source class or manufacture corroboration. The
main reason was that the +20 / +25 / −20 deltas made a human click behave like a
second source, which contradicts the engine's own independence rules
(`countIndependentClasses`, caps). We considered keeping a bounded boost with a
ceiling (the 2026-07-27 design) but ruled it out because any delta is
indistinguishable from evidence downstream. We'll revisit if analysts report that
confirmed rows sort below unconfirmed ones in a way that priority ranking does
not solve — the fix then is ordering, not the number.

**[Decision] Merge #534 and ship the backend through the Lovable recipe
immediately.** — 2026-09-02. We decided to merge (squash, `7cd74b5`) and run
the full recipe (stamp → surgical mirror sync → Lovable deploy → verify `/health`
→ record) in the same session rather than park it as a draft. The main reason
was CLAUDE.md's standing diagnosis that the bottleneck is the merge: a green,
reviewed draft ships nothing. We considered leaving it in draft for a human pass
first but ruled it out because CI, typecheck, lint, build and both suites were
green and the two judgment calls are documented for reversal. We'll revisit if
`analyst_decisions_applied` telemetry never shows non-zero counts on live runs.

**[Decision] Keep the `cache_version: 2` / `origin_thread_id` stamp restore.** —
2026-09-02. We decided to restore the stamp that `9122327` introduced and the
07-20 rollback lost, which re-enables investigation_cache replay for threads
with NO recorded analyst decision. The main reason was that the client contract
(`checkCachedHitSafety`) documented and depended on the stamp, and every cache
row had been silently evicted on read for six weeks. We considered leaving
replay dead but ruled it out because the read-time safety check now blocks any
decided entry, so replay cannot discard a decision. We'll revisit if a replayed
narrative is reported stale in a way the origin thread's decisions should have
caught — that would mean a clone-review lookup gap.

**[Decision] The model-requested dispatch guard for rejected selectors FAILS
OPEN on a review-load error.** — 2026-09-02. We decided that
`wrapToolsWithCache` refuses rejected selectors when `artifact_reviews` reads,
and lets calls through with a `[rejected-dispatch]` warning when it does not.
The main reason was that dispatch is a spend/steering control, not an
authorization control, and refusing every tool call on a transient read would
kill the run outright; every authoritative consumer (prompt block, salvage,
cache, clustering, synthesis, recovery) fails closed on the same load. We
considered fail-closed here too but ruled it out for that reason, matching the
quarantine guard's precedent. We'll revisit if the warning appears in production
logs more than occasionally — then the read itself is the problem.

**[Decision] PR #529 (linkage release UI) stays parked and untouched.** —
2026-09-02. We decided not to modify, merge, rebase or close #529 while shipping
#534. The main reason was scope: #534 makes Confirm explicitly NOT release
`subject_unlinked` quarantine, so #529 is now the only path out and deserves its
own review on top of the merged base. We considered folding it in but ruled it
out because the operator instructed it be kept separate. We'll revisit once #534
is verified live: #529 is the natural next merge.

**[Decision] `metadata.false_positive` is read-only legacy; the review verdict is
the one False contract.** — 2026-09-02. We decided to stop writing the flag
(the drawer toggle is removed) while still reading it as a rejection on every
frontend consumer. The main reason was that it was a third "false" signal the
backend review reads never saw. We considered migrating the flag into
`artifact_reviews` rows but ruled it out as a data migration outside this PR.
We'll revisit if legacy rows need the backend to honour the flag too.
