# Session handoff — 2026-11-01
## GLM-5.3-flash is live; the real defect found today is `record_finding`

Written at the end of a long session (one compaction). Everything below was
**measured**, not inferred. Re-measure before trusting any number here — that is
this project's standing rule and it caught two of my own wrong claims today.

---

## 1. Production state — verified, not assumed

| | Value | How verified |
|---|---|---|
| Live edge build | **`979f199`** | `/health` `build`, read directly |
| `main` | `13fa3f8` | `git log` |
| `deploy/live` ref | `979f199` | `git ls-remote` |
| Orchestrator model | **`glm-5.3-flash`** (was `glm-5.2`) | `/health` `selected_model` |
| Vendor | `api.z.ai` | `/health` `checks.deepseek.vendor_host` |
| `/health` | 62 checks, **0 not ok** | direct curl |
| `reveal_breach_data` | `true` (unchanged — settled decision) | `/health` |

`checks.glm_thinking_mode` reads:
`glm-5.3-flash @ api.z.ai: thinking=enabled, reasoning_effort=low (model-forced)`

The `checks.deepseek` canary makes a **real paid call** to Z.AI on that model with
thinking enabled and returns ok. That is end-to-end proof the migration works: the
account has the model, the key works for it, and the request shape is accepted.

### What shipped today
- **#938** — the deepseek slot resolves its thinking mode from the model id
  (`lib/glm-thinking.ts`). GLM-5.3 **rejects** `thinking:{type:"disabled"}`, which the
  orchestrator hardcoded in three places; without this, switching the model id would
  have 400'd every run and both `/health` canaries. Also gave salvage the same thinking
  options as the main loop, lifted the probe token ceiling when thinking is on, and
  surfaced `vendor_host` at `/health`.
- **#939** stamp · **#940** ledger. Full `edge-deploy` recipe followed; `record:deploy`
  reports **VERIFIED**.

### Deploy notes for next time
- `ledger_ref_divergence` on the first gate run was a **false alarm** — the sandbox
  clone lacked `refs/heads/deploy/live`. Fetch it first:
  `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`
- The mirror (`seeker-spark-search-5362c57c`) is **not** in a cloud session by default.
  `add_repo` + clone it. It had **zero** Lovable-authored drift in `osint-agent`.
- **Neither Claude nor the Lovable agent can update an existing Supabase secret.** The
  Lovable secrets tool can only *create*. JD changed the model id by hand in
  Project Settings → Secrets.

---

## 2. THE FINDING: `record_finding` is called in 3% of runs

**Measured over 3 days / 60 runs on glm-5.2: `record_finding` was called in 2 runs.
On the first glm-5.3-flash run: 0.**

This is **not** a 5.3 regression — it long predates the switch.

Consequence: reports print a Findings table with `[CONFIRMED]` labels and confidence
numbers (92 / 95 / 90 were observed today on a **named individual with federal criminal
allegations**) that **no scoring engine ever adjudicated**. They are the model's own
prose. The app's disclosure layer does say so — *"Model-adjudicated findings this run: 0
— the model did not call record_finding"* — and that part is working correctly.

This is exactly the hazard CLAUDE.md documents under *"The report layer bypasses the
integrity engine"*, now with a measured rate. The prescribed fix shape is already written
there: expand a `{{FINDINGS_TABLE}}` marker **server-side from persisted rows** before the
message is stored. No markdown parsing of model output. **It must never be able to fail
finalize.** Do not change `confidence.ts` or `record_finding` — they already compute the
right values; nothing carries them to the surface.

**This is the highest-value open defect in the product.** It outranks everything else below.

---

## 3. The cost meter prices every model the same

**Corrected after Codex caught an error in the first draft of this handoff.** My original
claim — "there is no GLM token metering" — was **wrong**. Do not act on it.

GLM step tokens **are** metered. `index.ts` `onStepFinish`, after the Anthropic branch
returns:

```ts
const [inRate, outRate] = useFallback ? [0.3, 2.5] : [0.3, 1.2];
const micro = Math.round(inTok * inRate + outTok * outRate);
if (micro > 0) onCost(micro);
```

Flat micro-USD per token, **hardcoded and model-blind**. So the real defect is mispricing,
not absence — and it points in opposite directions for the two models:

| Model | Meter (in / out, $/MTok) | Actual Z.AI | Effect |
|---|---|---|---|
| `glm-5.2` | 0.30 / 1.20 | 1.40 / 4.40 | **under**-charges ~4.7x in, ~3.7x out |
| `glm-5.3-flash` | 0.30 / 1.20 | 0.15 / 0.50 | **over**-charges 2x in, 2.4x out |

Consequences for reading any figure in §4:
- The glm-5.2 baseline **understates** true model spend by roughly 4x.
- The glm-5.3-flash figure **overstates** it by roughly 2x.
- So the apparent "35% cheaper" badly understates the real saving — the two eras are
  priced on opposite sides of the truth. The honest statement remains: **you cannot read
  the Flash saving out of this app.** Use the Z.AI dashboard.

**A second, genuine gap:** GLM **salvage** tokens are not metered at all. Salvage calls
`generateText`, and the only meter on it is `if (anthropicActive()) meterAnthropicUsage(...)`.
On the GLM path nothing records it — and salvage is 40–60s of generation emitting
44k–124k characters. That spend is invisible.

**For whoever fixes this: do NOT add a new `onCost` feed on the deepseek path.** One
already exists; a second would double-charge. The work is (a) replace the flat rates with
a per-model rate table keyed on the configured model id, in the shape of
`ANTHROPIC_RATES_MICRO_USD_PER_TOKEN` in `costs.ts`, with a deliberately pessimistic
unknown-model fallback and a `/health` `pricing_known` flag as that table already does;
and (b) meter GLM salvage.

## 4. Baselines — use these, not per-case figures

**glm-5.2, 60 runs, 3 days:**

| Metric | Value |
|---|---|
| Tool spend / run | $0.1872 avg (range $0.0000–$0.6615) |
| Duration | 114.7s avg |
| Salvage | 61.2s avg |
| Steps / tools | 7.1 / 11.6 |
| `finalize_forced` | **22 of 60 (37%)** |
| `salvage_outcome: error` | 3 |

**glm-5.3-flash, first run (11:11:06Z), n=1:**

| Metric | Value |
|---|---|
| Duration | 128.5s (`finalize_forced`) |
| Salvage | **none — 0s** |
| Persist | **1.9s** (vs 30–53s on 5.2 salvage runs) |
| Steps / tools | 9 / 16 — *more work than the 5.2 average* |
| Tool spend | $0.1208 (**not** model cost — see §3) |

Slightly slower wall-clock, but it **finalized cleanly instead of falling back to
salvage**. That is the most encouraging signal so far. n=1 — do not generalise.

### A correction to carry forward
Earlier in the session I called "salvage runs with thinking on" a *strong* hypothesis for
the 90s salvage failures and shipped a fix for it in #938. The post-fix data does **not**
support it: 12 pre-fix runs ranged 27.3–90.2s (mean 61.1s); the two post-fix runs were
29.0s and 51.0s — **both inside the old range**, and the fastest run of the whole set was
a pre-fix one. Not refuted, but **not established**. Do not repeat it as fact.

What the data *does* show: salvage is 40–60s of a 90–110s run and emits 44k–124k char
reports. **Report size is a candidate cause of wall-clock pressure in its own right.**

---

## 5. The stalled-run / heartbeat defect (from JD's diagnostics, not re-verified by me)

Case `8f36834f-c3cc-4a81-892b-d31adf2cba88`, run 10:49:53Z: one successful `memory_save`,
then silence; closed by stale-heartbeat recovery at 10:52:05Z. **Platform logs for that
window are no longer retained — root cause cannot be established retroactively.**

Confirmed source defect: `startRunHeartbeat` sets `inFlight` before the DB write and
clears it only on settle, so **one never-settling write suppresses every later pulse**.
The update predicate also lacks `run_started_at`, so an old writer can touch a newer run.
Offline-reproduced (3 pulses → 1 write attempt). Mechanism proven; incident attribution
not.

**The synthesis worth carrying:** report generation takes 40–60s with **no tool calls**, so
a healthy run is legitimately silent for a minute. The heartbeat is the only liveness
signal in that window, and it can be silently suppressed. Quiet-but-healthy and dead are
indistinguishable — the likely story is a **live run killed by the sweep**.

- **Do not** simply lengthen the 75s liveness threshold (salvage averages 61.2s — it only
  moves the cliff) and **do not** enable the disabled run lease as a substitute.
  `RUN_LEASE_DISABLED=true` stays, per CLAUDE.md.
- Highest-value fix: bounded timeout on the heartbeat write + clear `inFlight` in
  `finally` + add `run_started_at` to the predicate. Small, isolated, offline-testable.
- Second: **durable admission row** — write the invocation parent at run start
  (status `running`), update at finish. Today `telemetry.ts` only inserts the parent at
  finish, so an abrupt death leaves no row at all. This is the change that makes every
  future silent death diagnosable after log retention expires.

---

## 6. Open items

| Item | State |
|---|---|
| **#936** W1-B Sources (frontend) | **Open, green, Codex clean, mergeable.** Held all session only so the stamp-parent invariant held; that no longer applies. Needs JD's go. |
| `indicia_web_dbs` schema gap | `HTTP 400: snusbaseType is required when snusbase is selected` — the tool schema lets the model select `snusbase` without the required pair. `tool-registry.ts`. **The one genuinely new defect** from the scan triage; no PR tracks it. |
| CLAUDE.md "Last verified" line | Says `6eb444f` — now **three deploys stale**. Will mislead the next session. Docs ride separately. |
| `#799` Jina 403, `#868` `memory_save` entries | Pre-existing open edge drafts; both appeared in today's failure triage. |
| Graphify finding on #938 | Override `disabled` on a forced-thinking model yields a guaranteed-400. Kept deliberately; `/health` flags it `ok:false` with the remedy. JD's to overturn. |

### Standing decisions reaffirmed this session
`REVEAL_BREACH_DATA` stays ON · `MAX_PAID_CALLS` stays bounded · intent is NOT inferred
from prose · `RUN_LEASE_DISABLED=true` · GLM primary, Anthropic backup (now
**glm-5.3-flash** in the GLM slot).

### Subscriptions / scheduled tasks
#938/#939/#940 merged and auto-unsubscribed. **No check-ins of mine are pending.** Two
unrelated pre-existing scheduled tasks remain enabled (weekly osint-agent health probe,
weekday morning brief) — leave them. A new session must re-subscribe to **#936** if it
intends to drive it.

---

## 7. Next steps, in priority order

1. **`{{FINDINGS_TABLE}}` server-side expansion.** §2. Highest value in the product.
   Frontend/edge split matters — read CLAUDE.md's constraints before designing.
2. **Heartbeat fix + durable admission row.** §5. Two separate PRs, not one.
3. **Fix GLM token PRICING** (the meter exists — see §3). Per-model rate table replacing
   the flat 0.3/1.2, plus metering for GLM salvage, which is currently unmetered. Do not
   add a second `onCost` feed.
4. **More glm-5.3-flash runs.** n=1. Watch `finalize_forced` rate against the 37%
   baseline and whether "no salvage" holds.
5. **#936** merge, `indicia_web_dbs` schema, CLAUDE.md refresh — all small.

**Do not** start Wave 2 (schema, `invocation_id` stamping, aggregator, review UI)
unprompted. **Do not** redo #938. One edge PR in flight at a time; never mix frontend and
edge in one PR.
