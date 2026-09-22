# NEXT SESSION — start here

**Written 2026-09-22T11:15Z.** Supersedes the previous contents of this file.
Take the dated state from `CLAUDE.md`'s top block, not from any handoff's own §1.

---

## 0. One-paragraph state

`main` = **`74e98ad`** (#604). Live `osint-agent` = **`4bb19d9`**, unchanged since 2026-09-14.
Vercel production is current. **#604 is merged and must not be deployed as-is** — it carries two
real, unrepaired defects. Both now have fix PRs open and fully green: **#615** (Finding A) and
**#616** (Finding B). JD has chosen **path A — fix first**, and set the sequence:
**#615 → #616 → one combined edge deploy → prove**, with **#608 held until after** that deploy.
Nothing is merged. Nothing is deployed. **JD has not authorized either merge.**

---

## 1. What is open, and what state it is in

| PR | Lane | CI | State | Next action |
|---|---|---|---|---|
| **#615** fix #604 Finding A | edge | **fully green** | draft | merge-ready pending §3 + JD's authorization |
| **#616** fix #604 Finding B | edge | **fully green** | draft | merge after #615 |
| **#614** docs: CLAUDE.md corrections + audit | docs | **fully green** | draft | merge whenever; see §5 |
| #608 positional pairing | edge | green | draft | **HOLD until after the #615+#616 deploy** |
| #607 dead-target memory | edge | green | draft | hold — key-mismatch blocker, near-zero measured value |
| #611 budget_exhausted | edge | green | draft | hold — no proof-of-deploy signal |
| #609 / #610 / #612 | frontend | green | draft | parallel lane; run `npm run test:e2e` by hand first |
| #613 lineage schema | schema | green | draft | needs 3 fixes before apply — see the audit |
| #593 #579 #574 #516 #502 #586 #570 #567 #564 #541 | older | stale | — | see `AUDIT_2026-09-22_queue-and-deploy.md` §F/§G |

"Fully green" = Edge deno test, Frontend vitest+build, Migrations psql all success; `Workspace e2e`
skipped (push-only job, by design); Vercel preview success; `Cursor Automation` neutral (third-party,
not a failure).

---

## 2. The two fixes, in one screen each

### #615 — pass 2 must summarize the unconsumed tail, not destroy it
`claude/604-fix-a-preserve-unconsumed-evidence`, head `f2c1f9d`

#604's pass 2 elided **into** the recent window. Its last message, in `prepareStep`, is the tool
result of the call that just completed — unread by the model. It was replaced with a bare
`elidedToolResultRef()` promising *"retrieve via `memory_recall`"*, which cannot work:
`memory_recall` reads only `agent_memory`, and **no tool in the registry reads `tool_call_cache`**.

Now: pass 2 calls `summarizeToolResultValue` (selectors preserved + head snippet), **per part**,
stopping when under budget. Pass 1 unchanged. `memory_recall` promise removed from both markers.
New durable event `prompt_budget_tail_compacted`. `/health` detail gains `, tail=summarize`.

Kill switch: existing `PROMPT_BUDGET_HARD_CEILING_DISABLED` (call-time).

### #616 — measure the ceiling on the array actually sent
`claude/604-fix-b-ceiling-measures-final-array`, head `042357a`

`reportBudgetCeiling` ran **before** `sanitizeModelMessages`+`capToolResultOutputs` at both call
sites, and both can GROW the array. Four production lines: move the call after the composition.

⚠️ **Expected consequence: MORE reported overages.** That is the fix working, not a regression.
Put this in the deploy check so nobody attributes the increase to #616.

---

## 3. The review JD required before merging #615 — PARTIALLY DONE

JD asked for an adversarial review of `summarizeToolResultValue`'s use on three axes. **Two are
settled; one has a gap I did not close. Do not report #615 merge-ready until §3.3 is finished.**

### 3.1 Persistence / diagnostic exposure — **SETTLED, no new sink**

Traced and verified:
- `index.ts:2033` / `:2052` pass **`originalMessages: messages`** — the RAW client array, **not**
  `trimmedMessages` and not `stepMessagesOut`. `persistFinalMessages` (`index.ts:1557`) consumes
  `UIMessage[]` from `onFinish`, which derives from that raw array.
- `grep -n "trimmedMessages\|stepMessagesOut" index.ts | grep -iE "console|insert|upsert|persist|log\("`
  returns **nothing**.

So the compacted array is transient and provider-bound only. **#615 adds no persistence or logging
path.** The new `prompt_budget_tail_compacted` event carries counts and sizes only, no content.

### 3.2 SDK structure, mutation, pairing — **VERIFIED by execution**

Ran the real `capTotalToBudget` over six shapes (fat single result, parallel fan-out, call+result
pair, trailing user message, bare output, primitive value):

- `badDiscriminator = 0` on every shape — the `{type, value}` union is preserved in both branches.
- deep no-mutation of the caller's input: **PASS**
- `toolCallId` order and **part count preserved**: **PASS** (matters because #608 pairs by position)

### 3.3 ⚠️ GAP — SDK acceptance is NOT actually proven. Finish this first.

My harness called `convertToLanguageModelPrompt` **without `await`**, so its rejection surfaced as
an unhandled promise instead of being caught. The `sdk=OK` readings therefore mean only "did not
throw synchronously" and **prove nothing**. (The `MissingToolResultsError` that did surface came
from my own fixture — 130 deliberately unpaired tool-calls — not from #615.)

**To close it:** rebuild the harness with `await`, give each fixture properly paired tool-calls, and
assert the SDK accepts pass-2 output. Script to fix:
`/tmp/claude-0/.../scratchpad/rev615.ts` (regenerate it; /tmp may be gone).
Run with `--allow-read --allow-env --allow-net --allow-sys --no-check --no-lock`.

### 3.4 Head snippets DO carry secrets to the provider — judged in-scope, flagged

Measured: `summarizeToolResultValue` on a payload whose first keys are `password` and `api_key`
retains **both** verbatim in the head snippet. No redaction runs on this path.

Honest framing, because the comparison matters:

| build | what pass 2's tail sends to the provider |
|---|---|
| pre-#604 | recent window **verbatim** — full secret |
| #604 (current `main`) | bare reference — no secret, **but evidence destroyed** |
| **#615** | summary + head snippet — **partial** secret, evidence preserved |

So #615 is *more* than #604 and *less* than main's normal recent-window behaviour, which already
sends those bytes verbatim. It is not a new exposure class. Per JD: **do not expand #615** — this
is not a real problem, it is a disclosure. `REVEAL_BREACH_DATA` is ON and settled; do not touch it.

---

## 4. The sequence JD set — follow it exactly

1. Finish §3.3. If the SDK check passes, report **#615 merge-ready**.
2. **Get JD's authorization.** Merge #615.
3. Merge #616 after green CI (rebase if `main` moved).
4. **One combined edge deploy** of `#604 + #615 + #616` — not two cycles. #616 fixes the telemetry
   used to judge #615/#604, so they must land together.
5. Prove it, in this order:
   - `node scripts/stamp-build.mjs`, commit `build-info.ts`
   - surgical mirror sync — **run `verify:deploy` from a tree actually at `origin/main`**
     (⚠️ a drifted checkout reports `diff -rq` empty = **false green**; compare `origin/main`'s
     blobs against the mirror instead)
   - Lovable deploy, project `4ce11bc3-039d-4439-b293-acacca9e1e3a`, `["osint-agent"]`
   - `/health`: `build` moves **and** `checks.prompt_budget_ceiling.detail` reads
     `hard ceiling 220000 chars, tail=summarize` — the `tail=summarize` token is what proves #615
     (the key alone only proves #604)
   - smoke test:
     `SELECT count(*) FILTER (WHERE context_chars > 220000), max(context_chars) FROM orchestrator_step_metrics WHERE created_at > '<deploy>'`
     Baseline to beat: 68 of 864 steps over budget (7.87%), peak 290,961.
   - then query `prompt_budget_ceiling_unmet` **using #616's corrected measurement**, expecting it
     to read higher than before
6. **Only then** unblock #608.

---

## 5. Loose ends

- **#614** (docs) is green and can merge any time. Its new dated-state block says *"do not deploy
  current main"* — **true today, false the moment #615+#616 deploy.** Update it in the same breath.
- **`CLAUDE.md` conflicts**: #564, #570, #541 all conflict on the dated-state block. #564 is **not a
  draft** and would inject a three-deploy-stale state plus a standing "do not deploy" instruction.
- **Mirror PR #41** is still open and un-backported. Backport its two hunks here; do not merge it on
  the mirror. Re-check `git log origin/main` in the mirror clone, not just `diff -rq`.
- A check-in Routine (`trig_013FWgMe2D6BcWaJHw9dLtwW`) re-checks #614/#615/#616 CI. All three are
  green now; retarget or disable it.
- Deno 2.9.7 is installed at `/usr/local/bin/deno`. **Always `--no-lock`** — an unqualified run
  rewrote `deno.lock` with a `@deno/installer-shell-setup` entry during this session (reverted).

## 6. Measured baselines (2026-09-22, Deno 2.9.7, `--no-lock`)

| | edge suite |
|---|---|
| `main` @ `74e98ad` | **1891** / 0 / 6 |
| #615 | **1896** / 0 / 6 |
| #616 | **1893** / 0 / 6 |

Negative controls are real, not described: #615's new tests were run against `origin/main`'s source
in a scratch tree — **6 fail**, including all three `pass 2` cases. #616's wiring test fails on
`main` too. Reproduce with `git archive origin/main supabase/functions scripts | tar -x -C <dir>`,
then copy the PR's test file in.

## 7. Reading order

1. `CLAUDE.md` top block — the dated state.
2. `AUDIT_2026-09-22_queue-and-deploy.md` — full queue audit: source-of-truth table, the #604 gate,
   edge order with proof keys, #613's merge≠apply≠verify split, the 17-PR queue, operator decisions.
3. This file.
4. `SESSION_HANDOFF_2026-09-20_prompt-ceiling-payload-store-and-the-overlap-wedge.md` — still the
   best background on the payload store and the overlap wedge, but its §1 state is stale.

## 8. Do not

Do not merge or deploy without JD's authorization · do not deploy #615 and #616 in separate cycles ·
do not unblock #608 before the combined deploy is proven · do not apply #613's migration · do not
change `REVEAL_BREACH_DATA` or broaden masking · do not change auto-run `record_artifacts` →
`record_finding` adjudication · do not expand #615's scope.
