# Session handoff — 2026-09-20
## The prompt budget was not a ceiling, the payload store is a table, and overlapping sends wedge a thread

> Every number here is a **dated measurement**, not a state. Re-verify before acting.
> Written 2026-09-20T12:00Z, covering the session of 2026-09-19.

---

## 1. Verified state at close

| Axis | Value | How verified |
|---|---|---|
| canonical `main` | **`ad4937b`** | `git log origin/main` |
| live edge build | **`4bb19d9`** | unchanged — nothing deployed this session |
| `deploy/live` ref | `4bb19d9` | unchanged |
| edge baseline on clean `main` | **1885 passed / 0 failed / 6 ignored** | `npm run test:edge`, measured by stashing |
| frontend baseline on clean `main` | **2106 passed / 1 skipped / 173 files** | `npx vitest run` |
| e2e baseline | **51 passed / 2 skipped** | `npm run test:e2e` by hand |

**Nothing merged and nothing deployed.** `main` did not move for the whole session. Three PRs
are open as green, mergeable drafts waiting on JD:

| PR | head | channel | what it is |
|---|---|---|---|
| **#602** | `2bdbfe1` | frontend | `experimental_throttle: 80` — the mid-word streaming freeze |
| **#603** | `174bc70` | frontend | readiness denominator — stop punishing exclusion |
| **#604** | `9bd5587` | **edge** | prompt char budget as a hard ceiling (this session's code) |

⚠️ **#602 and #603 ship to production on merge via Vercel. #604 does NOT.** It needs the full
edge cycle: stamp → surgical mirror sync → `npm run verify:deploy` reporting `mirror tree ->
equal` **immediately before** the deploy message → Lovable deploy → `/health` showing both a
moved build SHA **and** the new `checks.prompt_budget_ceiling` key → ledger.

---

## 2. ⚠️ CLAUDE.md's baselines are stale — correct them, don't report a regression

Three numbers in CLAUDE.md were measured at `4bb19d9` and `main` has since moved to `ad4937b`:

| CLAUDE.md says | Actually measures on clean `main` |
|---|---|
| edge **1879** / 0 / 6 | **1885** / 0 / 6 |
| frontend 2104 / 1 / **172 files** | 2106 / 1 / **173 files** |
| e2e **52** passed / 2 skipped | **51** passed / 2 skipped |

I hit this twice. Both times the disciplined move was the same: **stash the branch and re-measure
on clean `main` before crediting or blaming the diff.** #604's +6 is exactly its six new tests.
This is the third session in a row where a suite total moved for a reason other than the code —
check the runner and the base commit before the change.

---

## 3. What shipped as code — #604, the prompt budget hard ceiling

**The defect.** `capTotalToBudget` treated `keepRecent` as an **exemption**, not a priority:

```ts
const cutoff = Math.max(0, out.length - keepRecent);
for (let i = 0; i < cutoff; i++) { … }   // nothing past here was elidable
```

Once the protected tail alone exceeded `TOTAL_PROMPT_CHAR_BUDGET`, the loop ran out of elidable
messages and **returned over budget reporting nothing**.

**Measured:** `orchestrator_step_metrics` — **68 of 779 steps (8.7%) went out over the 220,000-char
budget, peaking at 290,961.** That meter is `approxPromptChars`, the documented undercount, so
8.7% is a **floor**. On thread `a8643383` a single persisted assistant message is **99,887 chars**
— 45% of the whole budget inside one protected message.

**The fix.** A second pass continues into the recent window, still oldest-first, stopping the
instant the array is under budget. The per-message transform is extracted into
`elideMessageParts()` and shared by both passes so they cannot drift — both preserve the
tool-result `output` discriminator and neither ever removes a part or a message.

**What it deliberately does not claim.** It bounds what elision can bound. Enough already-elided
messages still exceed any budget, and tool-call metadata, tool *inputs* and assistant text are not
elidable to zero. `reportBudgetCeiling()` emits one structured `prompt_budget_ceiling_unmet` event
rather than letting an over-budget array go out silently.

Kill switch `PROMPT_BUDGET_HARD_CEILING_DISABLED`, read at call time. Proof-of-deploy key:
**`checks.prompt_budget_ceiling`**.

---

## 4. ⛔ The highest-value unfixed defect — overlapping sends wedge a thread

**This is the thing to fix next, and it is not the concurrency model.** It is a ten-line bug in
`sanitizeModelMessages`.

`sanitizeModelMessages` pass 3 synthesizes a placeholder tool-result for any unpaired tool-call,
skipping when `resolved.has(toolCallId)` — and `resolved` is a **global id set** populated from
every tool-result anywhere in the array. The AI SDK validates **positionally**
(`ai/dist/index.mjs:1355-1392`): it walks in order and throws the moment it reaches a `user` or
`system` message with an unresolved tool-call id.

So when an overlapping run delivers its result *late*, the array carries the same `toolCallId`
twice — once unpaired, once resolved — and the later real result **suppresses the placeholder the
earlier dangling call needs**. The run then dies with `MissingToolResultsError` before any
provider call.

**Reproduced end to end** (`repro/overlap.mjs`, `repro/server_pipeline.ts`, `repro/wedge.mjs` —
drove the real `@ai-sdk/react@3.0.199` `Chat` with a fake transport, then the real
`convertToModelMessages` → `sanitizeModelMessages` in Deno, then `streamText` with a mock model).

**Confirmed in production.** Thread `bfa55610`, 2026-09-12:

| time | invocation | stop_reason | detail |
|---|---|---|---|
| 20:52:39 → 20:53:59 | `5191db81` | stream_error | "Investigation stopped by analyst" |
| 20:54:40 → 20:55:27 | `f1b32ee5` | unknown | 1 step, 7 tool calls |
| **20:54:59 → 20:54:59** | `586b6e0e` | stream_error | **"Tool results are missing for tool calls `01a09765…`"** — 85 ms |
| **20:56:11 → 20:56:11** | `55145023` | stream_error | **same error, same tool call id** — 85 ms |

The same tool call id in both failures is the client re-uploading the poisoned history. It heals
on reload, which is exactly why it never produced duplicate DB rows and never showed up in any
audit.

**Fix shape:** make pass 3 resolve tool-call ids **per position**, not globally. Small, pure,
unit-testable, and it helps whichever concurrency model is eventually chosen.

### The rest of the concurrency picture

- **Overlap rate: 15 of 123 invocations (12.2%) started while another run on the same thread was
  still going, across 10 of 30 threads.** Not an edge case.
- **A second send from the same live composer is already blocked** — `isSubmitBlocked` guards all
  four submit sites. The overlap comes from: **Stop-then-send** (the UI unblocks immediately while
  `prepareStep` only polls `threads.status` *between* steps), **reload / second tab / remount**,
  and **Retry after a network drop** (which the codebase names itself at `ChatWindow.tsx:1514`).
  Client POST retry is **ruled out** — `fetchWithRetry` gives a non-replay-safe method exactly one
  attempt.
- **What the second request contains is path-dependent:** same `Chat` instance → **partial** (the
  first run's assistant message with a tool part in `state:"input-available"`, no result); fresh
  instance → **absent**. Never complete.
- **No lost update.** `messages` has only `messages_pkey` + `messages_thread_id_fkey` — no unique
  constraint, no version column, no trigger, and the write is a bare `.insert(...)`. Append-only.
- **Cost is charged twice.** `increment_thread_cost` is correctly atomic, so both runs pay in full:
  ~$0.52 across four overlapping runs in five minutes, with 3 repeat calls on identical
  `tool_name + input` and 0 cache hits.
- **The UI is inconsistent during overlap.** `useThreadMessages` has no realtime subscription, but
  `useThreadArtifacts`, `useThreadToolActivity`, `useThreadToolHealth` and
  `useThreadQueriedTargets` all subscribe to `postgres_changes` — so the Evidence board updates
  from *both* runs while the transcript shows only the local one. There is no "a run is active on
  this thread" indicator anywhere.

Recommended model, if/when the mechanism is changed: **accept the message, queue the execution**,
built on `threads.last_heartbeat_at` — the instrument the codebase already declares the sole
liveness authority. Full comparison of the three options in
`SCOPE_same-thread-concurrency.md` §7.

---

## 5. ✅ `stop_reason='unknown'` is explained — it is an unwired parameter, not a failure

`deriveStopReason` (`telemetry.ts:114-142`) returns `unknown` when `finishReason === "tool-calls"`
and `budgetExhausted` is falsy, deliberately refusing to name a cause nothing measured.

**`budgetExhausted` is never passed.** The single call site (`telemetry.ts:423`) supplies only
`hadStreamError`, `finalizeStarted` and `lastFinishReason`. So `budget_exhausted` is
**unreachable**, and every tool-calls run that neither stream-errored nor force-finalized is
labelled `unknown` by construction.

`unknown` means "the loop stopped while the model still wanted tools, and no ceiling was
recorded". Which ceiling fired is **not knowable from the data as instrumented**. One-line fix at
the call site, on its own PR. Another BUILT AND UNWIRED instance.

---

## 6. The payload-store decision — JD chose Option A, and the shape changed

Full analysis in `SCOPE_persisted-tool-payloads.md`, `PRICING_payload-store-vs-summary-only.md`
and `DESIGN_payload-store.md`. The load-bearing results:

**The corpus.** 44 MB across 2,104 messages / 250 threads. Tool parts are **82.4%** of all message
bytes; the `output` key alone is **68.8% of the whole corpus**. Output size p50 **837** chars,
p95 15,594, max 605,427. **73 of 250 threads (29%) already exceed 220,000 chars.**

**⚠️ Persisting raw payloads costs nothing in prompt size.** `index.ts:244-323` already truncates
inbound history four ways on every request (1,500 old / 16,000 recent, selector-preserving
summarization, `capTotalToBudget`, then a final 8,000 cap). A 605,427-char persisted payload
reaches the model as ≤16,000 today. **The persistence change is a wire-and-storage fix, not a
prompt fix** — I had these conflated when I first scoped it.

The wire cost is real: `DefaultChatTransport` (`ChatWindow.tsx:1475`) has no
`prepareSendMessagesRequest`, so **the whole history is re-uploaded every turn** — 431 KB at p90,
2.0 MB worst case, from a phone. There is no instrument for it.

**JD's recalculation instruction changed the answer.** Under a 120,000-char aggregate inline
budget the store is **4,549 objects / 14.0 MB** — 4.5× more objects than the >8k figure (1,015)
and *fewer* bytes than 18.9 MB, because the two criteria select different payloads. **4,147 of the
displaced (91%) are under 8,000 chars**; p50 is 812, and **only 2 objects exceed 256 KB, none
1 MB.**

**So the store is a TABLE (`tool_call_payloads`), not the archive bucket.** That also removes an
unproven dependency: `evidence-archive` holds **0 objects**, **0 of 11,364 `evidence_log` rows**
carry `archive_storage_path`, and only 9 of 257 threads have `archive_attachments` on — the
`archiver.ts` storage write has never successfully run in production.

**A per-item cap never bounds a thread** — 218 tool parts × any constant is still linear. Only the
aggregate budget is O(1) in call count. And no persistence change gets the worst threads under
220k; the residual is tool inputs, scaffolding and model text. That ceiling is #604's job.

---

## 7. Trap list — instruments and claims that lied this session

1. **CLAUDE.md's three baselines** (§2). Stash and re-measure on clean `main`.
2. **`orchestrator_invocations.created_at` is the telemetry insert at finish, not run start.** I
   reported an overlap timeline from it and had to withdraw it. Use `started_at`/`finished_at`.
3. **`initial_context_chars` cannot tell you what a run saw.** It is computed *after* trimming, so
   two runs 16 chars apart proves nothing about their histories. JD caught this; the reproduction
   is the evidence, not the counts.
4. **The `evidence-archive` bucket looks like proven machinery.** It is syntactically present and
   has never written an object.
5. **`client_errors` shows 0 `MissingToolResult`** — because the error is thrown server-side. Its
   absence from a client table is not evidence of absence.
6. **`tool_call_cache` looks like a durable payload store.** 47 MB, 12,701 rows back to 2026-06-25,
   only 129 unexpired — it retains outputs *only because `CACHE_SWEEP_ENABLED` is off*. Keyed by
   input hash, no `call_id`, no `thread_id`. Do not build on it.
7. **My own ATTESTED claim in an earlier session was wrong** and is corrected in #603's body:
   ATTESTED means analyst-confirmed and `intel.ts:552` keeps the decision off the figure on
   purpose (#534).

---

## 8. Open decisions — these block the next PRs

1. **Merge #602 / #603 / #604.** All three are green and mergeable. Nothing else can proceed on
   the edge channel while #604 sits (one edge PR in flight at a time).
2. **The inline payload budget value.** 120,000 is modelled, not derived. 60k halves cost and
   displaces 73%; 200k displaces 27%. It is an analyst-workflow question — how much recent raw
   detail should stay in the transcript without a fetch.
3. **Whether to change the concurrency mechanism at all**, or only fix the wedge (§4). The wedge
   fix is worth doing regardless.

---

## 9. Ordered plan for the next session

| # | PR | channel | why this order |
|---|---|---|---|
| 0 | **merge #602, #603; merge + deploy #604** | both | nothing proceeds until the queue drains |
| 1 | **`sanitizeModelMessages` positional pairing** | edge | stops the production wedge; small, pure, independent |
| 2 | **`budgetExhausted` at the `deriveStopReason` call site** | edge | one line; makes `unknown` mean something |
| 3 | **request-body size meter** | frontend | gives a before/after number for the payload work |
| 4 | **schema: `call_id` on `tool_usage_log` + `tool_call_payloads`** | migration | schema first, verified against the live DB |
| 5 | **payload write path + aggregate inline budget** | edge | kill switch + `/health` key + the E2E gate below |
| 6 | **drawer fetch-on-demand + `retained:false`** | frontend | — |

**JD's E2E gate for the store, verbatim in intent:** nothing counts as proven until one test
exercises write, read, **authorization** (a second authenticated user gets nothing; anonymous gets
nothing — both asserted) and **failure** (a write fault degrades to `retained:false` with the run
continuing, never failing finalize).

---

## 10. Carried forward, not done

- `promoteConfidence`'s corroboration branch is still a mathematical no-op (evidence-ranking,
  needs sign-off).
- Mirror PR #41 is still open and un-backported. Re-check as part of the hard gate.
- Memory retrieval is still keyed on `subject` only — 101 tool-reliability lessons unreachable.
- There is still no call-to-artifact lineage. `call_id` in step 4 above is the shared prerequisite.
- `CACHE_SWEEP_ENABLED` is still off. ⚠️ **Turning it on deletes the only accidental copy of
  historical tool outputs** — sequence it after the payload store, not before.
