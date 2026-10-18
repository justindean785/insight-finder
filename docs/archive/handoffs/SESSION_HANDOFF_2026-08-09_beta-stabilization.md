# Session handoff — 2026-08-09 — beta stabilization

Scope of this session: UI/frontend audit that turned into evidence-integrity work.
Read this before touching the report, the Tools workspace, or the artifact write path.

---

## 1. State of the world

| Thing | Value | How verified |
| --- | --- | --- |
| `origin/main` | `86f92c62c82c4229e85e0086b0e2bfe4fe34354b` | `git fetch` + `git log` |
| Frontend production | same SHA, `target: production`, `READY` | Vercel API on the alias, not on a checkmark |
| Production URL | `insight-finder-sandy.vercel.app` | alias list on the deployment record |
| Edge `/health` build | `b6ffd63` (2026-08-07) | `curl …/osint-agent?health=1` |
| Edge suite on main | **1105 passed / 0 failed / 5 ignored** | `deno test` locally |
| Frontend suite on main | **1200 passed / 1 skipped**, 101 files | `npx vitest run` |

**The edge build is older than main.** `b6ffd63` predates #429/#431 (frontend-only, so no edge impact),
but any future backend merge is NOT live until the deploy recipe runs. See §6.

### Merged this session

- **#429** — Intelligence consolidation (Insights + Brain → one section), new Analysis tab,
  failed tool calls surfaced in the Tools feed, dev UI harness. Merged → `a1ba2ade`.
- **#431** — collision quarantine surfaced in the report, `ip_address` mapped, Activity/Health
  taxonomy reconciled. Merged → `86f92c62`. **Frontend only.**

### Open

- **#426** — Indicia canonical/live reconciliation. **READY FOR REVIEW.** Head `9fa2bfd1`. See §5.
- **#430** — prompt/runtime budget parity. **HELD**, backend-only, 2 files. See §6.
- **#425** — run-correlation telemetry. Untouched this session; behind main.
- ~15 older drafts. Do not treat any as current. **#378 is superseded by #426.**

---

## 2. ⚠️ The three traps this session actually hit

Read these before doing anything else. Each cost real time.

### Trap 1 — "deployed" is four separate states

```
code merged  →  mirror synced  →  edge deployed  →  production verified
```

A Vercel **preview** deployment reports `READY` with a green check and looks identical to a
successful deploy. It is `target: null`. **Production only moves when a PR merges to `main`.**
Check `target`, never the checkmark.

For the backend it is worse: merging to `main` ships *nothing*. The edge function needs
stamp → surgical mirror sync → explicit Lovable deploy → moved `/health` SHA.

### Trap 2 — reviewing only the signed-out surfaces

#411/#428 shipped a "premium UI pass" that changed nothing an analyst saw. Every class it
introduced (`ops-shell`, `ops-grid`, `signal-sweep`, `instrument-panel`) lands in exactly three
files: `src/pages/Landing.tsx`, `src/pages/Auth.tsx`, `src/components/ui/full-page-loader.tsx`
— all signed-out or one-second-transient. Signed-in analysts got a renamed tab.

**Use the harness** (§7) so this cannot happen again.

### Trap 3 — generalizing from one old case

I concluded "source classification is inert; confidence is pinned at 50" from a **June** thread
and reported it as current. It was wrong. On the newest 400 artifacts, **357 (89%) classify**
and confidence spreads **15 → 100**. The June thread predated the classification fix.

**Always order analytical queries `created_at desc` and state the window.** `AnalysisTab` now
does this deliberately — see its header comment.

---

## 3. Beta blockers — ranked, with code anchors

The operator's ranking, annotated with what is **verified in code** vs **inferred from output**.

### P0-1 — Wrong-person pivot authority · VERIFIED

`supabase/functions/osint-agent/auto-persist-findings.ts:826`

```js
if (nameOnly) {
  for (const f of findings) {
    // The query echoed back — a `name` row equal to what was asked — is the
    // subject's own asserted name, not a third party. Not quarantined.
    if (f.kind === "name" && normalizeBreachSubject(f.value) === queriedName) continue;
    f.context = { ...(f.context ?? {}), ...SUBJECT_UNLINKED_CTX };
  }
}
```

The exemption's reasoning holds **only when the queried name is the investigation's subject**.

In the Leo fixture the seed was `leoseyes86@gmail.com`; the queried name was itself *derived from
a prior unlinked harvest*. So the echo was not "the subject's asserted name" — it **was the
collision axis**, exempted and persisted at confidence 65. Every descendant got
`subject_unlinked: true`; the trunk did not. That trunk is what the run pivoted on.

`queriedName` (`:413`) derives purely from tool input and has no notion of subject linkage.

**Fix shape (narrow):** gate the exemption on *durable* linkage — the queried name matches the
seed, or a name already subject-linked by selector overlap. Name equality with the query is never
sufficient. `SUBJECT_UNLINKED_CTX` is at `:211`.

### P0-2 — Contradiction must invalidate stronger claims · INFERRED from output

Same thread produced both *"these are TWO DIFFERENT people"* and *"the Gmail account is most
likely owned by \<name\>"*, without retracting the first. There is no path by which a later
contradiction downgrades an earlier promotion. **Not traced in code yet.**

### P0-3 — Recovery / run isolation · INFERRED from output

Successive recoveries on one thread grew 6 → 34 → 82 rows, accumulating a cross-run evidence pool
the next continuation reasons over. Recovery invariants are documented in
`INCIDENT_2026-07-26_termination-and-ghost-recovery.md` — **read that before touching recovery.**
Invariants I-1 and I-2 there are load-bearing and pinned by tests.

### P0-4 — Terminal reliability · PARTIALLY VERIFIED

Both behaviours observed:
- `goran kvothe` — died at the paid-call cap → `INTERRUPTED`, 1 artifact.
- `NOC@onemobility.net` — hit the same cap, **degraded gracefully**, disclosed the reason,
  retained evidence, closed out.

So the cap is not always fatal. Worth diagnosing why one path dies and the other doesn't.
**#425 (run correlation telemetry) is the right instrument for this** — that is its value.

### P0-5 — Next-step filtering · VERIFIED

On current `main`, `subject_unlinked` is read in **exactly one place**:

```
src/lib/intel.ts:1129, 1145   ← the collision section (added by #431)
```

That is the complete list. The pivot engine never reads it.

**`subject_unlinked` is currently a label, not an authority.** #431 made it visible; it made it
enforce nothing. Quarantined selectors still appear as normal "Run this pivot" recommendations.

The three boundaries that must consult it:

| Boundary | Consumer | Status |
| --- | --- | --- |
| **Write** — can an unlinked name become a trusted root? | `auto-persist-findings.ts:826` | escape confirmed |
| **Pivot** — can it seed the next run? | pivot engine | never consulted |
| **Promote** — can it become "Confirmed / Primary Subject"? | report + cluster confidence | never consulted |

### P1 — Cluster semantics · VERIFIED from output

41 "Candidate Identity Clusters" from 63 artifacts; many single-member (one phone, one address).
That is a list wearing cluster labels. **Do not fix by merging more aggressively** — the goal is
semantic truth, not a lower count.

### P2 — Chat cycle chip counts · VERIFIED, two directions

`src/components/ChatWindow.tsx:622–624` renders `stale / skipped / completed` chips — no `failed`
chip, though `group.failed` exists at `:647–654`.

But the arithmetic is wrong in **both** directions:
- Leo thread: `29 calls` vs `11 skipped + 15 completed` = 26 → **under**
- onemobility thread: `4 calls` vs `2 stale + 2 skipped + 2 completed` = 6 → **over**

So `N calls` and the chip counts derive from **different sets**. My first diagnosis (just a missing
`failed` chip) was incomplete. Diagnose the denominator before patching.

---

## 4. Canonical beta fixtures

### CASE 1 — Leo / same-name collision (the primary fixture)

Seed `leoseyes86@gmail.com`. 63 artifacts, 59 needing verification, 41 clusters, addresses and
area codes across four states. Exercises P0-1, P0-2, P0-3, P0-5, P1 simultaneously.

Acceptance: a corrected build must never produce **both** "two different people" **and** a
confirmed primary-subject assertion merging them, and must not offer disputed-branch selectors as
normal next pivots.

### CASE 5 — budget exhaustion (clean fixture)

Seed `NOC@onemobility.net`. Organizational domain, **no identity contamination** — no person-name
query, no collision, no `subject_unlinked` in play. The paid-call cap is the sole limiter.
Terminal state truthful, evidence retained, reason disclosed accurately.

Use this for budget/termination work precisely because it is uncontaminated by the identity
defects.

**Note on PII:** these are real investigations of real people. Do not commit raw case data.
`src/dev/fixtures.json` and `src/dev/raw/` are gitignored beside the 2026-07-11 PII remediation
block. Sanitize before turning either case into a checked-in fixture.

---

## 5. #426 — Indicia reconciliation (READY FOR REVIEW)

Branch `claude/indicia-backport-upstream`, head **`9fa2bfd1`** (merge-from-main, not rebased —
branch was already shared).

**3 files, zero conflicts:**
```
supabase/functions/osint-agent/catalog.ts        +8  −0   (descriptions only)
supabase/functions/osint-agent/tools/indicia.ts  +137 −11
supabase/functions/osint-agent/indicia_test.ts   +129 −4
```

Four provider-contract corrections, each closing a hard 400: phone normalized to 10-digit NANP
(unusable selectors **gated**, not recorded as measured-empty, and the error reports a digit
*count* so no PII reaches `tool_usage_log.error_msg`); `zip` required on address; `services`
required + closed set on web-dbs; `type` required + closed set on hudsonrock, inferred from shape,
**never inferring `password`**.

**Wiring verified:** CLAUDE.md warns `tools/*.ts` can be stale mirrors with live defs in
`tool-registry.ts`. **False for Indicia** — `tool-registry.ts:75–77` imports these six symbols from
`./tools/indicia.ts` and assigns them at `:5058+`. The change is live-effective.

**Gates:** focused Indicia **24/0**; full edge **1116/0/5** vs main baseline **1105/0/5**
(**+11 tests, zero regressions**); `deno check tools/indicia.ts` clean; typecheck 0; lint 0
(10 pre-existing warnings); vitest 1200/1; build clean.

**No mirror drift imported:** no build markers, no `package.json`/`deno.json`, no migrations,
`pdl_person_enrich` untouched.

---

## 6. #430 — budget parity (HELD)

Branch `claude/ui-frontend-audit-prs-59n7bi`, head **`8b69fb6f`**, 2 files, backend only.

**What it fixes:** `system-prompt.ts` interpolated compile-time **constants** while `startCall`
enforces `runtimeLimits.*`. They agree only while no env override is set. Raise
`MAX_PAID_CALLS_PER_RUN` to 40 and the runtime permits 40 while the model is still told 12 — so it
self-throttles and announces *"switching to free tools only now."* **The env knob was decorative.**

Now the prompt reads the enforced values, so one env var moves both. Default behaviour unchanged.

### Unresolved contract — resolve before merging

`envNumber()` accepts `inf` / `infinity` / `infinite` / `unlimited` / `none`, but
`prompt_budget_parity_test.ts` asserts the paid cap is a finite positive number. Pick deliberately:

- **A — unlimited is valid:** enforcement keeps supporting `Infinity`; the prompt renders a
  human-readable `unlimited`; **never interpolate literal JS `Infinity`** into policy text.
- **B — unlimited is invalid for paid enforcement:** reject at the config boundary, fail safe.

Do not leave runtime and prompt disagreeing about it.

### Deploy recipe (the step everyone forgets)

1. merge to `main`
2. `npm run stamp:build`, commit `build-info.ts` — **the marker does NOT auto-update**
3. **surgical** per-file mirror sync to `seeker-spark-search-5362c57c` — never blanket-copy
4. `send_message` to Lovable project `4ce11bc3-039d-4439-b293-acacca9e1e3a` → run
   `supabase--deploy_edge_functions`
5. `curl …/osint-agent?health=1` and confirm the `build` SHA **moved** — the only proof

**Do not sync the mirror before #426 is resolved.** The mirror holds working Indicia behaviour
canonical `main` lacks; a blanket sync would revert it.

**Raising `MAX_PAID_CALLS_PER_RUN` is a separate operator decision, after parity is live.**
Do not raise it to hide termination bugs.

---

## 7. Tooling built this session

### UI harness — see the signed-in workspace with no credentials

```bash
npx vite --config vite.harness.config.ts     # → http://127.0.0.1:5174
node scripts/harness-shots.mjs ./ui-shots    # screenshots all five tabs
```

`vite.harness.config.ts` aliases `@/integrations/supabase/client` → `src/dev/supabase-mock.ts`
(chainable PostgREST stub + `auth`/`channel`/`rpc`/`functions`/`storage`).

Point it at **real** data:
```bash
SUPABASE_ACCESS_TOKEN=… node scripts/harness-snapshot.mjs [threadId]
```
Prefers a token so a password never reaches a shell command. Writes `src/dev/fixtures.json`
(**gitignored — real PII**). The stub prefers a snapshot and falls back to synthetic rows.

Cannot reach production: nothing in `src/` imports the stub; verified with
`npm run build && grep -r harness.local dist/` → no matches.

### Environment notes

- **Deno is not preinstalled.** `DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`
  Then `deno test --no-check --allow-net --allow-env --allow-sys --allow-read *_test.ts`.
  `--allow-read` is **required** — source-level wiring tests read files off disk.
- CLAUDE.md documents a 754/24 edge baseline. **Stale** — it is 1105/0/5 now.
- `vercel.app` is **blocked** by egress policy; `supabase.co` is reachable. Use the Vercel MCP
  `web_fetch_vercel_url` to fetch production assets.
- Browser → Supabase gets connection-reset even through the proxy, so you cannot drive the live
  app in Playwright. Pull data via REST and feed the harness instead.

---

## 8. Recommended order

1. **Close #426.** Review + merge. Deploy stays separate.
2. **P0-A, one PR:** failure-first test proving the *root* name artifact carries
   `subject_unlinked` — not merely its children — then gate the `:826` exemption on durable
   linkage. Do not bundle P0-C.
3. **Pivot boundary:** make `subject_unlinked` filter pivot generation (verified gap, §P0-5).
4. **Promotion boundary + contradiction invalidation** (P0-2).
5. **#430:** resolve the Infinity contract, re-run gates, merge, then run the full deploy recipe
   and verify the moved `/health` SHA.
6. **Only then** consider raising the cap, and re-run CASE 5.
7. Cluster semantics (P1), chip arithmetic (P2), old-PR cleanup — after the P0s.

Keep PRs narrow: one demonstrated defect → failure-first regression → narrow fix → full gates →
real-case verification → merge/deploy verification.

## 9. Discipline

- Evidence conservatism: **preserve** quarantined evidence, never delete it. Make it inert, visible
  and auditable.
- Do not "fix" scoring to make metrics look better.
- Do not weaken a test to get green CI — diagnose it.
- Beta-ready is not a feeling. It is: a fixed set of real investigation shapes that the product
  cannot lie about.
