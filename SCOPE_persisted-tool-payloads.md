# Scope — persisted tool-call/tool-result payloads, prompt hard-bound, same-thread overlap
**Read-only pass, 2026-09-19. No code written. `main` = `ad4937bc`; live edge `4bb19d9`; #602/#603 unmerged.**

Out of scope by instruction: Gemini `Bad Request` fallback, finalize deadline enforcement,
selector/evidence-authority work.

---

## 0. The result that should drive the design

**`tool_usage_log` has no output column.** Columns are exactly:
`id, user_id, thread_id, tool_name, cost_micro_usd, cached, ok, duration_ms, created_at,
error_msg, status_code, input_json, charged_micro_usd, outcome`.

It stores the tool's **input**, never its result. So the premise behind
"references + canonical store" is **not satisfied by the current schema**. Detail in §4.

A second, smaller finding of the same kind: `elidedToolResultRef`
(`orchestrator-budget.ts:293`) already tells the model *"full result persisted in the
artifact store, retrieve via memory_recall"*. **No such retrieval path exists** — there is
no artifact store holding raw tool results, and `memory_recall` reads `agent_memory`. The
string is already making the promise this project has not yet built.

---

## 1. Exact files and functions

### Write path (payload → `messages.parts`)
| # | Site | What it writes |
|---|---|---|
| W1 | `index.ts:1540` `persistFinalMessages({messages: finalMessages})` → insert at `index.ts:1772` | **The one that matters.** Full `UIMessage[]` from the SDK, tool-call and tool-result parts with complete `output`. |
| W2 | `incremental-persist.ts:297` (checkpoint insert) | `parts: [{type:"text", …}]` — **text only**, tool-derived prose. No payloads. |
| W3 | `recovery.ts:789` | `parts: [{type:"text", text}]` — the recovered-run note. **Text only.** |
| W4 | `auth.ts:248` | message insert on the auth path. **Text only.** |
| W5 | `ChatWindow.tsx:1575` | client-side user message insert. **Text only** (measured: all 9 user messages on the sample thread total 1,027 chars). |

**Only W1 writes tool payloads.** That is the whole of the growth surface.

### Storage
`public.messages(id, thread_id, user_id, role, parts jsonb, created_at)`. No size cap,
no TTL, no compaction.

### Read path
| # | Site | Uses payload? |
|---|---|---|
| R1 | `ChatWindow.tsx:1293` → `useChat({messages: initial})` → request body → `index.ts:245 convertToModelMessages` | **YES — this is continuation context.** |
| R2 | `ChatWindow.tsx:460-461` raw-output viewer (`safeStringify(part.output)` + copy) | **YES — full raw payload, analyst-facing.** |
| R3 | `intel.ts:1109-1140` failures register | **PARTIAL** — `deriveToolReason(p.output)`, stores `output: p.output` (`:1130`), and `list_tools` → `disabled_tools` (`:1139`). |
| R4 | `useThreadMessages.ts:82-124` activity feed | **DERIVED ONLY** — `outputLooksLikeReport`, `resultSummaryFor`, error detection. |
| R5 | `ChatWindow.tsx:319-335, 548-553` tool cards | **DERIVED ONLY** — `deriveToolCharge`, `deriveToolPreview`, `deriveToolRuntime`, `_cached`. |
| R6 | `incremental-persist.ts:392 loadSeenCheckpoints` | **NO** — reads checkpoint keys from text parts. |
| R7 | `recovery.ts:616, 741` | **NO** — reads the latest assistant message for report-shape/recency. |
| R8 | `chat-checkpoints.ts:44` | **NO** — presence of tool parts only. |
| R9 | `src/lib/mcp/tools/get-investigation.ts:48` `select("*")` | **UNBOUNDED** — external MCP consumer, returns whole rows. |
| — | `evidence-export` | **does not read `messages` at all** (grep empty). Exports come from artifacts/evidence_log. |

**Dataflow, stated plainly:** the payloads are persisted server-side by W1, **downloaded in
full to the browser** by R1, and **uploaded back in the request body** on every follow-up.
The edge function never reloads history from the DB for context — the client supplies it.
So the 431k of thread state on the sample thread is paid three times per turn: DB read,
wire down, wire up. That also makes this a direct contributor to the mobile slowness in #602's
territory, though the two fixes stay separate.

---

## 2. Consumers that break under reference-only persistence

**Hard blockers (need the raw payload):**
- **R2, the raw-output viewer.** An analyst can open any tool call and read/copy its full
  output. Reference-only silently guts a forensic affordance. Needs either a fetch-on-demand
  path or an explicit "payload not retained" state.
- **R1, continuation context.** Partially — see the constraint below.
- **R3's `output: p.output`** into the failures register.

**Safe (derived fields only):** R4, R5, R6, R7, R8. Each needs `toolName`, status/`ok`,
`errorText`/reason, `_cached`/`cache_layer`, cost, and a short preview — **all of which
`tool_usage_log` already stores** (`outcome`, `ok`, `status_code`, `error_msg`, `cached`,
`cost_micro_usd`, `duration_ms`).

**Unknown-risk:** R9 (`select("*")`) is an external MCP surface; its consumers are outside
this repo's tests.

### Two hard constraints on any reference shape
1. **Never drop a tool-result part.** `mem://architecture/ai-sdk-positional-tool-pairing`:
   the SDK's tool-call↔result pairing is **positional**, and `MissingToolResultsError`
   can wedge a thread permanently. Shrink the value; never remove the part.
2. **Preserve the output discriminator.** `capTotalToBudget` already documents this
   (`orchestrator-budget.ts:365-377`): the AI SDK validates `output` against a typed union
   (`{type:'json'|'text'|…, value}`); a bare `{value}` fails schema and aborts the run.
   **This is also the precedent that a reference value is accepted** — that swap runs in
   production today.

---

## 3. Same-thread concurrency (08:50:17 / 08:50:26)

**Mechanism — and it is deliberate, not a bug in itself.** `index.ts:404-410` states it
outright: *"A double-submit / retry can start a second overlapping run for the same threadId
(setupRequest verifies ownership but **does not lock out an active run**)"*. `circuit.acquire`
/ `release()` is refcounted so the first run to finish cannot wipe a sibling's suppressions.

So: **there is no server-side lease on a thread run, by design.**

What that means for persistence:
- `persistFinalMessages` guards with `if (finalPersisted) return;` — a **closure-local**
  flag, per invocation. It does **not** coordinate across overlapping runs.
- `messages` is INSERT-only on this path. So overlap **duplicates**, it does not overwrite.
  Confirmed on the sample thread: assistant rows at `08:50:11` (23,134 chars) and
  `08:50:22` (18,712 chars) — two runs, two full message rows, 11s apart.
- Client-side, `submitLockRef` (`ChatWindow.tsx:1396`) is a synchronous re-entrancy lock
  that only covers rapid double-click **within one mounted component**. It does not cover a
  second tab, a reload mid-stream, or a retry after a perceived stall — which is exactly the
  behaviour a 180s run invites.
- Cost accounting *is* protected (`index.ts:509`, atomic `increment_thread_cost` RPC
  precisely so "concurrent runs on the same thread don't overwrite each other's running
  totals"). Message persistence has no equivalent.

**Verdict:** overlap amplifies persistence growth (each run appends a full payload-bearing
message) and is a plausible contributor to the `stop_reason:"unknown"` / 2-step / 313-token
run at 08:50:26. It is a **separate defect** from context growth and should not be folded
into the persistence change. No evidence of message *overwrite*; the risk is duplication and
divergence between the client `useChat` store and the DB (ChatWindow already carries cleanup
that deletes rows — `:2133`, `:2141`, `:2265`).

---

## 4. Reconstruction gaps — can artifacts + tool_usage_log serve as canonical store?

**No. Not for any call, and least of all for the categories named.**

| store | has payload? | keyed by call? | durable? |
|---|---|---|---|
| `tool_usage_log` | **NO** — `input_json` only | no `call_id` | yes (3 months) |
| `tool_call_cache` | **`output_json` YES** | `input_hash`/`params_hash`, not a call | **NO** — `expires_at`, `stale` flag; all 12,548 rows currently expired |
| `evidence_log` | `content_snapshot`, `archive_storage_path`, `archive_sha256` | via `artifact_id` | yes, hash-chained |
| `artifacts` | extracted entities only | no call key (`metadata.tool` = name, on ~34–38% of rows) | yes |

Per category JD named:
- **zero-result call** → `tool_usage_log` row (`outcome='empty'`), **no payload anywhere**.
- **error call** → `error_msg` + `status_code`, **no payload**.
- **skipped/gated call** → `outcome='skipped'`, **no payload**.
- **non-artifact-producing success** → `outcome='ok'`, **no payload**; no `evidence_log` row
  because that table hangs off `artifact_id`.
- **artifact-producing success** → `evidence_log.content_snapshot` may hold the *evidence*
  content, but it is per-artifact, not the tool's full result envelope, and cannot be joined
  back to the specific call.

**Consequence for sequencing:** a reference-only design needs a payload store that does not
exist, keyed by a `call_id` that does not exist. That is the **same missing primitive** as
the documented `artifact_tool_lineage` gap. These two should share one schema change rather
than inventing two call identifiers.

---

## 5. Proposed reference shape (design only)

Keep the part, shrink the value, preserve the discriminator:

```
output: { ...originalOutput, value: {
  __ref: "tool_payload",
  call_id: "<uuid>",          // new, shared with the lineage work
  tool: "<toolName>",
  bytes: <number>,
  status: "ok"|"empty"|"failed"|"skipped",
  summary: "<bounded, ≤N chars>",
  retained: true|false        // honest when no payload was stored
}}
```

`retained:false` is the load-bearing field: it lets the UI say "payload not retained"
instead of implying a fetch that will 404 — the mistake `elidedToolResultRef`'s current
text already makes.

Payload store options, in preference order:
1. **Supabase Storage object keyed by `call_id`**, with `tool_usage_log.payload_path` +
   `payload_sha256`. Keeps a large blob out of Postgres; matches the existing
   `archive_storage_path`/`archive_sha256` pattern in `evidence_log`.
2. A `tool_call_payloads` table with an explicit retention policy.
3. **No store; summary-only** — cheapest, and honest if `retained:false` is surfaced. Loses
   R2's raw-output viewer for historical calls.

**Option 3 is viable and should be costed before building 1**, because the raw-output viewer
is the only hard consumer and JD may accept losing it for old turns.

---

## 6. Separate minimal fix — make `TOTAL_PROMPT_CHAR_BUDGET` a true ceiling

**Defect, exactly.** `capTotalToBudget` (`orchestrator-budget.ts:344`):
```
const cutoff = Math.max(0, out.length - keepRecent);   // keepRecent = 8
for (let i = 0; i < cutoff; i++) { if (total <= budget) break; … }
```
Only messages **before the last 8** are elidable. Once the protected tail alone exceeds
220,000 chars, the function returns over budget and reports no error.

**Measured, same thread:** `max(orchestrator_step_metrics.context_chars)` per invocation ran
218,535 → 219,862 → **252,991** → **259,975** against a 220,000 budget. One persisted
assistant message on that thread is **99,887 chars** — 45% of the whole budget in a single
protected message.

**Fix shape (not written):** after the existing pass, if still over budget, continue eliding
**into** the recent window — newest-last — with a floor that always preserves the final
user message and every tool-result part's *existence* and discriminator (constraint §2.1).
`elidedToolResultRef` already supplies the replacement value.

**Acceptance:** `for every prepared step, contextCharsFromMessages(stepMessagesOut) ≤ TOTAL_PROMPT_CHAR_BUDGET`.
Tests belong in `orchestrator_budget_test.ts` (exists, already covers this function):
- one recent message of ~100k chars + 7 more recent → result ≤ 220,000;
- a single message larger than the whole budget → still ≤ budget, still parses as
  `ModelMessage[]`, tool-call/result pairing intact;
- every tool-call part still has its matching tool-result part (positional-pairing guard);
- a run already under budget is returned **byte-identical** (no behaviour change in the
  common case).

This fix is **independent of persistence** and can ship first.

---

## 7. Migration / backward compatibility

- Existing rows keep full payloads. Any reader must handle **both** shapes: legacy inline
  `output.value` and `{__ref:"tool_payload", …}`. A type guard in one shared helper, used by
  R1–R5, not duplicated per call site.
- **No backfill.** Rewriting historical `messages.parts` would break the hash-chain reasoning
  people rely on for chain-of-custody and is irreversible. New writes only.
- `get-investigation.ts` (R9, `select("*")`) changes shape for external MCP consumers —
  needs an explicit decision, not a silent change.
- The `call_id` column must land **before** any code reads it (schema first, through Lovable,
  verified against the live DB — the live migration ledger tops out at `20260825024640` and
  does not list applied migrations, so `pg_indexes`/`information_schema` is the only proof).

---

## 8. Acceptance criteria

**Prompt bound (fix 1):** `max(orchestrator_step_metrics.context_chars) ≤ 220,000` across all
steps, measured over a week of production. Currently violated by up to ~40k and rising.

**Persistence bound (fix 2), using JD's invariant:** *bytes in `messages.parts` attributable
to raw tool-result payloads are bounded independently of cumulative tool-call count, and the
canonical full output remains retrievable from its durable source (or is honestly marked
`retained:false`).* Measurable directly:
```
sum(length(p::text)) for jsonb_array_elements(parts) p where p->>'type' like 'tool-%'
```
On the sample thread this is **349,547 of 431,421 chars — 81%** — against 1,027 chars of
analyst input. Post-fix it should be flat in tool-call count.

**Concurrency (fix 3):** decide whether overlap is permitted; if yes, message persistence
needs the same treatment cost accounting already got.

---

## 9. Smallest safe PR sequence

1. **PR-A (edge, no schema):** `capTotalToBudget` hard ceiling + tests. Independent, revertible,
   adds a durable log event or `/health` key per repo rule. **Ship first.**
2. **PR-B (read-only instrumentation, frontend or edge):** persist/emit the per-thread
   tool-payload byte share so the §8 invariant is measurable before and after. Cheap, proves
   the problem stays fixed.
3. **DECISION (no code):** payload store (option 1/2) vs summary-only (option 3). Blocks C.
4. **PR-C (schema only, through Lovable, verified live):** `call_id` on `tool_usage_log`
   (+ payload columns if option 1/2). Shared with the lineage work — do not invent a second id.
5. **PR-D (edge):** write the reference shape behind a kill switch, new writes only.
6. **PR-E (frontend):** dual-shape readers + honest `retained:false` UI.
7. **PR-F (separate track):** same-thread overlap.

Never mix frontend and edge in one PR; at most one edge PR in flight.

---

## 10. Limitations

- Sample is one thread (`a8643383`, 9 invocations, 18 messages, 96 artifacts, 67 tool calls
  since 08:30). Byte shares are from that thread; the 81% figure should be re-measured
  across threads before it is quoted as a general constant.
- I did not trace consumers of `get-investigation.ts` (outside this repo).
- I did not reproduce the 08:50:26 `stop_reason:"unknown"` run; the overlap is established
  from timestamps and the two persisted assistant rows, and the *absence of a lease* is
  established from code — the causal link between overlap and that specific run is **not** proven.
- No code was written and nothing was pushed.
