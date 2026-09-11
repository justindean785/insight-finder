# Session handoff — 2026-09-11 · finalize P0, deploy freeze, and artifact quality

> **Read this before `NEXT_SESSION_PROMPT.md` or any earlier handoff.** Every number
> here is a **dated measurement**, not a state. Re-measure before acting.

---

## 1 · State at close (measured 2026-09-11 ~06:55Z)

| Axis | Value | How measured |
|---|---|---|
| canonical `main` | `7c7888f` (#575; was `f0a7217`) | `git rev-parse` |
| live `osint-agent` build | **`f95a449`** — ⚠️ PREDATES #575, see §4.3 | `/health` + `verify:deploy` |
| mirror `main` | `952929e` (synced for `f95a449`) | mirror clone |
| Deploy state | ✅ **SHIPPED and VERIFIED** — freeze lifted | see §3 |
| Build marker | `f95a449`, stamp commit `8abc3e8` (parent verified) | `verify:deploy` |
| `reveal_breach_data` | `true` | `/health` (settled, do not change) |
| synthesis | `disabled` | `/health` |
| Provider | `deepseek` / `glm-5.2` (Z.AI), `pinned` | `/health` |

**Gates re-measured this session on `fceba9d` + the #569 head:**

| Suite | Result |
|---|---|
| Edge (`deno test --no-check --no-lock …`, Deno 2.9.6) | **1724 passed / 0 failed / 5 ignored** |
| Frontend (`npx vitest run`) | **162 files, 1969 passed, 1 skipped** |
| Typecheck | exit 0 |
| Lint | 0 errors, 11 warnings (pre-existing, `src/components/`) |
| Build | exit 0 |

`CLAUDE.md` previously cited **1634** (edge) and **1957 / 159 files** (frontend). Both
were stale and are corrected to the figures above in the same PR that carries this file.

---

## 2 · What shipped

**PR #568 — MERGED (`fceba9d`).** Bounded the correlation finalize-deferral.
`shouldDeferFinalizeForCorrelate` was `correlateDue && lastCorrelateOutcome === null`
with a doc comment claiming "defer once" — there was no once. It now takes a per-run
counter (max 1), a hard wall-clock floor, and a **required** `stepCapDue` argument
checked first, because the step-cap trigger is not deferrable: `stopWhen` includes
`!finalizeStarted && stepCountIs(MAX_ORCHESTRATOR_STEPS)`, so deferring on the last
step ends the run with no report.

**PR #567 — OPEN, DRAFT, docs-only, untouched by instruction.** Carries
`AUDIT_REPORT_2026-09-11_run-failure-structural.md` and
`DESIGN_2026-09-11_selector-identity-projection.md`. Its selector-identity design pass
is **complete**; do not re-run that workflow.

**PR #569 — MERGED (`82ae57b`), 07:15Z.** Canonicalizes the mirror-only
`tools/gemini_vision.ts` patch **and closes the Codex P2 in the same PR** (§4.2). The
merged `sniffKind` carries `decode(probe, { stream: true })` plus 90 lines of new
boundary tests in `gemini_vision_test.ts`. Verified on `main`: **12 passed / 0 failed**.

---

## 3 · Why the deploy is frozen

**RESOLVED — the deploy shipped.** Both reasons for the freeze are closed:

1. ~~The #568 P1.~~ **CLOSED by #571** (§4.1), deployed as `f95a449`.
2. ~~The mirror carried a live-runtime file canonical lacked.~~ **CLOSED by #569.**

`verify:deploy` on the shipped build, every axis the instrument covers:

```
live build f95a449 · stamp 8abc3e8 (parent f95a449) · reachable from main: yes
mirror tree -> equal · ledger / ref: f95a449 / f95a449 · reveal_breach_data=true
DEPLOYED BYTES VERIFIED: NO   <- the standing ceiling, not a fault
```

> **Instrument trap, hit during this very check.** A first `verify:deploy` run reported
> `mirror_tree_differs` — because it measured a LOCAL mirror clone that had not been
> fetched since before the sync. After `git fetch`, `diff -rq` was empty across all four
> function dirs and the gate read `mirror tree -> equal`. Fetch the mirror clone BEFORE
> trusting that axis, exactly as `CLAUDE.md` says for `deploy/live`.

### Parity, measured

`diff -rq` over all four function dirs showed five differing paths in `osint-agent`.
Direction was established for each: `index.ts`, `orchestrator-finalize.ts` and
`correlate_finalize_window_test.ts` are **byte-identical in the mirror to canonical
pre-#568** (mirror merely lacks the merge — no independent mirror edit), and
`correlate_finalize_deferral_bound_test.ts` is new in #568. Only `gemini_vision.ts` was
mirror-ahead. `evidence-export`, `security-test-lab`, `_shared` are clean.

**Re-measured after #569 merged (07:16Z): there is NO mirror-ahead file any more.** All
six differing paths are canonical-ahead — #568's four, plus `tools/gemini_vision.ts` and
`gemini_vision_test.ts` from #569. Mirror HEAD is still `1a5663b`, unchanged, so no
second-agent drift has landed. Parity is restorable by an ordinary canonical → mirror
sync whenever the freeze lifts; nothing needs backporting in the other direction.

> **Correction to `CLAUDE.md`:** `tools/gemini_vision.ts` is **NOT** auto-extracted dead
> code. It is imported at `tool-registry.ts:95` and `attachment-intake.ts:19` and
> registered at `tool-registry.ts:5636`. The "nothing imports `tools/*.ts`" rule covers
> the other files, not this one.

---

## 4 · Open defects — evidence and next step

Ordered by leverage. All are **read-only findings**; none was implemented.

### 4.1 — Finalize deferral can still strand a report · ✅ **CLOSED in #571, DEPLOYED (`f95a449`)**

Codex flagged it on #568 (thread `PRRT_kwDOSxbowM6hW_4I`, `orchestrator-finalize.ts:325`).
Verified, and it is worse than the review argued.

Constants: `ORCHESTRATOR_WALL_CLOCK_MS` = 180,000 · `FINALIZE_RESERVE_MS` = 90,000 →
window opens at 90,000 · `CORRELATE_DEFERRAL_GRACE_MS` = 30,000 →
`correlateDeferralFloorMs()` = **120,000**. So a deferral is legal anywhere in
**[90,000, 120,000)**, leaving 90s down to 60s.

Measured latency (production):

| Quantity | p50 | p90 | p95 | max | enforced cap |
|---|---|---|---|---|---|
| `minimax_correlate` (n=183, 45d) | 18,411 | 33,420 | 36,165 | 44,445 | **60,000** (`cache.ts:174`) |
| Closing synthesis step (n=7) | 30,976 | 50,209 | — | 51,359 | — |

`safe_deferral_latest = 180,000 − correlate − synthesis − 10,000` gives **83,626 ms**
(p95/p90), **74,196 ms** (max/max), **46,000 ms** (caps). **Every value is below the
90,000 ms window opening** — so under current budgets *there is no elapsed time at
which a deferral is safe*. The defect is not that 120s is too late; the window lies
entirely after the safe boundary.

**Live confirmation — run `050526ff`:** deferral at 94,243 ms; post-deferral spend
84,662 ms (`minimax_correlate` 29,226 ms + ~13,300 ms model planning + 41,792 ms
synthesis); `duration_ms` **181,133**, `stop_reason` **`finalize_forced`**. It exceeded
180s and survived, confirming the ceiling is in **[180, 195)**. Had the same deferral
landed later in its legal window it would have finished at **~205 s**.

The root error is in the grace comment itself: *"30s leaves 60s for the closing step,
which covers the 43-51s synthesis tail"* — it budgets for synthesis and **omits the
correlate call the deferral exists to permit**, plus the ~13s of model planning that
wraps it.

**Scale:** 55 / 173 runs (**31.8%**) die by stale heartbeat at the ceiling; healthy runs
average **158.6 s** to `finalize_forced`. This is the dominant failure mode.

**How it closed (#571).** `CORRELATE_DEFERRAL_GRACE_MS` / `correlateDeferralFloorMs` were
removed for an explicit `requiredCompletionMs()` summing four named sub-budgets tied to
enforced/measured bounds: `CORRELATE_COMPLETION_BUDGET_MS` 60s (mirrors `cache.ts`'s
enforced cap), `POST_CORRELATE_PLANNING_BUDGET_MS` 15s (above the ~13.3s measured),
`FINALIZE_SYNTHESIS_BUDGET_MS` 55s (above the 51,359ms measured max),
`COMPLETION_SAFETY_MARGIN_MS` 10s. Total **140s**, which exceeds the entire 90s reserve
window — so no wall-clock-bound deferral is reachable today, stated in the code rather
than hidden in a shrunk constant.

> ### ⚠️ A SECOND ADMISSION PATH THIS HANDOFF MISSED
>
> This analysis covered only the deferral decision at the `prepareStep` boundary. It never
> asked whether `minimax_correlate` could be admitted **mid-step**. `cache.ts`'s live-call
> guard exempted it from the finalize-window skip **unconditionally**
> (`!isFinalizeWindowLiveLookupExempt(name)`), so it was waved through at any elapsed
> time, including right against the platform deadline — the same no-report overrun,
> reachable through a second, unrelated gate. **The fix recommended here would have closed
> one path and left the other open.** Codex caught it on #571's own review thread; the
> exemption is now conditional on `ctx.hasCorrelateDispatchBudget`, recomputed live at call
> time (not the stale elapsed from the last `prepareStep`) and failing closed for callers
> that do not wire it.
>
> **Lesson for the next audit: when a budget guard is added at one boundary, enumerate
> every other gate that can admit the same call.** A predicate is not a chokepoint until
> you have proven there is only one way in.

> **Product consequence the operator must decide:** retiring the deferral means
> wall-clock-bound runs never correlate, so clusters stay null on exactly the runs that
> need them. The deferral was the wrong lever — correlation needs to run *earlier*, not
> by pushing finalize later. That is separate, larger work.

### 4.2 — `sniffKind` UTF-8 probe boundary · ✅ **CLOSED in #569 (`82ae57b`)**

`gemini_vision.ts:73`. `new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,4096))`
throws when a multibyte character straddles byte 4096 → `sniffKind` returns `"binary"` →
the document branch stamps `application/pdf` → reproduces the exact
`400 "The document has no pages."` the patch fixes.

Reproduced: 4095 ASCII + `é` → `TypeError`; **6 of 9 CJK byte-alignments** misclassify.
Reachable whenever the mime is non-text and non-image (e.g. `application/octet-stream`).

Fix is one argument — `decode(probe, { stream: true })` — verified to correct every
false-binary case while still rejecting random binary, embedded NUL and UTF-16.

**How it closed.** The operator's merge condition was "byte-equivalent to the mirror
patch AND CI green", and those were mutually exclusive — the mirror's NUL probe is a
regex literal that trips `no-control-regex`, an ESLint **error**, and `npm run lint` is
the first step of CI's Frontend job (`ci.yml:24`). The operator waived byte-equivalence
and the fix landed inside #569 rather than as a follow-up. Merged `main` carries both
deviations from the mirror bytes: `decoded.includes("U+0000")` (lint equivalence) and
`decode(probe, { stream: true })` (the P2 fix).

**Test coverage that shipped with it** — `gemini_vision_test.ts` grew 116 → 206 lines,
and `sniffKind` is now exported so the tests drive the real predicate: 3-byte and 4-byte
straddles, CJK across every alignment near the boundary, random binary, embedded NUL,
UTF-16LE, and — the case this handoff did **not** specify and should have — *genuinely
malformed UTF-8 away from the boundary still fails closed*, which pins that `stream:true`
forgives only a truncated **trailing** sequence and never an invalid one mid-probe.
Measured on `main`: **12 passed / 0 failed**.

### 4.3 — Source class derives from the TOOL, not the ORIGIN · ✅ **FIXED in #575 — ⚠️ NOT DEPLOYED**

> **Fixed on `main` at `7c7888f`; production is `f95a449`, which predates it.** A merge is
> not a deploy. Until an `osint-agent` deploy ships #575, every live investigation still
> runs the old classifier and still adjudicates no findings.
>
> Verified on `main`: `socialfetch_web_read (asec.ahnlab.com/en/94918)` -> `independent_public`,
> `socialfetch_web_read (x.com/DarkWebInformer/...)` -> `social_profile_active`,
> `countIndependentClasses` = **2** (was 1). Regressions hold: the `(instagram)` fast path,
> the bare-slug fallback, and non-string failing closed to `unknown`. #575 also carried the
> boundary through the persisted finding status (`lib/finding-row.ts`,
> `recording-source-policy.ts`) — wider than this section specified.

**This is why every case reports "the scoring engine adjudicated no findings."**

`classifySource()` strips the trailing parenthetical before slug lookup
(`source-classification.ts:326`) — deliberately, so `socialfetch_lookup (instagram)`
resolves. But the parenthetical is where the **URL** lives, so the origin is discarded:

| Artifact source | After strip | Class (`:156`) |
|---|---|---|
| `socialfetch_web_read (asec.ahnlab.com/en/94918)` | `socialfetch_web_read` | `social_profile_active` |
| `socialfetch_web_read (x.com/DarkWebInformer/...)` | `socialfetch_web_read` | `social_profile_active` |

A vendor threat-intelligence report and an X post collapse into one class, so
`countIndependentClasses` returns **1**, and nothing can clear the
`2+ independent classes → 80+` bar. Two harms: independent corroboration is invisible,
**and** the audit trail mislabels a vendor report as a social profile.

**Next step:** when a source label carries a URL, classify by **origin** first, falling
back to the tool slug. Preserves the `(instagram)` fast path. Smallest of the open items
and unblocks adjudication product-wide.

### 4.4 — `natural_stop`: runs end mid-investigation · **CONFIRMED** · needs design

The operator's "randomly stopping." Not the P1 — a separate defect.

| Outcome | Runs | Avg duration | Avg steps | Avg tools |
|---|---|---|---|---|
| `finalize_forced` (finalize ran) | 9 | 158.6 s | 7.3 | 14.1 |
| **`natural_stop`, `finalize_started=false`** | **3** | **77.5 s** | **4.7** | **4.7** |

~25% of telemetered runs stop at under half the budget with nothing exhausted. The model
emits a text-only step narrating its next move and the SDK ends on `finishReason:"stop"`.
Observed live: *"Now I have two strong new leads… Let me pivot to both."* → run over.

I-2 behaves correctly — no durable report → `recovery_reason` → UI renders
**INTERRUPTED**. The labelling is honest; the run genuinely ended early.

**Three obvious fixes are all forbidden** (`CLAUDE.md`, settled):
`stopWhen` cannot veto a natural stop; `FORCE_TOOL_CALL_UNTIL_FINALIZE=true` dropped
self-completion 61%→25%; prose intent-detection was implemented and removed. The
opening-phase gate releases on the first tool call, so it does not cover follow-up turns.

**Next step:** design first, no toggle. The only legitimate signal is structural —
`finalize_started === false` **and** no tool call this step **and** far below every
budget. That is state, not prose, so it does not re-open the settled rule.

### 4.5 — Gemini fallback is non-functional · **LIKELY** · latent, can take prod down

On 2026-09-11 the Z.AI quota hit **429**. The preflight probe correctly failed over to
the Gemini direct fallback (`index.ts:557`) — which returned **400 Bad Request on 8
consecutive runs**, `step_count: 0`, all under 1.4 s, at context sizes 102k–164k chars.
Size-independent, and `gemini-2.5-flash` has a 1M window, so it is a **request-shape
rejection**, not length.

There is **no Gemini tool-schema sanitizer** anywhere (`sanitizeModelMessages` sanitizes
*messages*, not tool schemas). Leading hypothesis: Gemini's stricter function-declaration
validation rejects one of the ~50 tool schemas. **Not proven** — needs a direct repro.

Two consequences: the fallback provides **zero** resilience (it converts "primary
rate-limited" into instant total outage), and `/health` advertises
`minimax: {ok:true, role:"fallback"}` while `gemini-direct` actually takes the turn — so
the one instrument you'd check during an outage names the wrong fallback.

Resolved for now by topping up Z.AI credits; **fires again on the next quota exhaustion.**

### 4.6 — Artifact quality is degrading · **CONFIRMED** · trend

| Bucket | Artifacts | Prose > 120 chars | `infrastructure` | Negative/error | Avg value len |
|---|---|---|---|---|---|
| `raidbin.st` (today) | 44 | **45.5%** | **75.0%** | **20.5%** | **143** |
| Last 7 days (other) | 283 | 11.7% | 6.0% | 1.8% | 60 |
| Older corpus | 10,970 | 5.6% | 2.1% | 1.2% | 44 |

Prose artifacts **doubled in the last 7 days** (5.6% → 11.7%, n=283) — that is the robust
signal; the 45.5% case is one amplified observation, not the new normal.

Artifact `value` is drifting from **selector** toward **narrative**. Consequences compound:
a sentence cannot be pivoted on, cannot be clustered, and rewording it defeats
`artifactDedupKey` (which hashes the unparsed value). Confirmed duplicate in
`050526ff`: two `legal@raidbin.st` breach rows, **same `cluster_id` `clus_f8dd2a9a`,
same `source`**, differing only in prose.

Also observed: ~20% of that case's artifacts are **absence-of-evidence or tool errors**
persisted as scored evidence (`0 results`, `not found`, `No permission to search`), and
three Cloudflare shared-IP co-tenants (`ynhs.org`, `rhino-okazaki.com`,
`webmail.rhino-okazaki.com`) were persisted as `domain` artifacts despite one row
explicitly labelling them "unrelated shared-CDN domains".

**Next step:** decide the artifact contract — `value` is a selector, narrative belongs in
metadata; tool errors and proven absences are *coverage*, not evidence. This is a design
question, not a patch. **Do not touch `artifactDedupKey`** (explicitly out of scope).

---

## 5 · Settled — do not re-litigate

Beyond `CLAUDE.md`'s existing list:

- **`MAX_PAID_CALLS` stays bounded**; `REVEAL_BREACH_DATA` stays ON; synthesis stays
  disabled; quarantine is not loosened; breach reveal is unchanged.
- **`artifactDedupKey` is out of scope** — the duplicate in §4.6 is reported, not fixed.
- **Intent is not inferred from prose** (§4.4).
- The shared-CDN co-tenancy in `050526ff` has **zero** attribution value — Cloudflare
  shared space. Do not pivot on those neighbours.

---

## 6 · The `raidbin.st` case — analyst note

Not an engineering item, but it is live and the risk is real.

**Confirmed:** RaidBin is a RaidForums-ecosystem paste-sharing platform. Two independent
sources — AhnLab ASEC July 2026 Dark Web Trend Report (`asec.ahnlab.com/en/94918`, vendor
threat intel, High) and `@DarkWebInformer` on X, 2026-07-20 (specialist OSINT,
Medium-High) — plus a hard technical link: `raidbin.org` and `raidbin.st` publish the
**same .onion address**. Timing agrees (domain created 2026-07-27).

**Likely, not confirmed:** the RaaS association. AhnLab describes RaaS operating rules
disclosed *alongside* the RaidBin launch — that places RaaS in the RaidForums ecosystem,
not necessarily in RaidBin.

**⚠️ Misattribution hazard.** The case file contains **Diogo Santos Coelho (Portugal),
aka "Omnipotent"**, alleged RaidForums founder charged in the April 2022 DOJ seizure
(Operation TOURNIQUET). He has been in custody/prosecution since 2022; RaidBin launched
July 2026; **nothing links him to it.** Ecosystem succession is not identity inheritance.
The artifact is correctly capped at 55 / `ai_summary` and says "alleged" — but if anything
downstream promotes it, that is a P0. Do not propagate the name.

Best open pivots: `legal@raidbin.st` (declared LE/abuse contact) and **`t.me/OmegaaRF`**
(operator-published Telegram contact; DeepFind returned 404, meaning *not publicly
enumerable*, not nonexistent).

---

## 7 · Recommended order for the next session

1. ~~**§4.3 source classification by origin**~~ — ✅ fixed in #575, **awaiting deploy**.
2. ~~**§4.1 finalize corrective PR**~~ — ✅ done, merged as #571 and DEPLOYED (`f95a449`).
3. ~~**§4.2**~~ — ✅ done, merged in #569. Parity is now restorable by a plain
   canonical → mirror sync.
4. **§4.5 Gemini fallback** — reproduce the 400 before proposing a fix.
5. **§4.4 natural_stop** — design proposal only.
6. **§4.6 artifact contract** — design proposal only.

Selector-authority implementation (PR2+ of the design doc) remains **gated** and was not
started. It still requires a proof of review semantics first: does Dismiss mean "this
artifact is bad" or "this selector is false for the subject?"

---

## 8 · Deploy recipe reminder

Unchanged from `CLAUDE.md`, and the hard gate matters: **`npm run verify:deploy` must
report `mirror tree -> equal` immediately before the Lovable deploy message**, not once at
session start — the mirror is writable by a second agent. A mirror merge is not a deploy;
only a moved `/health` build SHA is.
