# CLAUDE.md — read first

Project: **Insight Finder** (a.k.a. Swarmbot) — an OSINT investigator. Vite + React + TS + Tailwind/shadcn frontend; Supabase (Postgres/Auth/Storage + **3 Deno edge functions** — `osint-agent`, `evidence-export`, `security-test-lab` — sharing `supabase/functions/_shared/`) backend.

## ⚠️ Deploy topology — the #1 thing to get right

> A mirror merge is NOT a deploy. The only proof of deploy is a moved build SHA.

There is **ONE place to work: this repo, `justindean785/insight-finder`** (local: `/Users/dizosint/insight-finder`, production branch `main`). Everything below was consolidated 2026-06-13 after the setup sprawled across 5 repos / 3 hosts. Do not recreate that sprawl.

```
        WORK HERE → github.com/justindean785/insight-finder (main)
                       │                         │
          merge PR ↓ (frontend)     sync functions/ via PR ↓ (backend)
                  VERCEL                seeker-spark-search-5362c57c
               (the app UI)              → Lovable SYNCS code ONLY ⚠️
                       └──────────┬───────────────┘  edge-fn DEPLOY = separate explicit step (see Backend)
                                  ▼
                  ONE Supabase backend: skzqwbyvmwqarfgfvyky
```

### Frontend → Vercel
- Vercel project `insight-finder` deploys this repo's `main`. `vercel.json` is committed. **Merge a PR to `main` → frontend ships.** Use the **Vercel URL** as the real app.
- **Netlify is NOT used** (a stray `netlify.toml` was removed). Don't re-add it.
- The Lovable-hosted frontend (`*.lovable.app`) is **deprecated** — both frontends hit the same Supabase backend, so Vercel already works against live data.

### Backend (3 edge functions) → via Lovable
- The Supabase project `skzqwbyvmwqarfgfvyky` is **owned by Lovable Cloud**, not the user. The Lovable project is connected to the mirror repo `justindean785/seeker-spark-search-5362c57c` (branch `main`), but **a push to that mirror only SYNCS the code into the Lovable project — it does NOT deploy the edge function.** ⚠️ **Mirror push = sync only; the edge-function deploy is ALWAYS a separate, explicit step** (the Lovable project agent running `supabase--deploy_edge_functions` — see the recipe below). Skipping it is why `osint-agent` has repeatedly shipped stale: the code was synced but never deployed, so `/health` kept reporting the old build.
- **Do NOT use `supabase functions deploy`** — the user's token 403s on that project (ownership wall). It is the wrong channel.
- **The backend is 3 functions + a shared module. A sync MUST cover all that changed — not just `osint-agent/`** (the old single-function recipe is why `evidence-export` drifted below):
  - `supabase/functions/osint-agent/` — 72 files; live tool defs inline in `index.ts`
  - `supabase/functions/evidence-export/` — PDF/zip export; `index.ts` + `text-sanitize.ts` (+ test)
  - `supabase/functions/security-test-lab/` — admin-only red-team harness; `index.ts`
  - `supabase/functions/_shared/ai-gateway.ts`
- **To ship a backend change — the canonical VERIFIED recipe (proven 2026-07-11 on #297; do NOT skip a step):**
  1. **Merge to `insight-finder` `main`** (source of truth).
  2. **Stamp the build marker:** run `node scripts/stamp-build.mjs` (aka `npm run stamp:build`) and commit `build-info.ts`. The `BUILD_MARKER` does **NOT** auto-update — without this the `/health` `build` SHA will not move even after a successful deploy.
  3. **Surgical mirror sync:** `cp -R supabase/functions/<fn>/. <clone>/supabase/functions/<fn>/` (per changed function) + a `git diff` review, then push to `seeker-spark-search-5362c57c`. **NEVER blanket-overwrite** — the mirror holds un-backported Lovable-authored work (e.g. `tools/peopledatalabs.ts` / `pdl_person_enrich`); sync **only** the files that actually changed.
  4. **EXPLICIT Lovable deploy — the step everyone forgets (a mirror push does NOT do this):** `send_message` to Lovable project **`4ce11bc3-039d-4439-b293-acacca9e1e3a`** instructing its agent to (a) pull GitHub `main`, (b) confirm `build-info.ts`'s `BUILD_MARKER`, (c) run `supabase--deploy_edge_functions` with `function_names: ["osint-agent"]` (deploy AS-IS — no edits, no frontend/`deploy_project` publish).
  5. **Verify live — the ONLY proof of deploy:** `curl https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1` and confirm the `build` SHA **moved** to the commit you stamped. A mirror push, a "changes are done" notification, and the agent's own "deployed" report are **NOT** proof — only the moved health SHA counts.
  6. **Record it — `npm run record:deploy -- --previous <prev> --mirror <path>`.** `npm run verify:deploy` is the same check, read-only. Neither pushes; publish with `git push origin HEAD deploy/live`.
     - **⚠️ Read the scope line, not the green word.** This establishes that the *observed runtime marker maps to canonical source history*. It does **NOT** establish deployed-byte identity. `build-info.ts` is a static file the running code echoes about itself — edit any OTHER file after the mirror sync, leave the marker alone, deploy, and every check still passes. `deployed_bytes_verified` is `false` in every row and `deployed_artifact_digest` is `null`, because the Lovable → Supabase path exposes no artifact digest or attestation. Closing that needs platform attestation, not another self-reported marker. A regression test (`src/test/deploy-provenance.test.ts`, "cannot detect a post-sync edit to a NON-marker file") pins this ceiling so nobody quietly upgrades the claim.
     - **Note the one-commit offset** (documented in `stamp-build.mjs`): the marker holds HEAD *at stamp time*, so `build-info.ts` at the marker commit still holds the PREVIOUS marker. The checker resolves the **stamp commit** (the child that introduced the marker) by pickaxe and asserts its parent IS the marker. Comparing `/health`'s SHA against `build-info.ts` at that SHA reports a false mismatch on a healthy deploy — don't "fix" the offset, it is inherent.
     - The ledger and the `deploy/live` ref are written by **separate, non-atomic** operations. The guarantee is *detection*: `verifyLedgerConsistency` runs first on every invocation and blocks recording on divergence.
     - **"The live build has no source in GitHub" is false** and gets re-reported periodically. `git branch -r --contains <sha>` settles it: every deployed build originates as a commit here, because the pipeline runs main → mirror sync → Lovable deploy. What was genuinely missing was the *record*, not the source. Note `/health`'s marker is the stamp commit's **parent**, so it never equals the `origin/main` tip — that is the offset, not drift.
- **Sync = true merge, NEVER `rsync --delete` / blanket overwrite.** The mirror has at times held Lovable-authored work not yet backported (e.g. the #16 source-classification rework — see `PR_BODY_backport-16.md` in the `pr2` worktree); a delete-sync would clobber it.
- **Known parity/drift (verified 2026-06-17):** `osint-agent`, `security-test-lab`, and `_shared/ai-gateway.ts` are **byte-identical** between `insight-finder/main` and the mirror. **`evidence-export` HAS DRIFTED** — the mirror runs an older 273-line `index.ts` with no `text-sanitize.ts`, so the *deployed* export path lacks the WinAnsi-sanitizer refactor that's on `insight-finder/main`. Sync it deliberately (reviewed PR), not blindly. Further evidence-export 500 fixes also sit unmerged on the `fix/evidence-export-500` branch (`insight-finder-ee` worktree).
- Edge-function secrets live in Supabase function settings (e.g. `IPQUALITYSCORE_API_KEY`, `SERUS_API_KEY`). Tools self-skip if their key is missing.

### Dead repos — ignore
`seeker-spark-search`, `seeker-spark-search-5fea4dc8`, `seeker-spark-search-ec85cfea` are **archived dead spawns** from past Lovable reconnect cycles. The ONLY live Lovable repo is `…-5362c57c`. Never push to the others; never disconnect/reconnect GitHub in Lovable (it spawns more dead repos).

## Edge function internals (gotchas)
- **Live tool defs are in `supabase/functions/osint-agent/tool-registry.ts`** (`buildTools`), **not** inline in `index.ts` (which now only orchestrates the request). The god-file refactor moved them; `index.ts` has zero tool defs. The catalog↔runtime contract test (`src/test/catalog-guidance.test.ts`) reads `tool-registry.ts` (with an `index.ts` fallback) to assert every `catalog.ts` entry has a runtime def — keep `catalog.ts` and `tool-registry.ts` in sync when adding a tool. (Any older `tools/*.ts` files are stale mirrors, not the runtime source.)
- Tests: `npm run test:edge` (= `cd supabase/functions/osint-agent && deno test --no-check --allow-net --allow-env --allow-sys --allow-read *_test.ts`). **`--allow-read` is required** — the source-level wiring tests (`reviews_wiring_test.ts`) read `index.ts`/`cluster.ts`/`recovery.ts` off disk to assert the call sites exist, and without it they abort with `NotCapable` before any assertion runs, which reads like a code failure and is not. (The old `--allow-net --no-check` form left env/sys perms off, inflating the failure count — measured 2026-07-25: `--allow-net --no-check` = 546 pass/57 fail vs `--allow-net --allow-env` = 754 pass/24 fail.) **Baseline re-measured 2026-08-09 on `86f92c62`: 1105 passed / 0 failed / 5 ignored.** The 24 environmental failures are GONE — do not treat any failure as "probably environmental"; that excuse is retired. **Deno is NOT preinstalled** in the web/remote sandbox: `DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`. `deno check index.ts` has ~12–157 **pre-existing** AI-SDK/Supabase type-graph errors — not a gate; verify your change adds none.
- Frontend tests: `npx vitest run` from repo root.

## Seeing the UI before you ship it — the harness

> A Vercel **preview** deployment is not the site. Only `target: production` on `main` is.

Two failure modes have repeatedly shipped UI work that changed nothing an analyst sees:

1. **Draft PRs never merge.** A preview deploy reports `READY` with a green check and looks
   exactly like a successful deploy — but it is `target: null`. Production only moves when a
   PR merges to `main`. Check `target`, not the checkmark.
2. **Reviewing only the signed-out surfaces.** Landing and `/auth` are easy to render, so
   passes concentrate there — while the signed-in workspace, where analysts actually live,
   goes untouched and the change reads as "looks the exact same."

To render the **signed-in workspace** with no prod credentials and no network:

```bash
npx vite --config vite.harness.config.ts        # → http://127.0.0.1:5174
# open /chat/11111111-2222-4333-8444-555555555555
```

`vite.harness.config.ts` aliases `@/integrations/supabase/client` to
`src/dev/supabase-mock.ts` — a chainable PostgREST stub plus fixtures for a realistic
finished case (8 artifacts spanning verified → capped → broker-only, 9 tool calls including
2 failures, a report-shaped final message). Every tab renders: Investigate, Evidence, Tools,
Graph, Report.

Nothing under `src/` imports the stub and the production config is untouched, so it cannot
reach a real build — `npm run build && grep -r harness.local dist/` returns nothing. Screenshot
the workspace before/after any UI change and put the images in the PR.

## ⛔ Run-termination invariants — 48 hours of incidents live here (2026-07-26)

Full write-up: `INCIDENT_2026-07-26_termination-and-ghost-recovery.md`. Two invariants
now hold the line. **Do not "simplify" either one away.** Both are pinned by tests
(`recovery_test.ts`, `orchestrator_finalize_test.ts`, `intermediate_step_plan_test.ts`)
that assert the kill switches ship ON — if you flip one, those tests fail loudly, which
is the point.

- **I-1 — a thread with no run marker is NOT an interrupted investigation.** A blank
  thread is born `status='active'` (DB column default) with `run_started_at` NULL, and
  `isStaleActiveThread` falls back to `updated_at`, so without `hasRunMarker()` the
  health sweep reaps a thread the analyst never typed into and posts a fake "Findings
  report — recovered run". This shipped for ~11 days: 14 ghosts, 192/264 threads eligible.
- **I-2 — `status='finished'` may only *present as complete* with a durable
  report-shaped assistant message or an explicit `finalize_no_findings`.** `finished` is
  written on THREE different paths (clean finalize, `onError`, stale recovery); painting
  all three green is how a 10-character `"I'll start"` stub and a real report looked
  identical. Unmet contract ⇒ `recovery_reason` ⇒ UI renders **Interrupted**.

**The termination oscillation — read before touching `toolChoice`.** This project has
twice swung between extremes and broken production both ways:
  - `FORCE_TOOL_CALL_UNTIL_FINALIZE=true` forced a tool call on EVERY intermediate step →
    removed the model's only natural exit (a text-only report) → self-completion 61%→25%.
  - Pure `"auto"` everywhere → unfinished `"I'll now run…"` narration ends the run and
    marks it COMPLETE.
  The resolution is **phase-aware, not global**: `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`
  forces a tool call *only* while the run has admitted **zero** tool calls **and** the
  latest user message parses as a seed. It releases the instant work starts. Never
  "fix" a termination bug by flipping a global toggle again.

**Also settled, do not re-litigate:** intent is NOT inferred from prose. A future-intent
regex was implemented and removed — it matched the legitimate closing line *"Drop a seed
and I'll run the investigation from TRIAGE through REPORT"*, fabricating a report on top
of a plain answer. Structural signals only (report shape, phase, length floor); anything
unclassifiable falls through to the completion contract and is labelled honestly.

**`stopWhen` cannot prevent a natural stop** — it only ADDS stop conditions. The SDK's
`finishReason:"stop"` on a text-only step is not vetoable from there. Don't try again.

## ⛔ Beta blockers — open P0s (2026-08-09)

Full write-up: `SESSION_HANDOFF_2026-08-09_beta-stabilization.md`. Two anchors are
**verified in code** and worth memorising, because both look fixed and are not:

- **`subject_unlinked` is a LABEL, not an AUTHORITY.** On `86f92c62` it is read in exactly
  one place — `src/lib/intel.ts:1129,1145`, the report collision section added by #431.
  `grep -rn subject_unlinked src/` is the whole list. The pivot engine never consults it,
  so quarantined selectors still surface as normal "Run this pivot" recommendations, and
  nothing stops a quarantined artifact being promoted to Confirmed / Primary Subject.
  Three boundaries must consult it: **write** (below), **pivot**, **promote**.

- **The name-only quarantine escape** — `supabase/functions/osint-agent/auto-persist-findings.ts:826`.
  A `name` row echoing the query is exempted from `SUBJECT_UNLINKED_CTX` (`:211`) on the
  reasoning that it is "the subject's own asserted name". That holds ONLY when the queried
  name IS the subject. When the name was itself derived from an earlier unlinked harvest it
  is the collision axis — so every descendant gets `subject_unlinked: true` while the trunk
  persists unquarantined at confidence 65, and the run pivots onto a different person.
  `queriedName` (`:413`) comes purely from tool input and knows nothing about linkage.
  Fix shape: gate the exemption on DURABLE linkage (seed match or selector overlap);
  name equality with the query is never sufficient.

Canonical fixtures: the `leoseyes86@gmail.com` collision case (exercises all of the above),
and `NOC@onemobility.net` as the *uncontaminated* budget-exhaustion case. Both are real
investigations — `src/dev/fixtures.json` and `src/dev/raw/` are gitignored; sanitize before
checking anything in.

## ⛔ The report layer bypasses the integrity engine (2026-08-11)

> Every integrity control sits one layer BELOW what the analyst reads.

Same shape as `subject_unlinked` above, one layer up: the capability exists, but nothing
forces the surface to honour it. **A prompt rule is not enforcement.**

`record_finding` already derives the true independence count server-side and persists a
computed, capped confidence — `tool-registry.ts:5513`,
`countIndependentClasses(i.supporting_sources.map(classifySource))`, whose comment is
audit F06 fixing this exact inflation at the write layer. Then the model **retypes the
Findings table in prose**, and the correct numbers never reach the report.

Verified on `9fc6ce1` (line refs re-measured — earlier handoffs cite stale ones):

| Rule | Where | What two GLM-5.2 runs published anyway |
|---|---|---|
| `2+ sources = 80+, single source = 40-60` | `system-prompt.ts:135` | single-source rows at 95% |
| `[CONFIRMED] (≥80)` needs **two independent** sources | `system-prompt.ts:151` | `[CONFIRMED, 2 source classes]` over two GitHub endpoints |
| 2+ **EFFECTIVE** sources; mirrors of one leak don't clear the bar | `system-prompt.ts:243` | same |
| let `record_finding`'s server-side confidence **stand** | `system-prompt.ts:245` | model asserted higher |
| closing table "just renders what is already persisted" | `system-prompt.ts:162` | model retyped it |

`detectContradictions` (`:245`) already flags shared-infra / mirror / same-name
false-links and did **not** stop shared Vercel hosting being used as a driver to
attribute a domain to a named private individual.

**Fix shape** — expand a `{{FINDINGS_TABLE}}` marker server-side before the message is
stored, so the table is generated from persisted rows. No markdown parsing of model
output. **It must never be able to fail finalize.**

**Do NOT:** change `confidence.ts` or `record_finding` (they already compute the right
values); gate finalization on evidence completeness, or add work inside the finalize
window — that path owns this project's worst incidents (see the termination invariants
above).

## Evidence-integrity rules (do not change without explicit approval)
Evidence ranking, confidence caps, chain-of-custody, credential masking, minor-safety detection, and the audit/coverage behavior are integrity-critical. Treat changes to them as requiring sign-off.

## Misc
- Today's working topology + history is also in the user's agent memory (`canonical-deploy-topology.md`, `deploy-blocker-lovable-supabase.md`).
- A few non-default local branches/worktrees with unmerged work exist (`claude/upbeat-darwin-y842dl`, `left/beta-p0`, `insight-finder-tier0`) — leave them unless asked.
