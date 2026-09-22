# Design — Option A, the payload store

**Design only, 2026-09-19. No code written for this. PR-A is shipped separately as #604 (draft).**
Recalculated against the live DB as instructed.

---

## 1. Your correction was right, and it changes the store shape

You asked me to recompute after applying the aggregate budget rather than quoting the
>8,000-char figure. Doing so moves the estimate **4.5× in object count and DOWN in bytes**,
because the two criteria select different payloads: the >8k cut takes the *biggest*
regardless of age, the aggregate budget takes the *oldest* regardless of size.

At a **120,000-char per-thread inline payload budget, newest kept**:

| | >8k cut (what I quoted) | aggregate budget (correct) |
|---|---|---|
| objects | 1,015 (10.9% of payloads) | **4,549 (48.8%)** |
| bytes | 18.9 MB | **14.0 MB** |
| of which under 8k | — | **4,147 objects / 5.48 MB — 91% of the displaced set** |

Sensitivity, so the budget is a dial and not a guess:

| inline budget | objects | store | corpus saved | threads still >220k (of 250) |
|---|---|---|---|---|
| 60,000 | 6,795 (72.9%) | 21.1 MB | — | — |
| **120,000** | **4,549 (48.8%)** | **14.0 MB** | **30.0%** | 48 (from 73) |
| 200,000 | 2,493 (26.7%) | 8.4 MB | — | — |

Lifetime figures over ~2.5 months of corpus ⇒ roughly **1,800 rows / 5.6 MB per month**,
~67 MB/year at current single-analyst volume.

### The distribution says "table", not "bucket"

Displaced payloads at the 120k budget: **p50 = 812 chars**, p90 = 6,334, p99 = 29,862,
max 605,427. **Only 2 objects exceed 256 KB. None exceeds 1 MB.**

That is not object-store material. 4,549 rows averaging ~3 KB is an ordinary Postgres
table — `tool_call_cache` is already 47 MB and 12,701 rows in this same database. Storing
812-char payloads as individual bucket objects buys per-object overhead and a second
authorization surface for nothing.

**So: `tool_call_payloads` as a table, with Storage held in reserve for genuinely large
payloads (>256 KB, i.e. 2 rows in the product's lifetime) and not built now.**

This is a real de-risking of your own instruction. You said to treat the archive bucket as
unproven until upload, retrieval, authorization and failure handling pass an end-to-end
test — and it *is* unproven: **0 objects in `evidence-archive`, 0 of 11,364 `evidence_log`
rows carrying `archive_storage_path`**, with only 9 of 257 threads having
`archive_attachments` on. Choosing a table takes that unproven path off the critical path
entirely. The E2E gate still applies, but to a table, where this repo has RLS precedent
instead of one never-exercised `storage.upload` call.

---

## 2. Shape

### Schema (migration first, through Lovable, verified against the live DB)

```
tool_call_payloads
  call_id      uuid  primary key     -- the shared key, see below
  thread_id    uuid  not null references threads(id) on delete cascade
  user_id      uuid  not null
  tool_name    text  not null
  output_json  jsonb not null        -- the full, unelided tool result
  bytes        integer not null
  sha256       text  not null
  created_at   timestamptz default now()
```

RLS: owner-read only, matching the existing `auth.uid() = user_id` pattern. Writes are
service-role from the edge function.

`call_id` is **the same identifier the lineage work needs** — CLAUDE.md already specifies
`run_id` + a stable `call_id` on `tool_usage_log` plus an `artifact_tool_lineage` junction
table. One identifier, introduced once, used by both. Not two.

⚠️ **Never an array of ids on the call row.** That is the shape that broke the cache sweep:
PostgREST renders `.in()` into the URL query string, and ~5,000 uuids is a ~185 KB URL
against a ~24 KB gateway cap.

### The persisted reference

```jsonc
output: { ...originalOutput, value: {
  __ref: "tool_payload",
  call_id: "…", tool: "exa_search", bytes: 41337,
  status: "ok" | "empty" | "failed" | "skipped",
  summary: "<bounded, selector-preserving>",
  retained: true | false
}}
```

Two things that must not be simplified later:

- **Spread the original output, swap only `value`.** The AI SDK validates `output` against a
  typed union; a bare `{ value }` fails the schema and aborts the run. `capTotalToBudget`
  already does exactly this and that swap runs in production today — it is the precedent
  that a reference value is accepted.
- **`retained: false` is load-bearing.** It is what lets the drawer say "payload not
  retained" instead of implying a fetch that will 404. `elidedToolResultRef` already makes
  that false promise today — its text says *"full result persisted in the artifact store,
  retrieve via memory_recall"* and **no such retrieval path exists**. Fixing that string is
  part of this work, not a separate tidy-up.

### The drawer

`ChatWindow.tsx:460` currently does `safeStringify(part.output)` + copy. It becomes:

- reference with `retained: true` → authenticated fetch-on-demand (a normal PostgREST select
  as the signed-in user, RLS-enforced), rendered identically once loaded, with a loading and
  an error state
- reference with `retained: false` → an explicit "payload not retained" panel naming the
  tool, the byte count and the reason. Never a spinner that never resolves.
- legacy inline output (every row written before this ships) → unchanged

**One shared type guard**, used by every reader, not a shape check duplicated per call site.

### Migration posture

No backfill. Existing rows keep full inline payloads; readers handle both shapes. Rewriting
historical `messages.parts` would be irreversible and would disturb the chain-of-custody
reasoning the product relies on.

---

## 3. The end-to-end gate you asked for

Nothing counts as proven until one test exercises, against the live project, in order:

1. **write** — a run persists a reference; the row exists in `tool_call_payloads` with a
   matching `sha256` and `bytes`
2. **read** — the drawer fetches it back as the owning analyst and the bytes match the hash
3. **authorization** — a *different* authenticated user gets nothing (RLS denies), and an
   anonymous request gets nothing. Both asserted, not assumed.
4. **failure** — the write failing must degrade to `retained: false` with the run
   continuing. A payload-store outage must never fail a run or fail finalize, which is the
   rule that governs every path near finalize in this repo.

Plus the kill switch (`PAYLOAD_STORE_DISABLED`, read at call time) and a new `/health` key,
per the small-PR rules. PR-A's `checks.prompt_budget_ceiling` is this build's proof key; the
payload-store build needs its own.

---

## 4. The limit you asked me to keep visible

**An aggregate inline payload budget bounds inline output bytes. It does not bound the
transcript or the upload.** Measured shares of the 44 MB corpus:

| term | share | elidable by this work? |
|---|---|---|
| tool-result `output` | 68.8% | **yes** |
| tool-part `input` + scaffolding | 13.6% | no |
| assistant/user `text` | 17.6% | no |

Simulated: even replacing **every** payload with a ~250-char reference leaves 14 threads over
220,000 chars and a worst thread at 430,336 — the residual is inputs, scaffolding and text.
So per-thread totals keep growing with turns, just far more slowly.

And the two budgets are different things, which is worth stating plainly because I conflated
them in the original scope:

- **PR-A (#604)** bounds the **prepared model context** — what `streamText` is handed.
- **This work** bounds **persisted inline payload bytes**, which is a DB-size and wire cost.
  The server already re-truncates inbound history four ways (`index.ts:244-323`), so it
  changes the prompt by approximately nothing.

**Request-body size must be measured separately** to verify any phone-upload improvement.
There is no instrument for it today: `DefaultChatTransport` (`ChatWindow.tsx:1475`) has no
`prepareSendMessagesRequest`, so the whole history is re-uploaded every turn, and nothing
records how large that body is. Adding that meter is its own small frontend PR and should
land **before** the payload-store PR, so there is a before/after number instead of an
inference. Baseline to beat, from persisted thread size: p50 114,590 · p90 431,421 ·
p99 828,503 · max 1,999,356 chars per turn.

---

## 5. Ordering

| # | PR | channel | gate |
|---|---|---|---|
| 0 | **#604 — prompt budget hard ceiling** | edge | ✅ open, draft |
| 1 | request-body size meter | frontend | gives the before/after number |
| 2 | `sanitizeModelMessages` positional pairing | edge | stops the production wedge (concurrency §3) |
| 3 | schema: `call_id` on `tool_usage_log` + `tool_call_payloads` | migration | verified against the live DB **before** any code reads it |
| 4 | payload write path + aggregate inline budget | edge | kill switch + `/health` key + the §3 E2E gate |
| 5 | drawer fetch-on-demand + `retained:false` state | frontend | — |

Schema before the code that depends on it; frontend and edge never in one PR; one edge PR in
flight at a time. #602/#603 stay untouched and unmerged.

---

## 6. Open question for you

**The inline budget value.** 120,000 is what I modelled; it is not derived from anything but
the shape of the corpus. 60,000 halves the DB and wire cost and displaces 73% of payloads;
200,000 is conservative and displaces 27%. The tradeoff is how much recent raw detail stays
in the transcript without a fetch — which is an analyst-workflow question, not a storage one.
I'd start at **120,000** and tune once the request-body meter from PR 1 gives a real number.
