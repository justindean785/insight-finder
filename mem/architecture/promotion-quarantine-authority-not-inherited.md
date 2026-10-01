# Promotion quarantine — authority is not inherited

**Shipped 2026-09-12 as #581** (squash `2864860`), deployed and verified the same day
(live `/health` build moved `7c7888f` → `2864860`).

## What changed

`subject_unlinked` is now a **PROMOTION** gate, not a **DISPATCH** gate. This
deliberately reverses the dispatch half of #518/#519 and relaxes #436, on operator
decision, after the concern that it reverses five merged PRs was raised and
reaffirmed. **Do not "restore" the quarantine refusal — it was opened on purpose.**

| Boundary | Before | Now |
| --- | --- | --- |
| write (#433) | query-shape quarantine stamps | unchanged |
| pivot (#436) | quarantined pivot BLOCKED | **warning**, runs |
| promote (#448) | no cluster / graph / report / CONFIRMED | unchanged, and now load-bearing for dispatch too |
| dispatch (#518/#519) | quarantined selector REFUSED | **allowed + tainted** |
| dispatch — analyst rejection | refused | **still refused**; `force` does not override |

### Why

Measured on the 2026-09-11 person-seed run `d4873abc`: the dispatch gate refused
`username_sweep` on `ufland40` and refused the breach lookups on the emails harvested
beside it, so the run was **structurally forbidden from proving or disproving the very
link it was investigating** — and then reported "no authoritative findings".
Refusing to look is not the same as looking and finding nothing, and the case file
could not tell them apart.

## ⛔ The invariant that makes it safe

**AUTHORITY IS NOT INHERITED.** A call against a selector whose linkage is unproven
yields findings whose linkage is unproven, so every one is stamped `subject_unlinked`
naming the parent. `lib/unproven-linkage.ts`; applied in `auto-persist-findings.ts`
(`extractFindings`).

This is the **safety case, not provenance decoration.** The write-path stamp keys on
**query shape**, and `username_sweep` on a harvested username is *not* a name-only
query — so without the taint a stranger's profiles persist at FULL subject authority,
join identity clusters and reach the report. That is exactly the hole #433 closed,
re-opened from a different direction.

`unproven_linkage_test.ts` fails three ways if the stamp is removed (verified by
reverting it). It drives the shipped `extractFindings` over realistic tool output
rather than asserting helpers in isolation, and carries a **control** case — the
identical lookup without the taint must still produce ordinary evidence — so the
invariant test cannot pass for an unrelated reason.

### Two design choices not to undo

- **The stamp reuses the existing `subject_unlinked` vocabulary** rather than a new
  flag, so `isExcluded` (`lib/cluster.ts`), `isClusterIneligible`
  (`src/lib/report-hygiene.ts`), the dispatch guard and the report's collision section
  all honour it with no new plumbing. A new key would need teaching to six readers,
  and the one that was missed would be the leak.
- **The taint rides `runtimeMetaBase`** in `cache.ts`, which every return path spreads
  — live, cache hit, stale replay, selector reuse, timeout stub. Attach it only to the
  live path and a cached replay of the same quarantined selector comes back clean and
  promotes.

A more specific existing reason wins: the derived stamp runs *after* the name-only
stamp, and a row that already carries one keeps its reason while gaining
`unproven_linkage_parent`.

## Kill switch

`PROMOTION_QUARANTINE_DISABLED=true`, read at **call time** (not module load), so it
restores the old refusal on the running build with **no deploy**. Kept precisely
because this reverses five merged PRs and its blast radius is every paid tool in the
registry.

## The paging tests got MORE important, not less

Their failure mode inverted and got worse. An incomplete read of the refused keys used
to mean "failed to refuse"; it now means "**failed to taint**" — the result comes back
clean and promotes. `quarantine_dispatch_test.ts` was **rewritten, not deleted**, and
#519's skip-shaped-reason hardening was preserved on the kill-switch path rather than
retired with the boundary.

## Where the guard actually lives

`grep -rn "isSubjectUnlinked" tool-registry.ts index.ts tools/` returns nothing **and
that is fine** — the guard is in `cache.ts` (`wrapToolsWithCache`, the pre-flight
block), keyed by `dispatchKey` (`lib/dispatch-quarantine.ts`) and
`buildRejectedDispatchKeys` (`lib/dispatch-rejection.ts`).

## What to watch

The first real person-seed run under this. The thing to check is **not** that pivots
fire — it is that everything they yield carries `subject_unlinked` with an
`unproven_linkage_parent`. If a tainted-parent row reaches an identity cluster or the
report, set `PROMOTION_QUARANTINE_DISABLED=true` immediately and re-open the invariant.
