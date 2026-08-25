# SESSION HANDOFF — 2026-08-25 · audit remediation + the run-wedge investigation

**Read this after `SESSION_HANDOFF_2026-08-23_report-authority-and-ci-recovery.md`.** Where they
disagree, this file wins for anything it re-measured. Like every file in the series it is **a dated
measurement, not a state** — re-verify before acting.

Branch: `claude/audit-claims-verify-oi0urm` · PR **#502** (draft) · base `4cc7573`.

---

## 0. Orientation — the 60-second version

Two separate bodies of work landed:

1. **The 2026-08-24 engineering audit**, executed after verifying all 61 of its claims. Phase 1
   (6 items) and Phase 2's code items are complete. **Several audit findings were wrong**; §2 lists
   them, because acting on the literal text would have caused at least one production regression.
2. **A live production wedge** the operator surfaced mid-session (thread `9ac01762`): a run that
   died and then failed instantly on *every* retry, forever. §3. The mechanism was mis-diagnosed
   twice — once by me, once by an external report — before being pinned to the SDK's actual rule.

Baselines moved. **Update your expectations before you measure anything:**

| gate | at `4cc7573` (session start) | at PR head | CLAUDE.md said |
|---|---|---|---|
| `npx vitest run` | 1492 passed / 1 skipped / 120 files | **1504 / 1 skipped / 121** | 1422 / 1 / 115 — stale |
| edge `deno test` | 1370 passed / 0 failed / 5 ignored | **1420 / 0 / 5** | 1279 / 0 / 5 — stale |
| lint | 0 errors, 10 warnings | unchanged | matches |
| typecheck | clean | clean | matches |

---

## 1. What landed (17 commits)

| # | Commit | What |
|---|---|---|
| 1 | `d470f79` | C1 — anonymous `?health=1` no longer bills an uncached completion or runs an unthrottled service-role sweep |
| 2 | `c6af44c` | C2 — one `redactSecrets()` in `safety.ts`; `describeError()` stops 9 sites logging raw error objects |
| 3 | `798be75` | C3 — catch-all 500 returns a fixed detail, never `e.message` |
| 4 | `038c802` | SSRF — IPv6 (ULA/link-local/mapped/NAT64) + CGNAT |
| 5 | `67a67cf` | Seed PII masked in the zero-artifact log |
| 6 | `8b28736` | security-test-lab imports the real defenses instead of mirroring them |
| 7 | `d29cdcf` | in-flight marker leak + floating custody write |
| 8 | `88ca9c8` | non-breaking `npm audit fix` (8 → 4) |
| 9 | `7246d6c` | CSP: `'unsafe-inline'` dropped from `script-src` |
| 10 | `bc43cbb` | `SELECTOR_SIGNAL_CACHE` bounded + invalidated |
| 11 | `eed2938` | evidence-export row bound + hourly quota |
| 12 | `ab1a1a0` | dependabot, CI audit gate, `npm run check`, monitoring runbook, `env.ts` startup diagnostic |
| 13 | `30f853b` | pre-live guard returns a schema-safe result instead of rethrowing |
| 14 | `97ab180` | `enforceToolPairing` on the step-0 prompt |
| 15 | `3deb5b7` | socialfetch fail-fast (22s → 9s) + 2-strike circuit break |
| 16 | `d8c95e2` | `isPositiveBreachExposure` predicate — **deliberately NOT wired** (§4) |
| 17 | `dd2f8a4` | `enforceToolPairing` on in-stream steps too |

---

## 2. The audit was wrong in five places — do not re-apply its literal text

Each was checked against the code or the installed toolchain, not reasoned about.

**C2's leak mechanism does not exist.** The audit says Deno's fetch `TypeError` embeds the URL in
`.message`, so `error: String(e.message)` (claimed 145×) carries keys into the LLM context and
`tool_usage_log`. Measured on Deno 2.9.5: `e.message` is `"fetch failed"`, `String(e)` is
`"TypeError: fetch failed"` — **no URL, no key**. The URL is only in `e.cause`, which nothing reads
(0 non-test hits), and the literal pattern has **0** occurrences (the real one is `error: String(e)`).
The genuine leak is passing the error **object** to `console.*`, which prints the cause chain into
Supabase logs. Different channel, lower severity, different fix.

**Its SSRF patch is dead code as written.** It matches mapped addresses with
`/^\[?::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]?$/`. `new URL()` runs first and rewrites the host —
`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`, hex — so that regex never matches real input. The
guard now parses the literal into its 8 groups. A test asserts the normalization directly.

**CGNAT is NOT blocked.** The audit lists `100.64/10` as already handled. It wasn't. Now it is.

**Fix #10's archive.org item is a non-issue.** `tools/infrastructure.ts:285` is dead code; the live
path (`tool-registry.ts:4530`) already has `encodeURIComponent`.

**Counts:** 18 SECURITY DEFINER definitions / 12 signatures, not 35 (the 35 is a raw grep including
17 comment lines) — and **CI asserts only the anon/PUBLIC grant, never `search_path` pinning**, so a
new unpinned function ships green. 89 inline tools in `tool-registry.ts`, not ~30. 246 files under
`supabase/functions/`, not 209. 257 test files, not 263. 29 root `.md`, not ~40. **30 open issues,
not 10.** 5 of the 12 cited key-in-URL sites are dead code (`tools/email.ts`, `tools/phase1_free.ts`
are unimported). npm advisory composition was wrong — it misses `brace-expansion`, `js-yaml`,
`vite`, `esbuild`.

**#500 was already fixed by open PR #501** — not re-implemented here.

### The one that would have caused a regression

Audit Fix #1 (and the session brief) say to run the recovery sweep **only** for the authenticated
probe. Doing that silently disables production stale-run recovery:
`20260720031500_pg_cron_health_sweep.sql` schedules `?health=1` every 60s with
`headers := '{}'::jsonb` — **no secret** — precisely so recovery runs when no browser tab is open.
The migration header documents the backgrounded-mobile-Safari failure it was written to fix. A 60s
per-isolate throttle achieves the security intent without breaking the mechanism.

---

## 3. The run wedge (thread `9ac01762`) — mechanism, corrected twice

**Symptom.** A run died mid-tool; every later turn on that thread failed with
`AI_MissingToolResultsError` at step 0 in <200ms, forever. Retry could never succeed.

**Two wrong diagnoses, both disproven empirically:**

- *"`convertToModelMessages` throws before sanitation can help."* It does **not** throw. It emits a
  dangling `tool-call` and returns normally — verified for every part state (`input-streaming`,
  `input-available`, `output-available` with undefined/null output, `output-error`, no state,
  `dynamic-tool`).
- *"`message-sanitize.ts` runs too late."* It runs **last**
  (`convert → trim → capTotalToBudget → capToolResultOutputs → sanitize`) and repairs all of those
  shapes — confirmed by running the real pipeline end to end.

A fix aimed at either would have added code for a mechanism that isn't failing.

**What is actually true.** `MissingToolResultsError` is thrown by the SDK's
`convertToLanguageModelPrompt`, and **its rule is positional**:

```js
case "user": case "system":
  if (toolCallIds.size > 0) throw new MissingToolResultsError(...)
```

A tool call must be resolved **before the next user/system message**. "A result appears somewhere
later in the array" does not satisfy it — and that is exactly the difference between
`sanitizeModelMessages`'s global rule and the SDK's.

**What shipped.** `enforceToolPairing()` in `message-sanitize.ts` runs the SDK's exact rule at both
boundaries — the step-0 prompt (`97ab180`) and every in-stream step (`dd2f8a4`). It **repairs**
rather than fails closed, because failing closed leaves the thread permanently unrunnable, which is
the reported symptom. When it fires it logs `tool_pairing_repaired_at_boundary` /
`tool_pairing_repaired_at_step` **with the offending tool-call ids** — so the shape that still
survives `sanitizeModelMessages` becomes identifiable from production logs. **That log line is the
next person's starting point.** I could not reproduce the surviving shape locally.

Tests transcribe the SDK's rule from its source as an oracle, so they check the real contract rather
than a restatement of it.

**Corrections to the external forensics:** `socialfetch_web_read "Cancelled 6/6"` is a **mislabel** —
it is the tool's own 22s per-attempt fetch timeout and it returns a properly paired result, so it
never orphaned a call. And the audit's P1-6 cites `index.ts:1537-1550` as the cause; that is the
*classifier* that labels the error after the fact, not where it is thrown.

---

## 4. Deliberately NOT done, and why

**P0-1 (negative breach records counted as exposure) — predicate landed, wiring reverted.**
The defect is real: `isBreachKind(a.kind)` counts breach-*shaped* rows, so three negative sweeps
published *"Subject appears in 3 distinct breach corpora. Assume credential exposure is broad"* plus
MEDIUM risk in a report whose own breach section said every provider returned zero.

I wired a structural predicate in and it broke `radar-metrics.test.ts`'s BUG-1 case, whose fixtures
carry real corpus names in `value` with no structural metadata. The writers explain why:
`auto-persist-findings.ts:1025-1035` always attaches a non-empty `breach_corpora`, so auto-persisted
positives *are* detectable — but the model can also write `breach_exposure` via `record_artifacts`
(`:291`) with arbitrary metadata, so a **model-authored positive can be just as bare as a negative**.
Under-reporting real breach exposure is worse than the over-count. **The correct fix is at the write
layer** — negatives should be `search_negative` / `coverage_gap`, as the deep audit recommends — and
that changes evidence semantics, which CLAUDE.md puts behind sign-off. `isPositiveBreachExposure` +
10 tests are in place as the target.

**Finalize window + paid cap.** Evidence that they fired simultaneously at 01:40 and double-starved
the run is strong. Not changed: CLAUDE.md marks `MAX_PAID_CALLS` **settled** and explicitly couples
it to the finalization state machine. Change them **together**, with sign-off, or not at all.

**`vercel.json` SPA rewrite.** `/((?!assets/).*)` → `/index.html` means every missing path returns
**200 + HTML**. Verified in production: `/fonts/x.woff2` and `/definitely-not-real.woff2` both return
`200 text/html`. Harmless-looking but it turns every broken asset path into a silent success. Left
alone — production serving change, outside the audit's scope.

**Vite 5 → 8 / react-router-dom 6 → 7.** Both majors. **Vite cannot move alone: `lovable-tagger@1.1.13`
depends on `vite@5`.** Every vite/esbuild advisory is dev-server only and does not reach production —
the audit's "vulnerable deps ship to prod" is wrong for those. `react-router-dom` is the one real
production advisory left.

---

## 5. Open findings not yet fixed

From an adversarial sweep over the dispatch/assembly surfaces (workflow was still running at
write-time; re-run it for the rest):

- **HIGH — `ALWAYS_ALLOW_TOOLS` are exempt from both the per-tool timeout and the abort signal.**
  The one tool class whose call can be emitted with no result ever produced, and nothing in the run
  can cancel it.
- **HIGH — the per-tool `AbortSignal` is decorative for 73 of 89 tool definitions.** A wrapper
  "cancel" abandons the promise instead of cancelling the work, so wall-clock keeps accruing inside
  the isolate after a timeout fires. This is part of why long runs bleed time.
- **LOW — the finalize REPORT phase** sends a prompt containing `tool_calls` / `role:"tool"` messages
  with the `tools` field omitted, and silently drops its own `toolChoice: "none"`.

Also open, from the operator's own reports: `JINA_API_KEY` is unset, so the tool doing most of the
real work is on the anonymous tier and throwing 403s. Config, not code.

---

## 6. Things worth knowing that cost time this session

- **`deno test` rewrites `deno.lock`** in this sandbox, dropping real dependency entries
  (`@ai-sdk/google`, `@lovable.dev/cloud-auth-js`, `vaul`, `vitest`) and adding the installer's own
  package. Use `--no-lock` locally. Do not commit that diff.
- **`tsc` also typechecks `supabase/functions/**`.** `Error.cause` broke the frontend typecheck from
  a Deno file; read `cause` structurally instead.
- **The first `deno check` after adding a cross-directory import can report a phantom error** that
  does not reproduce (a cold-resolution artifact — the same run emits npm peer warnings). Re-run
  before believing it.
- **A test that passes before *and* after your fix is proving nothing.** Two here were caught that
  way: the in-flight leak tests (confirmed failing against pre-fix code before acceptance) and the
  first selector-cache invalidation test, which was vacuous — the fake Supabase returned no artifact
  rows, so the code under test never cached anything and the assertion compared 0 to 0. Fixing it
  exposed a real placement bug: `record_artifacts` / `record_artifact` / `record_evidence` are
  `NO_CACHE_TOOLS` and exit through a **different wrapper**, so the hook on the main path never ran
  for the three tools that write the most artifacts.
