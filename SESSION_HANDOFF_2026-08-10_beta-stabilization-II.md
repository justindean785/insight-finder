# Session handoff — 2026-08-10 — beta stabilization II

Successor to `SESSION_HANDOFF_2026-08-09_beta-stabilization.md`. Read that one for
the case fixtures and the pivot/quarantine background; read this one for what is
actually true today. **Several facts in the 08-09 handoff and in `CLAUDE.md` are
now stale — they are corrected in §6.**

---

## 1. The one thing to take away

> **#433 and #434 are merged, and running nowhere.**

```
canonical main .................. 3cac170  (contains #433 + #434)
Lovable mirror main ............. 9991502  "sync(osint-agent): … BUILD_MARKER b6ffd63"
live /health build .............. b6ffd63     ← verified live 2026-08-10
build-info.ts ON main ........... b6ffd63     ← never re-stamped after #433/#434
```

`diff -rq` across the two `osint-agent` trees shows 13 divergences, including
**`Only in insight-finder: lib/quarantine.ts`** — the entire #434 module is absent
from the mirror. The name-collision P0 the previous handoff reported as closed is
closed *in the source tree* and open *in production*.

Note the second-order trap: because `build-info.ts` was never re-stamped, even a
successful deploy right now would leave `/health` reporting `b6ffd63`, and the
"only proof of deploy" check would read as "nothing shipped." **Stamp first.**

---

## 2. What this session opened (4 PRs, ALL DRAFT, none merged)

Nothing here is merged, stamped, synced or deployed. **Green CI did not catch the
two most important defects in this set** — an independent review found both, and
both were real. Read §2.1 before trusting any "closed" in this document.

| PR | Domain | Deploy channel | State |
| --- | --- | --- | --- |
| **#436** — bind `subject_unlinked` at the frontend pivot boundary | frontend | Vercel on merge | draft; corrected after review |
| **#437** — give a non-recording run a durability path | backend | **stamp → sync → Lovable deploy** | draft; corrected after review |
| **#438** — revoke `anon` EXECUTE on `record_analyst_feedback` | database | **already applied live** | draft; comment corrected |
| **#439** — this document | docs | — | draft |

### 2.1 What green CI missed — and what that means for how you read this file

Both defects passed every gate: full vitest, full edge suite, typecheck, lint,
build. Both were semantic, and unit tests written by the same author who wrote the
code did not probe the semantics.

- **#436 — the quarantine key was not an identity.** Both sets were keyed on
  `normalizeTarget(value)` alone. That function collapses every non-alphanumeric
  run to a space, so `username "jordan.vale"` and `name "Jordan Vale"` both become
  `"jordan vale"` — and the ordinary NAME landed in `linked` and RESTORED
  authority to the quarantined USERNAME. The quarantine was undone by a row that
  says nothing about it. A second route did the same: non-pivotable kinds
  (address, organization) were also admitted to `linked`. Now keyed by
  `type:normalizedValue` with non-pivotable kinds excluded outright.

- **#437 — the escalation gate opened onto an empty room.** The gate needs
  `persistenceNudgeCount > 0`, and the nudge fires only after several unrecorded
  fan-out steps — so everything found before it was denied by the denylist and
  never held anywhere. Worse, `buildIntermediateStepPlan` narrows the nudge step's
  `activeTools` to `["record_artifacts"]` alone, so the very step that opens the
  gate has no search result to extract. The fix only ever covered searches made
  AFTER the first nudge, which is not the failure it claimed to close. A bounded,
  memory-only pre-nudge buffer now holds candidates and flushes them when the gate
  opens.

**The lesson worth carrying:** on this codebase, unit tests confirm that a
function does what its author meant. They do not confirm that the surrounding
state machine reaches that function with the right inputs at the right time. The
two defects above were both timeline/identity errors, not logic errors, and both
were invisible to every gate. Prefer a test that replays the real step sequence
over one that calls the helper directly.

They are deliberately separate: #436 ships the moment it merges, #437 ships
nothing until the full recipe runs, and #438 is already in the database. Merging
them together would recreate exactly the "merged = deployed" confusion that has
shipped `osint-agent` stale repeatedly.

### #436 — the pivot boundary

#434 was titled *"bind `subject_unlinked` at every authority boundary"*; every file
it touched was under `supabase/functions/`. **Do not trust PR titles for scope.**
On `3cac170`, `grep -rn subject_unlinked src/` returned four hits, all in
`intel.ts`'s report collision section. So the report *described* a same-name
collision while the pivot engine offered the disputed selectors as ordinary
"Run this pivot" cards.

Two holes in `computePivots`, both now closed:
- its safety block checked `collision` / `excluded_collision` / `possible_minor` /
  `minor_warning` / `auto_pivot_blocked` — but not `subject_unlinked`;
- that block runs only for `origin === "finding"`, so a quarantined selector the
  model wrote into the report's *Recommended pivots* bypassed it entirely.

`src/lib/quarantine.ts` mirrors the edge module, strict `=== true` included.
**Not over-blocking:** an identity goes inert only while *every* artifact carrying
it is quarantined — provenance is per-row, and the same phone can arrive both from
a name sweep and from a provider that matched on the subject's own email.

Keyed by `type:normalizedValue`, **not by value alone** — see §2.1 for why that
distinction is load-bearing rather than cosmetic. Non-pivotable kinds are excluded
from both sets: they can be the subject of no authority decision.

**Still unbound: the PROMOTE boundary.** The 08-09 handoff named three boundaries
— write, pivot, promote. #433 closed write, #436 closes pivot. Nothing yet stops a
quarantined artifact being promoted to Confirmed / Primary Subject in the report
or cluster confidence. That is the next piece of this work.

### #437 — the zero-artifact runtime blocker

The 2026-08-06 chain, **every link verified in code**:

1. `system-prompt.ts` ordered, as a MANDATORY directive: *"IMMEDIATELY after
   `google_dorks`, call `dork_harvest`… do NOT re-record them via
   record_artifacts."* `dork_harvest` has been `disabled: true` since 2026-07-09.
   #397 closed this for the catalog and registry by deriving from
   `PROVIDER_REQUIREMENTS`; `system-prompt.ts` never imported `capabilities.ts`
   at all, so it was never under that contract.
2. `repairUnknownTool` sends the name to `UNKNOWN_TOOL_SINK`, which returns
   `ok:true` — a burned step, and `dork_harvest(completed)` in the evidence
   export. That reaches the chain-of-custody record.
3. Worse than the wasted step: the same sentence told the model **not to record**
   what `google_dorks` surfaced, on the strength of a save that never happened.
4. The only automatic durability path, the auto-persist backstop, consults
   `AUTO_PERSIST_TOOL_DENYLIST` — which excludes **every** broad search and read
   tool. A run made of those tools has no durability path at all.
5. So the advisory persistence nudge was the entire mechanism. It fired 3×, was
   ignored, and the isolate was CPU-killed at 120s with `artifact_count: 0`.

The fix separates the denylist's two reasons: *"output is not findings / already
persisted"* (correctness, always true) from *"blindly auto-persisting this is
noisy"* (cost, true only while the model is doing its job).
`ESCALATION_ELIGIBLE_TOOLS` is only the second group, and it unlocks **only** when
both conditions hold — the nudge has fired with zero `record_artifacts` calls
*and* the thread holds zero artifacts. Outside that state, behaviour is
byte-identical.

Plus a bounded, memory-only **pre-nudge buffer** — without which the gate opened
onto an empty room (§2.1). Candidates are held from every pre-gate step and
flushed oldest-first when the gate opens; nothing is written until then.

**Deliberately not attempted:** the backstop is still detached via
`EdgeRuntime.waitUntil`, so it can still die with the isolate. Bound-awaiting it
would fix that, but awaiting auto-persist is what hung production in #369 and
forced the `4c92abd` rollback. That needs its own PR and its own evidence.

---

## 3. The security picture is not what the Lovable scan says

Inspected read-only against the live database rather than trusting a ~3-day-old
scan whose four findings were all *ignored* rather than resolved:

| Lovable finding | Verified state |
| --- | --- |
| **Critical** — any authed user can subscribe to another user's Realtime channels | **Not reproducible by inspection.** All 12 frontend channels use `postgres_changes` (no `broadcast`, no `presence`); `artifacts` and `threads` both have RLS on with `auth.uid() = user_id` SELECT policies; a `realtime.messages` policy restricting `user:` / `thread:` topics also exists. **Still open** — inspection cannot prove per-subscriber enforcement. Needs the two-user canary. |
| **Warning** — evidence archive has no DELETE policy | **Already fixed.** `evidence-archive owner delete` exists on `storage.objects`. |
| **Warning** — public can execute a SECURITY DEFINER function | **Real → #438.** `record_analyst_feedback` had EXECUTE for `anon`. Not exploitable (it raises `must be authenticated` on NULL `auth.uid()`), so hygiene, not an open door. Revoked and verified live. **The revoke is not self-sustaining:** `pg_default_acl` for `public` functions grants `anon`/`authenticated`/`service_role` EXECUTE, so a DROP+CREATE or a new overloaded signature silently restores it. (CREATE OR REPLACE does *not* — probed on this database.) |
| **Warning** — signed-in users can execute a SECURITY DEFINER function | **Real and appropriate.** The four app-facing functions all validate `auth.uid()` + thread ownership internally. |

**All 11 SECURITY DEFINER functions in `public` already pin `search_path`** (9 to
`public`, 2 to `public, extensions`). Nothing to do there.

**"Ignored" is not "fixed" — but neither is a stale scan evidence of breakage.**
Two of these four were already remediated. Re-run the scan after the deploy.

---

## 4. Dependencies — no upgrade recommended for beta

Real `npm audit`: **8 vulnerabilities (5 high, 3 moderate, 0 critical)**. Lovable's
"59 packages / 18 vulns / 5 High / 13 Medium" counts *its own* tree —
`@lovable.dev/mcp-js` **is not a dependency of this repo**, and `recharts` 2.15.4
has no advisory here.

Reachability, per package:

- **Build/dev only, not shipped:** `brace-expansion`, `js-yaml` (eslint),
  `esbuild`, `vite`, `postcss`. The vite/esbuild issues are dev-server-only.
- **`nanoid` 3.3.12** — no app import; transitive under `@supabase/functions-js`
  and `postcss`. Both advisories require attacker-controlled `size`. Unreachable.
- **`react-router-dom` 6.30.4** — the only plausible runtime candidate. **No
  exploit path was found** by grepping every `navigate()` and `<Link to=…>` call
  site: each is `` `/chat/${uuid}` ``-shaped with a DB-derived id or a local nav
  constant, the only URL params read are `tab` (compared against literals), and
  there is no `?redirect=` / `?next=` parameter anywhere. The SSR advisory needs
  SSR; this is a pure SPA.

  **Stated at its true strength:** this is *no path found by call-site
  inspection*, not *proven unreachable*. It was not fuzzed, and a future feature
  that routes on user input would change the answer. Treat it as a deferral with
  evidence, and re-check when routing changes.

`6.30.4` is the **last 6.x release** — the only fix is `7.18.0+`, a breaking
major. Upgrading a router for unreachable moderates days before a beta is the
wrong trade. **Document and defer; do not "ignore" it in Lovable.**

---

## 5. Remaining beta blockers

| Sev | Blocker | Next action |
| --- | --- | --- |
| **P0** | Nothing is deployed (§1) | merge → `npm run stamp:build` → surgical sync → **explicit** Lovable deploy → moved `/health` SHA |
| **P0** | Two-user Realtime canary never run | two confirmed accounts; A subscribes to B's thread and must receive nothing |
| **P0** | Investigation canary never run | `node scripts/live-scan.mjs example.com` after deploy |
| P1 | Auto-persist backstop still detached (`waitUntil`) | own PR; weigh against #369 |
| P1 | Lovable security scan stale, findings ignored | re-scan post-deploy, resolve each |
| P2 | Idempotency is read-then-write, not a DB constraint | unique index = migration, own PR |
| P2 | P0-2 contradiction invalidation · P1 cluster semantics · P2 chip arithmetic | carried from the 08-09 handoff |

---

## 6. Corrections to `CLAUDE.md` and the 08-09 handoff

Apply these; each was verified this session.

1. **Edge baseline is `1135 / 0 / 5` on `3cac170`**, not 1105 (that was
   `86f92c62`) and certainly not the 754/24 still in `CLAUDE.md`.
   Frontend baseline: **1200 passed / 1 skipped / 101 files**.
2. **The package manager is npm, not pnpm.** There is no `pnpm-lock.yaml` and no
   `test:e2e` script. Use `npm ci`, `npm run typecheck|lint|test|build|test:edge`.
3. **The orchestrator is DeepSeek-pinned** (`deepseek-v4-pro`,
   `orchestrator_reason: "pinned"`), with MiniMax as fallback. Both `CLAUDE.md`
   and `AGENTS.md` still describe MiniMax as primary.
4. **#426 is merged** (`250c260`), not "READY FOR REVIEW" as the 08-09 handoff
   says. `tools/indicia.ts` still differs between mirror and canonical, so the
   blanket-sync hazard `CLAUDE.md` warns about is still live.
5. **`tools/peopledatalabs.ts` is no longer mirror-only** — `diff -rq` reports no
   files present only in the mirror's `osint-agent`. The warning is still worth
   keeping in spirit (never blanket-overwrite), but that specific example is stale.
6. **`subject_unlinked` binds at the frontend pivot boundary once #436 merges** —
   apply this correction only then, not before. The `CLAUDE.md` "⛔ Beta blockers"
   claim that `src/lib/intel.ts` is the whole list is superseded by that PR. The
   **promote** boundary remains unbound either way.

---

## 7. Discipline (unchanged, and it held)

- Failure-first or it does not count: #436's tests were 5/8 red before the fix,
  #437's prompt tests 3/5 red, and the two review-driven corrections were held to
  the same bar (#436's new regressions 3/11 red first).
- **Unit-green is not semantics-green.** Both defects found in review passed every
  gate. Test the state machine's timeline and its identity keys, not just the
  helper in isolation — see §2.1.
- Say things at their true strength. "No exploit path found by inspection" is not
  "unreachable"; "applied and verified" is not "self-sustaining".
- Preserve quarantined evidence; make it inert, visible, auditable. #436 pins both
  halves against the same artifact.
- A stale scan and an ignored finding are different failures. Check the live
  system before believing either.
- Never equate: merged = deployed · frontend published = backend deployed ·
  HTTP 200 = investigation succeeded · `ok: true` = beta-ready.
