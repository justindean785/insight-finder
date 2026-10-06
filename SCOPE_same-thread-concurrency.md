# Scope — same-thread concurrency

**Read-only, 2026-09-19. No code changed, nothing merged, nothing deployed.**
`main` = `ad4937bc` · live edge `4bb19d9` · #602/#603 unmerged drafts.
Evidence: live DB reads, the installed `ai@6.0.197` / `@ai-sdk/react@3.0.199` sources, and a
local reproduction driving the real SDK with a fake transport (no network, no credits).

---

## 0. Correction carried forward

**Four sends produced four assistant rows with four distinct contents.** Verified by
`md5(parts::text)` over every row on thread `a8643383` in the 08:41–08:50 window: all 11
hashes distinct. There is **no duplicate persisted content**, and my earlier "overlap
duplicates" framing was wrong at the DB layer. Overlapping work, yes; duplicated rows, no.

The duplication is real but lives one layer up — **in the client's in-memory message store**,
where it is created and then uploaded. That is the subject of §2.

---

## 1. Scale

| | |
|---|---|
| invocations in the telemetry window (from 2026-09-11) | 123 across 30 threads |
| **started while another run on the same thread was still going** | **15 (12.2%)** across **10 of 30 threads (33%)** |

Not an edge case.

---

## 2. The reproduction — what the second request actually contains

You were right to refuse the character-count argument. `initial_context_chars` is computed
**after** trimming and capping, so ic 266,522 vs 266,538 proves nothing about what the model
saw. I withdraw that inference. Here is the direct evidence instead.

**Method.** Drove the real `Chat` class from `@ai-sdk/react@3.0.199` with a transport that
records request bodies. Run 1 streams text, then a `tool-input-available` for `call-1`, then
holds open (still executing). A second `sendMessage` fires mid-stream.

**Result — the second request carries PARTIAL output from the first run:**

```
--- request #2 (trigger=submit-message) — 5 messages
    user      "Target: wopdell (username)"
    assistant "Prior completed turn."
    user      "run the sweep"
    assistant  text(36 chars) + tool-exa_search state="input-available"   ← run 1, mid-flight
    user      "also check telegram"
```

The tool part, raw: `{"type":"tool-exa_search","toolCallId":"call-1","state":"input-available","input":{"q":"wopdell"}}`
— an `output` key exists but is `undefined`, so `part.output != null` is false server-side.
**The call is present; the result is not.**

**Three further facts from the same run:**

1. **The second send does not abort the first.** `AbstractChat.sendMessage` never touches
   `activeResponse.abortController`. Run 1 accepted a late `tool-output-available` after
   run 2 had already finished.
2. **The client store ends up with the same message id twice.** `makeRequest`'s `write()`
   branches on `activeResponse.state.message.id === this.lastMessage?.id`; once run 2's
   message is last, run 1's late chunks take the `pushMessage` branch and **append run 1's
   completed message after run 2's answer**. Final store order: `… user, assistant(run1
   partial), user, assistant(run2), assistant(run1 complete)` — id `VU1sEoqHZ4E8Rl2r`
   appearing twice, once `input-available` and once `output-available`.
3. **The next turn uploads that.** Request #3 carried 8 messages including both copies of the
   duplicated id, out of order.

**The answer is path-dependent** (§4): a mid-stream send from the *same* Chat instance sends
**partial**; a send from a *fresh* instance (reload, second tab, remount) reads history from
the DB and so sends **absent** — the in-flight run's output is not persisted yet. Never
complete.

---

## 3. What that history does to the server — reproduced, and found in production

Ran the reproduced body through the **real** server pipeline (`convertToModelMessages` →
`sanitizeModelMessages`, Deno, actual source):

```
assistant text(Checking the handle across p)  tool-call:call-1     ← unpaired
user      text(also check telegram)
assistant text(ok)
assistant text(Checking the handle across p)  tool-call:call-1     ← duplicate id
tool      tool-result:call-1={"type":"json","value":{"hits":3,…}}
```

**`sanitizeModelMessages` did not repair the first call**, and that is a real defect in the
guard rather than an accident of my fixture. Its pass 3 skips synthesis when
`resolved.has(toolCallId)`, and `resolved` is a **global id set** populated from every
tool-result anywhere in the array. The late-arriving real result for `call-1` therefore
suppresses the placeholder that the *earlier* dangling `call-1` needs. The pairing guarantee
is keyed by id, but the SDK validates **positionally**.

**It wedges.** `streamText` with a mock model on that exact shape:

| fixture | outcome |
|---|---|
| A — late delivery, duplicate id, first call unpaired | **`AI_MissingToolResultsError`, `toolCallIds:['call-1']`**, run yields nothing |
| B — same, with a placeholder tool-result before the user turn | runs normally |

The SDK's validator (`ai/dist/index.mjs:1355-1392`) walks in order and throws the moment it
reaches a `user` or `system` message with an unresolved tool-call id. It never gets as far as
the later real result.

**This is in production.** Thread `bfa55610`, 2026-09-12:

| time | invocation | stop_reason | detail |
|---|---|---|---|
| 20:52:39 → 20:53:59 | `5191db81` | stream_error | "Investigation stopped by analyst", 4 steps, 19 tool calls |
| 20:54:40 → 20:55:27 | `f1b32ee5` | unknown | 1 step, 7 tool calls |
| **20:54:59 → 20:54:59** | `586b6e0e` | stream_error | **"Tool results are missing for tool calls `01a09765…`"** — 85 ms, 0 steps |
| **20:56:11 → 20:56:11** | `55145023` | stream_error | **same error, same tool call id** — 85 ms, 0 steps |

`586b6e0e` started 19 s into `f1b32ee5` and died in 85 ms. The next turn died with **the same
tool call id** — the poisoned store re-uploaded and re-wedged, exactly as the reproduction
predicts. It matches CLAUDE.md's own warning that an orphaned tool-call "makes streamText
throw … EVERY cycle and the run wedges until the analyst stops it."

**It heals on reload.** The DB rows are correct and correctly ordered; `ChatWindow.tsx:1293`
rebuilds the store from them. The corruption is confined to the live client store — which is
why it never produced duplicate persisted content, and why it is invisible in the DB.

---

## 4. Entry paths — classified

`isSubmitBlocked(status, locked)` = `locked || status==="submitted" || status==="streaming"`,
checked at **all four** submit sites (`:1851, :2052, :2085, :2291`), plus the synchronous
`submitLockRef`. **A plain double-click or mid-stream send from the same live composer is
already blocked.** So the 12.2% comes from paths where the sending component's status is not
streaming:

| path | mechanism | history the 2nd run gets | guarded today |
|---|---|---|---|
| **M1 — Stop, then send** | `stopInvestigation` aborts the browser stream and writes `threads.status='stopped'`, which only `prepareStep` polls **between steps**. The UI unblocks immediately; a run inside a long step keeps going. | **partial** | no |
| **M2 — reload / second tab / remount** | a fresh `Chat` with `messages: initial` from the DB; the in-flight run's output is not persisted yet | **absent** | no |
| **M3 — Retry after a network drop** | the codebase names this itself: *"invites a Retry that starts a SECOND concurrent run on the same thread"* (`:1514`, `:1532`) | partial or absent | **partially** — heartbeat-based drop suppression (`last_heartbeat_at`) |
| **M4 — client retry of the POST** | — | — | **ruled out**: `fetchWithRetry` gives a non-replay-safe method exactly one attempt (`fetch-retry.ts:79`) |

M1 and M3 are the strongest candidates for thread `bfa55610` (its first run ended "stopped by
analyst"). For `a8643383` the path is **not determinable** from telemetry — request bodies are
not stored.

---

## 5. Persistence semantics under overlap — the checks you asked for

| axis | finding |
|---|---|
| **row ordering (DB)** | correct. `messages` ordered by `created_at`; every row distinct. |
| **row ordering (client store)** | **corrupted** — run 1's completed message is appended after run 2's, under a duplicated id. Reproduced. |
| **tool-call/result pairing** | **broken in the duplicate-id case**, §3. The guard is id-keyed; the validator is positional. |
| **lost update** | none. `messages` has only `messages_pkey` + `messages_thread_id_fkey` — no unique constraint, no version column, no trigger. The write is a bare `.insert(...)`: **append-only, uncoordinated, duplicative-capable, never overwriting.** |
| **retries** | not an overlap source (M4 above). |
| **cost accounting** | **correct, and that is the problem.** `increment_thread_cost` is atomic, so every overlapping run is charged in full. The four overlapping runs on `a8643383` cost **524,036 µUSD (~$0.52) in 5 minutes**. In the overlap window, 25 tool calls, 0 cached, **3 repeat calls** on identical `tool_name + input`. Overlap buys duplicate work at full price. |
| **what the UI shows** | inconsistent. `useThreadMessages` has **no realtime subscription**, but `useThreadArtifacts`, `useThreadToolActivity`, `useThreadToolHealth` and `useThreadQueriedTargets` all subscribe to `postgres_changes`. So during overlap the Evidence board and tool activity update live from **both** runs while the transcript shows only the local one — artifacts appear that the visible transcript never accounts for. There is no "another run is active on this thread" indicator anywhere. |

---

## 6. The contract — what a follow-up turn should see

Stated as acceptance criteria, so a design can be tested against it:

- **C1 — Causal completeness.** A turn's model context contains every tool-call issued by
  earlier accepted turns *together with its result*, or an explicit, honest marker that the
  result is unavailable. Never a bare tool-call, and never a result attributed to a call the
  model cannot see.
- **C2 — Positional validity.** The `ModelMessage[]` handed to `streamText` passes the SDK's
  in-order pairing check for every prefix. A tool-call id appears at most once.
- **C3 — Monotonic history.** The client store's order matches `created_at` order in the DB,
  and no message id appears twice.
- **C4 — No silent loss of analyst input.** A message typed during a run is never dropped and
  never requires re-typing.
- **C5 — Truthful liveness.** If a run is active on the thread, every surface says so —
  including a second tab.
- **C6 — Bounded duplicate spend.** Two runs on one thread must not pay twice for the same
  `tool_name + input`.
- **C7 — Honest failure.** If the history cannot be made valid, the run is labelled
  Interrupted (invariant I-2), never presented as a completed report.

Today: C1 ✗, C2 ✗, C3 ✗, C5 ✗, C6 ✗. C4 ✓. C7 ✓ by inheritance from the existing invariant.

---

## 7. Three approaches

I did **not** rule out queued execution on "the analyst must keep typing" grounds — that
objection applies to blocking *input*, not to deferring *execution*, and the distinction is
the whole point of option A.

### A — Accept the message, queue the execution

The composer always accepts. If a run is live on the thread, the new turn is enqueued and
starts when the current run finishes, from the persisted, complete history.

- **C1 ✓ C2 ✓ C3 ✓ C4 ✓ C6 ✓** — the queued turn starts from committed state, so there is no
  partial snapshot and no duplicate id to sanitize.
- Needs a real liveness signal, and **one already exists**: `threads.last_heartbeat_at`, whose
  header states liveness is decided by the heartbeat alone and that `status='active'` is not
  evidence. The lease can be built on the instrument the repo already trusts.
- Costs: a queue table or a `threads.pending_turn`; a "queued — will run after the current
  step" affordance; a drain path that survives an isolate dying mid-run (the heartbeat gives
  the staleness test); a decision on whether Stop cancels the queue.
- Risk: a wedged lease blocks the thread. Mitigated by the same staleness rule the health
  sweep already applies, and by a kill switch.
- Honest cost: it makes a follow-up feel slower — it waits. That is a real product cost and
  the main argument against.

### B — Explicit history snapshot + branch reconciliation

Each run declares the history version it started from; overlapping runs produce branches that
are reconciled on write.

- Fixes C1/C2 at the root by making "what did it see" explicit and auditable — genuinely
  attractive for a forensic product, and it composes with the `run_id` the lineage work needs.
- But reconciliation has **no defined answer here**: two runs that both called `exa_search`
  and both persisted artifacts produce a branch the analyst must adjudicate, and the product
  has no merge UI. C3 becomes a presentation problem rather than a fixed invariant, and C6 is
  unaddressed — both branches were already paid for.
- Largest change of the three, on the serialized edge channel.

### C — Safe incremental snapshots

Persist the in-flight assistant message incrementally so a second run reads a complete-as-of-T
history rather than a partial one.

- Some machinery exists (`incremental-persist.ts` writes text-only checkpoints, W2 in the
  earlier scope), so this looks cheap.
- It is not. It narrows M2's window but does not close M1: a snapshot taken between a
  tool-call and its result is **still** an unpaired call, so C2 fails exactly as today. It
  makes the corrupt state *more durable* by writing it to the DB, which today is the clean
  layer that heals on reload. And it does nothing for C6.
- **Rejected on the evidence**, not on taste: it converts a client-only defect into a
  persisted one.

---

## 8. Recommendation — A, with a scoped prerequisite

**Take A (accept-and-queue), and ship it in this order:**

| # | PR | why first |
|---|---|---|
| 0 | **`capTotalToBudget` hard ceiling (your PR-A)** | independent, already agreed |
| 1 | **Make `sanitizeModelMessages` positional** — resolve tool-call ids per position, not globally; every unpaired call gets its placeholder | the **only** change that stops the observed production wedge, it is small, it is pure-function testable, and it helps even if A never ships |
| 2 | **Liveness + queued turn** on `last_heartbeat_at`, behind a kill switch, with a new `/health` key | the behaviour change |
| 3 | **Overlap-aware UI** — "a run is active on this thread" + queued-turn affordance (frontend, separate channel) | C5 |

PR 1 is the one I would not delay. It is the difference between "an overlap costs money" and
"an overlap wedges the thread until the analyst reloads", and it is independent of which
concurrency model you pick.

### Test plan (focused)

**PR 1 — `message-sanitize` (edge, pure, `message_sanitize_test.ts`):**
- duplicate tool-call id, result present only for the later one → **both** calls paired; the
  earlier gets the placeholder. *Fails today.*
- the exact reproduced array → `streamText` with a mock model completes instead of throwing
  `MissingToolResultsError`. Drives the shipped path, does not re-describe it.
- a well-formed array is returned **byte-identical** (no behaviour change in the common case).
- an orphaned tool-result (call absent) is still dropped — the existing guarantee.

**PR 2 — queue (edge):**
- send while a live heartbeat exists → the turn is accepted and enqueued, **not** executed;
  one invocation row, not two.
- send while the heartbeat is stale → executes immediately (no permanent wedge).
- queued turn drains from **persisted** history: its `ModelMessage[]` has no `input-available`
  tool part and no duplicate id.
- kill switch on → today's behaviour exactly.
- Stop cancels the queued turn (assert the chosen semantics either way).

**Regression, both:** run-termination invariants I-1/I-2 untouched; `npm run test:e2e` by
hand, since PR CI does not run it.

---

## 9. The `unknown` stop reason — explained, and it is an instrument gap

Not a mystery failure. `deriveStopReason` (`telemetry.ts:114-142`) returns `unknown` when
`finishReason === "tool-calls"` and `budgetExhausted` is falsy — deliberately, with a comment
refusing to name a cause nothing measured.

**`budgetExhausted` is never passed.** The single call site (`telemetry.ts:423`) supplies only
`hadStreamError`, `finalizeStarted` and `lastFinishReason`. So `budget_exhausted` is
**unreachable**, and every tool-calls run that neither stream-errored nor force-finalized is
labelled `unknown` by construction — 4 rows, including your `bd4d1864`.

So `unknown` means "the loop stopped while the model still wanted tools, and no ceiling was
recorded". Which ceiling actually fired is **not knowable from the data as instrumented**.
Another built-and-unwired parameter; a one-line fix at the call site, on its own PR.

---

## 10. Limitations

- **Request bodies are not stored.** For `a8643383` specifically I cannot say whether
  `e8ed6b17` saw partial or absent output — only that the mechanism produces one or the other.
  The specific bytes are unrecoverable. Naming which of M1/M2/M3 produced those four sends
  would be a guess.
- The reproduction drives the real SDK but a **fake transport**. It establishes client-store
  and message-shape behaviour, not edge-runtime behaviour under concurrency.
- The wedge test used `MockLanguageModelV3`; the throw comes from the SDK's own validator
  before any provider call, so the provider is not a variable — but I did not exercise the
  live Z.AI path.
- Overlap counts come from `orchestrator_invocations`, which starts **2026-09-11**. The 12.2%
  rate covers 8 days, not the product's life.
- `md5(parts::text)` proves rows differ; it cannot prove two rows do not *describe* the same
  work in different words.
- I did not measure how often an analyst actually hits Stop-then-send versus reloading — the
  relative weight of M1 vs M2 is unknown, and it would change PR 2's affordance design.
