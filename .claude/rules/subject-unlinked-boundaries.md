---
paths:
  - "supabase/**"
  - "src/lib/**"
---

<!-- Loads when editing backend or src/lib. Moved verbatim from CLAUDE.md lines 191-311 on 2026-11-10. -->

## ✅ The `subject_unlinked` boundaries — ALL THREE CLOSED (2026-08-14)

This section used to list two open P0s. **Both are closed.** It is kept because the
*shape* of the bug recurs, and because a successor acting on the old text would
re-fix solved problems and miss the one thing still open.

| Boundary | Closed by | What it stops |
| --- | --- | --- |
| **write** | #433 | a name-only collision root persisting unquarantined at confidence 65 |
| **pivot** | #436 | a quarantined selector offered as an ordinary "Run this pivot" card |
| **promote** | **#448** | a quarantined artifact entering identity clusters, graph edges, confidence dimensions, the report, the audit — or being labelled CONFIRMED |
| **dispatch** | #518/#519, **REVERSED for quarantine by #581** | an ANALYST-REJECTED selector reaching a live tool call. A QUARANTINED selector is now dispatched and its results tainted — see below. `force` overrides neither |

**There is now a RELEASE path, added by #529 (merged 2026-09-08).** `linkage_confirmed` was
the documented escape hatch from quarantine and every boundary READ it, but nothing in the
product could WRITE it — which was a missing convenience until #518 made quarantine
dispatch-blocking, and then became a data-loss defect: a row auto-quarantined in error could
never be pivoted on again, by anyone. `src/lib/quarantine-release.ts` supplies the writer.

Two things about it that must not be "simplified" later:
- **It is NOT a review verdict, and must never become one.** `linkage_confirmed` answers
  "whose is this?"; the review control answers "is this real?". `intel.ts` is explicit that
  release must be explicit and durable because the review control is known to invert on
  quarantined rows and must not overrule an evidence ceiling on a mis-click.
- **The drawer still has no general metadata writer.** #534 deleted `updateMeta` because its
  caller wrote a second `false_positive` signal the agent never read. #529's writer can only
  ever apply `releasePatch(meta)`, which returns exactly two keys or `null`, and returns
  `null` for anything that is not an ACTIVE quarantine. Provenance survives: the patch is
  spread over `meta`, so `subject_unlinked`, its reason and the recorded cap are untouched.

- **The name-only quarantine escape is CLOSED.** It was fixed on exactly the shape this
  file prescribed — gate the exemption on DURABLE linkage, never on name equality:
  `seedLinksQueriedName()` in `auto-persist-findings.ts` **fails closed** (absent or
  unusable seed ⇒ `false`) and requires every queried name token to appear in the seed.
  An unlinked echo now gets `UNLINKED_ECHO_CTX` rather than persisting unquarantined.
  The old line number this section cited (`:826`) is unrelated code today.

- **`subject_unlinked` is now an AUTHORITY, not just a label.** The shared frontend
  predicate is **`isClusterIneligible`** in `src/lib/report-hygiene.ts`, applied at all five
  `buildIdentityClusters` call sites. It is deliberately **separate from
  `isCollisionArtifact`** — widening that one instead looks like the one-line fix and is
  wrong, because it is also the membership test for the report's collision section, so
  widening it double-lists every quarantined row. Backend equivalent: `isExcluded` in
  `lib/cluster.ts`. Keep the two in step.

- **Key numbers, so nobody re-derives them:** 104 quarantined artifacts across 4 threads in
  production, and **zero** of them carry any flag `isCollisionArtifact` tests. The old gate
  was not leaky, it was *inapplicable* — the exclusion mechanism and the quarantine flag
  were disjoint sets of signals that had never been connected.

- **Quarantine is disclosure, not deletion.** All 104 rows stay in the artifact table, stay
  in the Evidence count, and keep their `subject_unlinked_reason`. The fix removes their
  *authority*, never their existence. Any future change that makes a quarantined row
  disappear is a regression, not a tightening.

### ⚠️ The dispatch boundary now refuses ANALYST REJECTION ONLY (#581)

**Read this before acting on anything above or below about dispatch.** As of #581
(2026-09-12, operator decision) `subject_unlinked` is a PROMOTION gate, not a dispatch
gate. Do NOT "restore" the quarantine refusal — it was opened deliberately.

**Do not re-derive this from the old grep.** `grep -rn "isSubjectUnlinked" tool-registry.ts index.ts tools/`
is still empty *and that is fine*: the guard lives in **`cache.ts`** (`wrapToolsWithCache`,
the pre-flight block), keyed by `dispatchKey` (`lib/dispatch-quarantine.ts`) and
`buildRejectedDispatchKeys` (`lib/dispatch-rejection.ts`). What it does now:

- **analyst-rejected selector → REFUSED**, before budget, circuit, cache or the live call.
  `force` does not override it. Pinned by `rejected_dispatch_test.ts`.
- **quarantined selector → DISPATCHED, and its result tainted** with an
  `unproven_linkage` marker (`lib/unproven-linkage.ts`). `extractFindings` stamps
  `subject_unlinked` on everything the call yields, so authority is never inherited.
  `force` cannot shed the taint. Pinned by `quarantine_dispatch_test.ts` (rewritten) and
  `unproven_linkage_test.ts`.
- **kill switch** `PROMOTION_QUARANTINE_DISABLED=true`, read at call time, restores the
  old refusal on the running build with no deploy.

⚠️ **The taint is the safety case, not provenance decoration.** The write-path quarantine
gate keys on QUERY SHAPE, and `username_sweep` on a harvested username is not a name-only
query — so if the marker is ever dropped, a stranger's profiles persist at full subject
authority, join identity clusters and reach the report. That is the hole #433 closed,
re-opened from a different direction.

What remains open — **and #519 did NOT close it, despite what this file used to say.**
#519 merged 2026-09-08 (`e50db9e`, deployed) and this line previously claimed it "stamps
that into `tool_usage_log.input_json.runtime`". It does not. What it actually added is a
structured `console.warn` named `quarantine_dispatch_read_incomplete` (`cache.ts` ~:674),
carrying rows-read and the reason — a real improvement over a silent prefix, but still not
durable. The rejected-dispatch loader still fails open with a plain `console.warn`
(`cache.ts` ~:715/:720), and nothing persists that a run went out with the boundary
degraded. Treat durable runtime stamping as **unbuilt**, not as shipped.

What #519 DID close, in the deployed build: the refused-key read no longer trusts a
short page (it advances by rows actually returned and ends only on an empty page or the
true `count`), and the refusal message is a constant, so caller-controlled text can no
longer be regex-matched by `isIntentionalSkip` into an `ok:true` skip.

Also measured, not fixed: `index.ts`
~:814 `Boolean(detectSeedServer(text))` is true for ANY non-blank message because the server
falls back to `{kind:"other"}`, so the "parses as a seed" opening-phase gate actually fires
on prose too. It is in the termination area — leave it unless you have read the oscillation
history above.

Since 2026-09-02 the same alias table (`lib/kind-alias.ts`) keys the write-side dedup
(`checkpointKey`, `artifactDedupKey`), the read-side rejection (`normalizeArtifactKey`) and
the dispatch guard, so a kind spelling honoured at one boundary is honoured at all three.

The two design hazards the guard was built around still hold:
- Key by **`type:normalizedValue`**, never by value alone. `normalizeTarget` collapses
  non-alphanumerics, so `username "jordan.vale"` and `name "Jordan Vale"` both become
  `"jordan vale"` — keying by value let an ordinary name *restore authority to a
  quarantined username*. `src/lib/quarantine.ts` already gets this right; copy it.
- **A refusal must be legible as a refusal.** `repairUnknownTool` → `UNKNOWN_TOOL_SINK`
  returns `ok:true`, which is how `dork_harvest(completed)` reached a chain-of-custody
  record for a tool disabled since 2026-07-09. Never let a quarantine refusal burn a step
  silently.

Canonical fixtures: the `<collision-case-email>` collision case (exercises all of the above),
and `<uncontaminated-case-email>` as the *uncontaminated* budget-exhaustion case. Both are real
investigations — `src/dev/fixtures.json` and `src/dev/raw/` are gitignored; sanitize before
checking anything in.
