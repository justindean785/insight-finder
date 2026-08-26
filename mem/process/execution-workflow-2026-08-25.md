---
name: Insight Finder step-by-step execution workflow (2026-08-25)
description: JD's ordered Part A / Part B execution plan — settle the PR queue (A1-A3), then ship B1-B7 — with the per-step rules that every step inherits; Step A1 is DONE, main is 865f49e
type: process
---
The full plan JD handed over on 2026-08-25. Each step is a standalone prompt for a fresh
session. **Do them in order** — later steps branch off the `main` that earlier steps
produced, so skipping ahead means branching off a `main` that is missing the fixes.

`main` at plan authoring = `4cc7573`. Not branch-protected. No auto-merge. No deploy. No
Lovable sync. **JD authorizes every merge and deploy.**

## Rules every step inherits

1. **Start from a fresh, clean `main`** — `git fetch origin && git checkout main && git pull
   origin main`. Confirm the SHA matches what the previous step reported. If it does not,
   STOP — something merged or reverted underneath you.
2. **One branch per step.** New feature branch off `main`, never reuse a prior step's.
   Convention: `claude/<short-scope>` or `fix/<short-scope>`.
3. **Verify before moving on** — `npm run lint && npm run typecheck && npm run test &&
   npm run test:edge` green on the branch, AND CI green on the PR.
4. **Merge (or close) before the next step.** A step is done when it is merged to `main`,
   not when the PR is opened.
5. **Report the new `main` SHA after each merge.** The next step's pre-flight depends on it.
6. **Handoff doc per Part B step** — `SESSION_HANDOFF_2026-08-25_<step>.md` in the repo's
   handoff style: exact SHAs, measured before/after test counts, what shipped, what
   contradicted the prompt, nothing deployed without JD. Commit it on the branch.

## PART A — settle the PR queue

- **A1 — merge #501, #468, #503** (green, zero file overlap). ✅ **DONE 2026-08-25.**
  Merge order #501 → #468 → #503, squash each. `main` was **`865f49e`** at that point;
  it is **`a38963c`** now after the edge deploy (below).
  (#501 report authority, 9 files +932/-21; #468 Graphify `.mcp.json`, 2 files +16;
  #503 docs, 4 files +141.)
  ⚠️ **#503 shipped three defective claims** — its mem notes describe #502's code, which is
  NOT on `main` (`enforceToolPairing`, `tool_pairing_repaired`,
  `RECOVERY_SWEEP_MIN_INTERVAL_MS` = 0 hits on `main`, present only at `0896e00`).
  **PR #505 corrects them and should be merged.** Do not trust
  `mem/architecture/ai-sdk-positional-tool-pairing.md` on `main` until it is.

- **EDGE DEPLOY — done 2026-08-25, outside the A-track.** Live build moved
  **`14e42a5` → `865f49e`**, the first move since #438. It shipped #486 (`record_finding`
  derives status server-side) and #498 (authoritative Evidence Record), which had been
  merged-but-undeployed. Recipe run in full: stamp (`df24977`) → surgical mirror sync
  (`783f879`, osint-agent only, zero deletions) → explicit Lovable
  `supabase--deploy_edge_functions` → `/health` verified → ledger + `deploy/live` published
  (`a38963c`). The Lovable MCP call **timed out client-side at 60 s and still deployed** —
  the moved `/health` SHA was the only proof, exactly as the recipe says.
- **A2 — review and merge #502** (39 files, +2754/-192, 21 commits, branch
  `claude/audit-claims-verify-oi0urm`). The 2026-08-24 audit remediation + permanent
  run-wedge fix + #476 account deletion. It rewrites `cache.ts`, `circuit.ts`,
  `tool-registry.ts`, `safety.ts`, `health-handler.ts`, `index.ts`, `providers.ts`,
  `env.ts`, `ratelimit.ts` — **it must land before B1** or the quarantine work is built on
  the buggy pre-fix versions. Its **PR body is the source of truth, not the audit
  document**; it corrects 5 audit claims. Claude does NOT merge this one: list the 5
  corrections verbatim, confirm CI on the current head, and diff against main to verify it
  does not violate the settled constraints. JD reads the summary and merges.
  ✅ **REVIEW DONE 2026-08-25 — not merged.** All seven settled constraints hold
  (`REVEAL_BREACH_DATA` untouched; `linkage_confirmed`/`confidence_cap_applied` untouched;
  no `toolChoice` code change; `MAX_PAID_CALLS = 12` byte-identical; `recovery.ts` /
  `orchestrator-finalize.ts` / `cluster.ts` untouched; `metadata.label` untouched; the
  deletion RPC is a no-argument `SECURITY DEFINER` keyed on `auth.uid()` with
  `search_path` pinned and `REVOKE`d from anon/PUBLIC). Two notes: its CI is **green but
  stale at base `4cc7573`**, and **`vercel.json` DOES change** — CSP `script-src` drops
  `'unsafe-inline'`, which the body's "deliberately not done" line about the vercel.json
  *rewrite* obscures. Verified safe: built `dist/index.html` emits one `<script src=…>`,
  zero inline scripts, zero inline handlers.
- **A3 — triage #493 / #435 / #491**, which overlap the files #502 rewrote. Per PR:
  fully subsumed → close with a comment naming the covering #502 commit; partially
  subsumed → fresh branch off main, cherry-pick only the remainder, new PR, close the old
  one pointing at the replacement; not subsumed → rebase, resolve without dropping
  changes, force-push, re-run CI. Claude merges nothing here.

## PART B — the upgrades

- **B1 — quarantine binds at dispatch + release hatch (#480, #489).** Foundation for the
  rest of Part B. Two PRs: #480 first (a `subject_unlinked` row must not trigger a further
  provider call for that selector in the same run; block lifts once `linkage_confirmed`
  exists), then #489 on top (one-click confirm/reject on the flagged artifact or cluster,
  in investigator English, not `linkage_confirmed` jargon).
- **B2 — report self-consistency (#496, #497).** Both on the EXPORT path. FIRST check what
  #501 already covers — do not duplicate landed work. Goal: ONE shared confidence and
  source-class computation used by both the UI Evidence Matrix and the markdown/PDF export.
- **B3 — minimal cluster merge (#249).** Same normalized email / same phone / explicit
  analyst merge. NEVER auto-merge across a `subject_unlinked`, contradiction, or unresolved
  collision row. Add a merge operation on top of `buildIdentityClusters`; do not rewrite
  the clustering algorithm.
- **B4 — graph tab as a working filter.** Selecting a node filters the evidence matrix AND
  chat context; quarantine badge on the node. Do NOT rebuild ReactFlow or refactor the graph.
- **B5 — analyst notes on artifacts (#75).** Timestamped, user-scoped (RLS to `auth.uid()`),
  in the evidence matrix and the report appendix. NOT reviews, NOT confidence — separate
  table or column. Do not reuse `metadata.label` or the review fields.
- **B6 — run diff (#74).** Added / removed / confidence-delta only for the MVP. Reuse the
  existing comparison and confidence functions.
- **B7 — stop actually stops (#65).** A client disconnect must cancel the server-side run.
  Must NOT violate finalize invariants I-1/I-2, must NOT change `MAX_PAID_CALLS`, must NOT
  add work inside the finalize window. Persist in-flight evidence before stopping. If the
  current code already cancels cleanly, close #65 with the verification documented.

## What NOT to do in any step

- Don't re-apply the 2026-08-24 audit literally — #502 already did and corrected 5 of its
  claims. **The audit doc is not the source of truth.**
- Don't change `REVEAL_BREACH_DATA`, `confidence_cap_applied`, `MAX_PAID_CALLS`, global
  `toolChoice`, or finalize invariants I-1/I-2.
- Don't globally namespace `metadata.label` — it is load-bearing for `isMetaArtifact`
  (`useThreadArtifacts` keys on `label:"triage_decision"`).
- **Don't merge or deploy without JD's authorization.**
- Don't split `ChatWindow.tsx` / `intel.ts` / `CaseReport.tsx` unless a task is blocked on
  it — file size is not the product.
- Don't start a step without branching off the latest post-merge `main`.
- **Behavioral tests must DRIVE the shipped control flow, never re-describe the arithmetic
  inline.**

## Closing deliverable

When A1–A3 and B1–B7 are all merged or honestly blocked, write
`SESSION_HANDOFF_2026-08-25_full-execution-complete.md`: every PR that landed (number, SHA,
what it fixed), every issue closed, every issue still open and why, and the next-highest-value
work (likely scheduled re-investigation #77, collaborative sharing #76, prompt-bloat
summarization #238 — real features, not trust fixes).
