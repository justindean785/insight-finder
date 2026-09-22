# Pricing — payload store vs summary-only

**Read-only measurement pass, 2026-09-19T18:0xZ. No code written, nothing pushed.**
`main` = `ad4937bc` · live edge `4bb19d9` · #602/#603 still unmerged drafts.
All figures from the live DB (`messages`, `tool_call_cache`, `tool_usage_log`,
`orchestrator_step_metrics`, `storage.objects`) via read-only SELECTs.

---

## 0. Headline

**The pricing came out lopsided, and it moved the question.**

Storage cost is not the deciding factor — a payload store for the product's entire
lifetime is **18.9 MB**. The deciding factor is that **persisting raw payloads costs
nothing in prompt size**, because the server already re-truncates everything the client
sends, on arrival, four different ways. So the persistence change is a **wire-and-storage**
fix, not a prompt-budget fix, and it is worth much less than I implied when I scoped it.

Second: **neither option satisfies the invariant you stated.** A per-payload cap and a
per-payload reference are both O(n) in tool-call count. Only an *aggregate* per-thread
payload budget is O(1) — and that costs the same under either option.

Recommendation at the bottom. Short version: **A-lite** (summary-only + aggregate budget,
no new store), and it should ship **after** PR-A, not before.

---

## 1. What the corpus actually is

| measure | value |
|---|---|
| `messages` rows / threads | 2,104 / 250 (since 2026-07-05) |
| total `parts` text | **44 MB** (45,676,175 chars) — on disk 27 MB (jsonb compresses) |
| tool parts | 9,320 parts, 37,487,337 chars = **82.4% of all message bytes** |
| of a tool part: `output` | 31,446,368 chars = **83.9%** of tool-part bytes, **68.8% of the whole corpus** |
| of a tool part: `input` | 4,385,736 chars (11.7%) |
| output size p50 / p95 / max | **837** / 15,594 / 605,427 chars |
| tool parts per thread p50 / p90 / max | 32 / 98 / **218** |
| thread bytes p50 / p90 / p99 / max | 114,590 / 431,421 / 828,503 / **1,999,356** |
| threads already over the 220k budget | **73 of 250 (29%)** |
| growth | ~3–5 MB/week; 3,559 tool calls in the last 30 days |

**The distribution is the story.** The median tool result is 837 chars. The problem is
entirely in the tail and in the *count*.

---

## 2. The finding that changes the question

`index.ts:244–323` already truncates inbound history on **every request**, before the model
sees anything:

1. `MAX_TOOL_RESULT_CHARS_OLD = 1500` for everything outside the recent window
2. `MAX_TOOL_RESULT_CHARS_RECENT = 16000` inside it
3. older results go through `summarizeToolResultValue` — **selector-preserving**, not a slice
4. `capTotalToBudget(…, 220_000, RECENT_WINDOW)` then bounds the array
5. a final `capToolResultOutputs(…, MAX_TOOL_RESULT_CHARS = 8000)`

`prepareStep` (`:942`) repeats 1–3 per step.

**So a 605,427-char persisted payload reaches the model as ≤16,000 chars today.** Shrinking
what we persist would change the prompt by approximately nothing. What persisting raw
payloads actually costs:

| cost | measured |
|---|---|
| DB | 27 MB on disk, growing ~3–5 MB/week |
| **wire down** | client loads *all* messages with full parts (`ChatWindow.tsx:1293`) |
| **wire up** | `DefaultChatTransport` (`:1475`) has no `prepareSendMessagesRequest`, so the **entire history is re-uploaded in the request body every turn** — 431 KB at p90, 2.0 MB worst case, from a phone |
| prompt | **zero** — see above |

The wire-up number is the one an analyst feels, and it is a *different* stall from the render
backpressure #602 fixes. I had this folded into the prompt-budget argument when I scoped it;
that was wrong, and it is the main correction here.

The prompt-side defect is real but separate: **68 of 779 steps (8.7%) exceeded 220k, max
290,961** — and that meter is `approxPromptChars`, the documented undercount, so it is a
floor. That is PR-A (`capTotalToBudget`'s protected tail), and it is unaffected by either
option priced here.

---

## 3. Does the option satisfy your invariant?

> *persisted message bytes attributable to raw tool-result payloads are bounded independently
> of cumulative tool-call count, while the canonical full output remains retrievable from its
> durable source.*

Simulated against the real corpus:

| shape | payload bytes | threads still >220k | max thread | invariant |
|---|---|---|---|---|
| today | — | 73 | 1,999,356 | ✗ |
| per-payload cap 8,000 | O(n·8k) | 55 | 706,712 | **✗ — O(n)** |
| per-payload cap 2,000 | O(n·2k) | 32 | 557,423 | **✗ — O(n)** |
| per-payload reference ~250 | O(n·250) | 14 | 430,336 | **✗ — O(n)**, just 32× slower |
| **aggregate 120k/thread, newest kept** | **O(1)** | 48 | 428,503 | **✓ for the payload term** |

Two things fall out:

- **A per-item cap never bounds a thread.** 218 tool parts × any constant is still linear.
  Only the aggregate budget is O(1), and it is the *same work* whether the displaced bytes
  go to a store or to nothing.
- **No persistence change gets the worst threads under 220k**, because the residual is
  tool-part *inputs* + scaffolding (6.0M chars, 13%) and the model's own text (8.05M, 17.6%).
  Thread `92a7d650` is 95% tool bytes across 218 parts; bounded payloads still leave ~430k.
  **The 220k ceiling must come from PR-A. Do not expect persistence to deliver it.**

---

## 4. The two options, priced

Both write the same thing into the message. They differ **only** in whether the displaced
bytes are recoverable. Byte savings, wire savings and prompt effect are **identical**.

### Option A — payload store (Supabase Storage, keyed by `call_id`)

| | |
|---|---|
| storage, over-cap payloads only (>8k) | **1,015 objects / 18.9 MB** for the entire product lifetime |
| storage, every payload | 9,320 objects / 30.0 MB lifetime ≈ 12 MB/month |
| $ | negligible — 1 GB free tier; paid is ~$0.021/GB/mo |
| bucket | **exists** — private `evidence-archive` since 2026-05-28, with RLS policies (`Owners read archived evidence`, owner update/delete) |
| precedent code | `archiver.ts:130` already calls `supabaseAdmin.storage.from("evidence-archive").upload(...)` |
| ⚠️ **but** | the bucket holds **0 objects**, and **0 of 11,364 `evidence_log` rows** have `archive_storage_path`. Only 9 of 257 threads have `archive_attachments` on, and the writer is best-effort/never-throws. **This path has never successfully written an object in production.** Treat it as a template, not as proven machinery. |
| new schema | `call_id` on `tool_usage_log` + `payload_path`/`payload_sha256` — a Lovable-channel migration verified against the live DB, *before* any code reads it |
| new read path | signed-URL fetch in the drawer; the bucket is private and the frontend uses the user client |
| retention | needs an explicit policy, or it is the `tool_call_cache` situation again |
| **PR count** | **~4** on the serialized edge channel (schema · write behind a kill switch + `/health` key · dual-shape readers · frontend fetch), plus a retention decision |

### Option C — summary-only, `retained: false`

| | |
|---|---|
| storage | **0** |
| new schema | none |
| new read path | none |
| **PR count** | **~2** (write behind a kill switch + `/health` key · dual-shape readers) |
| what is lost | the raw-output viewer (`ChatWindow.tsx:460`) for payloads above the cap |
| how much is lost | at an 8,000 cap: **1,015 of 9,320 tool calls — 10.9%**. 89.1% of calls are unaffected because their whole output is under the cap. At a 2,000 cap: 33.4%. |
| concentration | the over-cap set is 6 tools: `exa_search` (23.5% of reclaim), `socialfetch_lookup` (20.5%), `jina_reader_scrape` (12.4%), `list_tools` (12.0%), `oathnet_lookup` (9.9%), `rapidapi_breach_search` (7.2%) |

**`list_tools` at 12% of the reclaim is free money and not a design question** — 38 parts
averaging 45,142 chars, i.e. the tool catalog echoed back into the transcript. That is waste
under any option.

### The honest state of "retrievable from a durable source"

| store | has the payload | keyed by call | durable |
|---|---|---|---|
| `tool_usage_log` | **no** (`input_json` only) | no | yes, 3 months |
| `tool_call_cache` | **yes** (`output_json`) | no — `input_hash`/`params_hash` | **accidentally** |
| `evidence_log` | `content_snapshot`, per-artifact | via `artifact_id` | yes |
| `artifacts` | extracted entities only | no | yes |

`tool_call_cache` is the largest table in the database at **47 MB / 12,701 rows back to
2026-06-25, of which only 129 are unexpired** — it retains every output because
`CACHE_SWEEP_ENABLED` is OFF. It covers 88 of 102 tools. **Do not treat that as the durable
source:** it is keyed by input hash rather than by call, carries no `thread_id`, and exists
only until someone flips the switch the codebase already says should be flipped. Relying on
it is relying on a known bug staying unfixed.

So today, **Option C is what is already true** — the raw payload has no durable source
outside `messages` itself. Option A's real product is *creating* one.

---

## 5. Two cheaper things the measurements surfaced

**D — stop re-uploading history (frontend only).** The server re-truncates everything on
arrival, so uploading 431 KB of raw payload per turn buys nothing. A
`prepareSendMessagesRequest` on `DefaultChatTransport` would cut the wire-up cost with **no
schema, no storage, no edge deploy, and no loss of the raw-output viewer** — payloads stay in
the DB untouched. ⚠️ One real hazard: the server's older-message path uses
`summarizeToolResultValue` (`message-sanitize.ts:97`, edge-only, selector-preserving). A
naive client-side slice would feed that summarizer pre-truncated input and could drop
pivot-able selectors. So it is only safe for the *recent* window (raw `truncateValue`) or by
sending references the server can rehydrate — which needs Option A after all. **Cheap version
is real but narrower than it first looks.**

**E — load history server-side.** Have the run read `messages` by `threadId` instead of
trusting the client body. Eliminates wire-up entirely, keeps full fidelity for the summarizer,
and **subsumes the stale-read concurrency defect (#3)** — each run would read current DB state
rather than a snapshot the client took before the previous run persisted. Larger edge change,
real regression risk around optimistic UI. Worth naming now because it changes what #3 is
worth scoping.

---

## 6. Recommendation

**Order:**

1. **PR-A — `capTotalToBudget` hard ceiling.** Independent, frontend-free, pins the only
   prompt-side violation actually measured (8.7% of steps, max 290,961). Nothing here
   depends on it and it depends on nothing.
2. **`list_tools` stops echoing the catalog into the transcript.** 12% of the reclaim, no
   design decision attached.
3. **Option C + the aggregate per-thread payload budget** — "A-lite". This is the pick.
   The aggregate budget is the only shape that satisfies your invariant; `retained:false`
   states honestly what happened; 89.1% of calls keep their full output; ~2 PRs.
4. **Defer Option A** until something demands it. Its only product is raw retrievability for
   the 10.9% tail, and I **cannot measure whether anyone has ever opened that viewer** — there
   is no frontend telemetry for it. Build it when a case needs it, on a `call_id` that the
   `artifact_tool_lineage` work has to introduce anyway. Building it now spends 4 edge PRs on
   an unmeasured benefit.

The design stays forward-compatible: `retained:false` today becomes `retained:true` +
`payload_path` later without a second migration, and no backfill either way.

**The one thing that would flip me to Option A now:** if you have opened a raw tool output in
the drawer to settle an evidence question — even once — say so and I will price A as the
default instead. That is a question about your workflow that no query can answer.

---

## 7. Limitations

- No instrumentation exists for raw-output-viewer usage. The central benefit of Option A is
  **unmeasured**, and I am not going to estimate it.
- `orchestrator_step_metrics.context_chars` is fed by `approxPromptChars`, the documented
  undercount (omits the workflow addendum, analyst-decisions block, per-step directives and
  every tool schema). The 8.7%-over figure is a **floor**.
- Cache coverage (88/102 tools, 12,701 vs 13,361 rows) is a count comparison, **not a join** —
  there is no `call_id` to join on. That is the same missing primitive as the lineage gap.
- Simulations replay the historical corpus. They bound what the shapes *would have* produced;
  they do not predict a differently-behaving agent.
- Byte figures are `length(parts::text)` — chars, matching the prompt budget and wire cost.
  On-disk jsonb is smaller (27 MB vs 44 MB).
- `get-investigation.ts` (`select("*")`, external MCP surface) changes shape under any option
  and still needs an explicit decision.
