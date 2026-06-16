<!-- Generated 2026-06-14 by a 7-dimension parallel audit of `main` @ 58454e4 (clean worktree). -->
<!-- Every finding was verified against actual source; file:line cited. Phantom/false-positive findings were explicitly excluded (see "Verified NOT issues"). -->

# Insight Finder — Beta-Readiness TODO

**Audited:** deployed `main` @ `58454e4` (post #42 seedValueRaw fix, post #43 security headers).
**Method:** 7 independent auditors (security, evidence-integrity, backend-reliability, frontend/UX, database, build/deploy/deps, prior-docs reconciliation), each verifying against source.
**Build state:** `npm run build` ✅ · typecheck ✅ · lint 0 errors / 9 warnings · **525/525 tests pass** · CI gates lint+typecheck+test+build+deno-edge.

**Headline:** The app is well-engineered and close. **Beta is gated by three themes:** (1) the **defamation path** — weak evidence can persist a "confirmed" crime label on a living person; (2) **concurrency-unsafe edge state**; (3) a handful of **silent failures** (broken memory hit-tracking, map geocoding blocked in prod, Brain actions that don't persist, wrong spend totals).

---

## P0 — BLOCKERS (do not open beta until these are done)

### Evidence integrity — the defamation path (Tier-0 chain, OPEN on `main` — but candidate fix already exists on a branch)
> The numeric cap engine is correct, but the **harm-bearing label fields bypass it**. This is the single most important risk for a tool that names people.
>
> **⚠️ Already implemented on branch `fix/tier0-evidentiary-integrity` (worktree `~/insight-finder-tier0`):** commit `cd7e3fe` "T-C1..T-C4 — clamp the harm-bearing status label" + `64d298f` "T-H4 — source class keyed on tool name". It adds `deriveStatus`, a status `z.enum`, and `confidence_test.ts`. **EV-1→EV-5 are therefore a REVIEW+MERGE+DEPLOY task, not net-new.** Before merging: verify it satisfies the acceptance gate (single weak/unknown source can never read confirmed/corroborated; crime kinds gated on `court_record`; `unknown` handled) and that the trace-`51d82d5a` end-to-end test exists/passes. Needs explicit sign-off (changes evidence-ranking).

- [ ] **EV-1 (T-C1) — Validate `status` with an enum.** Model free-text `status` (e.g. `"confirmed_indicted"`) is stored verbatim. `index.ts:3480` (batch) + `index.ts:3732` (shim). Add `z.enum([...])`; coerce/reject out-of-enum; force `needs_review` when evidence is self-flagged `UNVERIFIED`. *(root of chain)*
- [ ] **EV-2 (T-C2) — Clamp the label, not just the number.** `applyEvidenceCaps` (`confidence.ts:93-134`) clamps numeric confidence only; a 50-capped artifact still reads `confirmed_*`. Add `deriveStatus(cap, classes, rawStatus)` (does not exist yet); downgrade any `confirmed*` unless `cap≥90` AND classes include `court_record` + an independent class. Call from both record paths.
- [ ] **EV-3 (T-C3) — Forbid "corroborated" on a single weak class.** `confidence.ts:118-126` calls things corroborated on `uniqClasses.length≥2` alone; `unknown` (the fall-through class) is not in `NEVER_HIGH`. Hard-forbid confirmed/corroborated when `<2 independent` classes; add `unknown` to `NEVER_HIGH`.
- [ ] **EV-4 (T-C4) — Elevated bar for crime kinds.** `applyEvidenceCaps` never receives `kind`; `criminal_case_event`/`court_case` are capped like a hobby username. Pass `kind` in; crime kinds → `manual_review_required` + ≤40 unless a `court_record`-class source is present.

### Backend reliability — concurrency
- [ ] **REL-1 — Thread-key the six module-global state singletons.** `guard`, `routingGuard`, `triageState` (`guard.ts:12-74`) and `degradedTools`, `deadHosts`, `firecrawlCreditsLow` (`env.ts:137/150/169`) are shared across all concurrent requests on a warm isolate; reset-at-handler-top only protects *sequential* reuse. `prepareStep` even clears shared state mid-run (`index.ts:4369`). Two overlapping scans corrupt each other's gating/dedup/degraded-tool decisions. Fix: `Map<threadId, State>` like `circuit.ts`/`runtime-policy.ts` already do; delete the top-of-handler reset block.

### Security — SSRF guard bypasses (edge-internal fetchers `http_fingerprint`, `archiver`)
- [ ] **SEC-1 — `isPrivateHost` misses IPv6 private/link-local.** Only `::1` blocked; `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:169.254.169.254` all pass (`safety.ts:171-188`). Parse bracketed IPv6, normalize, block those ranges.
- [ ] **SEC-2 — `isPrivateHost` misses alternate IPv4 encodings.** Decimal (`http://2130706433/`=127.0.0.1), octal, hex bypass the dotted-quad regex (`safety.ts:176-187`). Canonicalize host to a real IP before range checks. *(Fix SEC-1+SEC-2 together; update the mirrored copy in `security-test-lab/index.ts` and add these vectors as test cases.)*

### Database — silent grant failures + privilege widening
- [ ] **DB-1 — `bump_memory_hits` is permission-denied for the agent.** EXECUTE was revoked from `authenticated` (`20260529134334`) but the agent calls it via the user-scoped client (`recording.ts:186`, `index.ts:3614,3962`); failure is swallowed. **Memory `hit_count`/`last_used_at` never increment → ranking/recency permanently broken.** Grant EXECUTE to `authenticated` (or call via `supabaseAdmin`). Verify a run increments `hit_count`.
- [ ] **DB-2 — `save_agent_memories` (4-arg) has an accidental PUBLIC/anon grant.** Re-created via `CREATE OR REPLACE` after the lockdown (`20260529145859:25`); Postgres defaulted it to `EXECUTE TO PUBLIC`. Callable by `anon`. Add explicit `REVOKE ... FROM PUBLIC, anon` + `GRANT ... TO authenticated, service_role`; confirm `review.ts:215` still persists the "wrong" lesson afterward.

### Frontend — broken-in-prod + broken product promise
- [ ] **FE-1 — Map geocoding blocked in production (1-line fix).** `MapTab.tsx:67` fetches `nominatim.openstreetmap.org`, but prod CSP `connect-src` (`vercel.json`) doesn't list it → every geocode blocked; address artifacts silently never pin. Add `https://nominatim.openstreetmap.org` to `connect-src`. *(While there: remove the dead `https://api.serus.ai` entry — frontend never calls it.)*
- [ ] **FE-2 — Brain suppress/delete/promote are localStorage-only.** Keys `brain_{suppressed,deleted,promoted}_memories` referenced only in `BrainGlobalPage.tsx:108-128`; the edge agent has no concept of them, so "deleted" memories return on another device/after a clear and the agent keeps recalling them — while the UI claims "your marks shift how much the agent trusts each source." Persist server-side (a `memory_overrides` table or columns on `agent_memory`) and honor it in the recall path; until then, remove/relabel the affordances. Model it on the working `lib/review.ts`.

---

## P1 — HIGH (should fix before opening, or very early in beta)

### Evidence integrity
- [ ] **EV-5 (T-H4) — Source class spoofable via model prose.** `classifySource` (`artifact_types.ts:141-154`) regex-matches the free-text `source` string → `court_record`/`news` caps even for the wrong person. Key class **only on the canonical tool name**; require a verified URL for `court_record`/`news`. *(Feeds EV-2/EV-3/EV-4 — do early.)*
- [ ] **EV-6 (T-H2) — Contradiction detector never writes back.** `detect_contradictions` (`index.ts:4084`) is advisory; stored confirmed artifacts are never re-clamped on a high-sev `location_conflict`/`name_conflict`. Persist a downgrade pass (reuse EV-2's path).
- [ ] **EV-7 (T-H3) — Memory laundering.** `memory_save` stores free-text "lessons" with model-chosen confidence and `memory_recall` re-injects them with a "cite as confirmed" hint (`index.ts:3692,3912,3968`). Strip imperative confidence/status directives before re-injection; memory can never lift status past the class clamp.
- [ ] **EV-8 — `record_finding.label` is model-supplied, not derived.** `label` (incl. `"CONFIRMED"`) stored verbatim independent of computed `axes.case` (`index.ts:4156,4179`). Derive from axes; treat model label as a capped hint.
- [ ] **EV-9 — Frontend confidence explainer diverges from edge caps.** `src/lib/confidence.ts` `explainConfidence` recomputes from its own `SOURCE_TIER` (breach=92) ignoring edge `CLASS_CAP` (breach-only ≤60) → "Why X%" popover can show a higher number than the stored capped value. Reconcile to the persisted cap.

### Frontend / product
- [ ] **FE-3 — Client `.limit(5000/500)` aggregations report wrong totals.** "Total API Spend" (`BrainGlobalPage.tsx:1063`), source-reliability %, sidebar metrics (`ThreadSidebar.tsx:98`), CustodyTab, SourceBadge silently under-count past the cap — presented as authoritative dollar figures. Move spend + reliability aggregation server-side (RPC/SQL `sum`/`count`); paginate lists with a "+N capped" notice.
- [ ] **FE-4 — Two note stores.** Inline ToolPart note is localStorage (`proximity:note:<callId>`, `ChatWindow.tsx:204`) sitting next to the server-persisted `investigator_notes` NotesTab. Route the inline note through the existing `proximity:save-note` event so it lands in the DB.
- [ ] **FE-5 — "Finished"/"stopped" thread states are unreachable/unsurfaced.** Sidebar splits on `status==="finished"` but nothing ever sets it (`ThreadSidebar.tsx:256`); `stopInvestigation` writes `status:"stopped"` (`ChatWindow.tsx:1116`) which nothing reads. Add a "Mark finished" action; render a "stopped" badge.
- [ ] **FE-6 — Delete orphaned `BrainPanel.tsx`** (628 lines, never imported; superseded by BrainGlobalPage) after confirming no dynamic import.

### Database
- [ ] **DB-3 — Missing FKs → orphan-row accumulation.** `evidence_log`, `artifact_reviews`, `investigator_notes`, `tool_usage_log`, `agent_memory`, `investigation_cache`, `security_tests` store `thread_id`/`user_id` as bare UUIDs (no FK). Thread/user deletion leaves orphans forever (GDPR + custody-join risk). Add `user_id → auth.users ON DELETE CASCADE` (and `thread_id → threads`) across these tables.
- [ ] **DB-4 — `append_evidence` seq/chain race.** `SELECT MAX(seq)+1` + prev-hash read with no lock (`20260528235750:92`). Concurrent appends (frontend/multi-tab/retry) collide on `UNIQUE(thread_id,seq)` or fork the hash chain; failure is swallowed → silently dropped evidence. Add `pg_advisory_xact_lock(hashtext(_thread_id))`.
- [ ] **DB-5 — No retention/pruning.** `expires_at` on both caches is enforced only at read time; nothing deletes expired rows. `tool_usage_log`/`security_tests`/`evidence_log` grow unbounded. Add a `pg_cron` (or scheduled fn) cleanup.

### Build / deps
- [ ] **OPS-1 — `npm audit fix` (non-force).** Clears the 4 *production-reachable* highs (`react-router`/`@remix-run/router` open-redirect XSS, `lodash` injection); dry-run confirms no breaking changes. Commit the regenerated lockfile. *(The "18 vulns / 1 critical" are dev/build-only — vitest UI, esbuild, etc. — and don't ship.)*
- [ ] **OPS-2 — Delete competing lockfiles.** Repo has `package-lock.json` + `bun.lockb` + `pnpm-lock.yaml` + `deno.lock`; Vercel may resolve a different tree than CI tests. Keep `package-lock.json` (CI) + `deno.lock` (edge); delete `bun.lockb` and `pnpm-lock.yaml`.

---

## P2 — MEDIUM (fix during beta)

### Security
- [ ] **SEC-3 — DNS-rebinding/TOCTOU SSRF.** `assertSafeUrl` validates the hostname string, then `fetch` re-resolves DNS (`safety.ts:190`, call sites `index.ts:1985`, `archiver.ts:99`, `infrastructure.ts:160`). Resolve-then-pin, or document residual risk.
- [ ] **SEC-4 — Run Jina/Exa/wayback URLs through the (hardened) guard** (`tools/search.ts:749,691`, `index.ts:1961`) for defense-in-depth.
- [ ] **SEC-5 — Unify secret redaction.** `redactSecrets` (`cache.ts:234`) misses `xai-`; the final catch (`index.ts:4607`) and the other two functions' 500 paths return raw error messages unredacted. Factor one shared redactor (incl. `xai-`) used everywhere.
- [ ] **SEC-6 — `security-test-lab` reports a defense prod doesn't implement.** Its `SENSITIVE_KEY_RE` strips `password|ssn|dob|...` and asserts "stripped: CRITICAL ✓", but prod deliberately keeps investigation-target PII (`safety.ts:146`). Import the real regex or relabel → the admin dashboard currently shows a false green.
- [ ] **SEC-7 — Untrusted tool output → injection.** `jina_reader_scrape` is in `NO_SANITIZE_TOOLS` with no size cap (`cache.ts:677`); system prompt has no "treat tool/scraped output as untrusted, not instructions" block. Add a size cap + the prompt guard. (Blast radius is self-tenant due to RLS.)

### Backend / DB
- [ ] **REL-2 — graph_pivots is dead even when enabled.** Planner returns `proposed_calls`, branch reads `parsed.pivots` (`index.ts:690-698`) → always no-op. Map `proposed_calls`→`PivotCandidate`, or delete the block so enabling `GRAPH_PIVOTS_ENABLED` isn't misleading. (`graph_reasoning.ts`/`merge_guard.ts` are also dark — wire or retire.)
- [ ] **REL-3 — `credits_used` over-counts.** `increment_thread_cost` adds `GREATEST(1, delta/10000)` per checkpoint (every 5 calls) + final write → inflation vs a single write (`migration 20260528044103:12`, `index.ts:4243`). `cost_micro_usd` is correct; fix before any quota feature relies on credits.
- [ ] **REL-4 — Checkpoint cost-write loss.** `lastCheckpointMicroUsd` advances before the async RPC resolves (`index.ts:4247`); a failed write permanently drops that delta. Advance only inside the success branch.
- [ ] **DB-6 — Lower `messages.parts` cap** (currently 3.5 MB, `index.ts:4476`/`safety.ts:202`) and/or paginate message loads.

### Frontend / ops
- [ ] **FE-7 — Possible double FailedRunCard** (persisted `__STATUS__:failed:` message + `useChat.error` both render one). Suppress the `error` card when the last assistant message carries the FAIL_PREFIX (`ChatWindow.tsx:1031,1682`).
- [ ] **FE-8 — Realtime dedup** falls back to `JSON.stringify(parts)` equality (`ChatWindow.tsx:1066`) → two identical turns can drop one. Prefer id-based dedup.
- [ ] **FE-9 — A11y:** add `aria-expanded` to the ToolPart toggle (`ChatWindow.tsx:308`); manage focus on tab-switch and failed-tool jump; add a non-color severity cue to the sidebar row strip.
- [ ] **OPS-3 — No remote error sink.** `telemetry.ts` is local-only; `setErrorSink()` never called in app code. Wire it in `main.tsx` (Supabase table or Sentry) before broadening beta — otherwise crashes are invisible.
- [ ] **OPS-4 — Document 7 missing edge secrets in `.env.example`:** `DEEPFIND_API_KEY` (used 33×), `STOLENTAX_API_KEY`, `VIRUSTOTAL_API_KEY`, `LEAKCHECK_API_KEY`, `IPQUALITYSCORE_API_KEY`, `IPGEOLOCATION_API_KEY`, `GRAPH_PIVOTS_ENABLED`.

---

## P3 — LOW (post-beta polish)

- [ ] **OPS-5 — Add `deno check supabase/functions/osint-agent/index.ts` to the edge CI job** (`test:edge` runs `--no-check` → edge type errors can reach the Lovable git-sync deploy). *(Currently 0 TS2304 errors — verified clean — but 2 latent TS2322 narrowing smells in `serus_core.ts:244`.)*
- [ ] **OPS-6 — Split oversized chunks** (ChatPage 805 kB / index 561 kB) via `manualChunks`.
- [ ] **OPS-7 — Optional:** `--max-warnings` budget on lint; drop dead `api.serus.ai` from CSP (folded into FE-1).
- [ ] **EV-10 — Add the N4 regression test:** assert `strongKeysFor`/`signalsFor` (`intel.ts:1173`) never merge on bare name/DOB. The invariant holds in source but is untested.
- [ ] **DB-7/8/9 — Migration hygiene:** dedupe the two `charged_micro_usd` migrations, standardize file naming, drop the duplicate `agent_memory_user_subject_idx` (all currently harmless).
- [ ] **FE-10 — Acceptable localStorage caches** (`proximity:geocode-v1`, `proximity:pivot-skip:*`): document as known per-device limitations; optional TTL.
- [ ] **SEC-8 — Optional CORS/CSP tightening:** pin edge `Access-Control-Allow-Origin` to the app origin; drop `script-src 'unsafe-inline'` if the Vite build allows nonces.

---

## Additional verified-OPEN items folded in from prior audits (AUDIT_main_2026-06-08, BETA_READINESS_AUDIT) — re-verified against `main`

> These were in your earlier audit docs and are **still open on `main`** (line numbers re-verified). Merged here so they aren't lost. IDs are the originals (H/M/L = AUDIT-0608).

### Privacy / PII handling (HIGH — handoff flagged PII as needing approved evidence-integrity work)
- [ ] **PII-1 (H5) — Raw breach passwords printed in the report.** `buildHunterNotes` emits plaintext passwords (`panel/CaseReport.tsx:255-260`). Mask (e.g. `pa•••rd`, show only length/charset) unless an explicit reveal+audit action is taken. *(Evidence-integrity-adjacent — get sign-off.)*
- [ ] **PII-2 (L10) — Serus `reveal` unmasks with no consent/authz/audit gate.** `tools/serus.ts:34-42`, `serus_core.ts:121,227-266` — unmasked breach fields are tagged but not gated or logged. Add a consent/role gate + audit entry.
- [ ] **PII-3 (L9) — Tool logs emit query + body snippets.** `index.ts:479,497,754,785,828,3072` — truncated, not redacted. Redact PII/selectors from these log lines.

### Evidence / dossier correctness (HIGH/MEDIUM — feeds the same "don't mislead about a person" theme as the Tier-0 chain)
- [ ] **DOSS-1 (H8) — "Frankenstein" dossier.** `CaseReport.tsx:134-146` `pickBest` selects best-per-kind across the *entire* artifact set with no cluster awareness and doesn't exclude dismissed/false-positive/minor — can fuse two different people into one profile. Scope to the active cluster; exclude dismissed/FP/minor.
- [ ] **DOSS-2 (H10/M1) — Identity cluster drops state-less binding evidence.** `lib/intel.ts:1369-1383` — binders that match no state subset are dropped; no "unlocated" bucket. Keep them in an explicit unlocated bucket.
- [ ] **DOSS-3 (H6/M6/M7) — Dual confidence systems / uncapped popover headline.** (Superset of EV-9.) `ConfidenceExplain.tsx:20-24` shows uncapped `exp.final` as the headline with the stored capped value as a footnote; `lib/confidence.ts` `SOURCE_TIER` (breach=92) diverges from backend caps (breach ≤60). Make the capped/persisted value authoritative everywhere.
- [ ] **DOSS-4 (M2) — Geo false-positives from common words.** `extractStateFromText` maps `in→IN, or→OR, me→ME` etc. (`lib/intel.ts:1015-1054`) → false state attributions. Add ZIP-adjacency / full-name guards.
- [ ] **DOSS-5 (M4/L4/L5) — Overview metric integrity.** Dismissed artifacts counted as high-confidence and breach narrative counts dismissed/FP (`panel/OverviewTab.tsx:45-52,266-268`); FAILED check ordering + threshold comment (≥80 vs code ≥70) mismatch. Exclude dismissed/FP from headline metrics.

### Chain-of-custody integrity (HIGH)
- [ ] **CUST-1 (L7) — Archive SHA back-filled by `(value,kind)`, not seq/id.** `index.ts:3663-3674` can attach an archive hash to the **wrong** custody row when values repeat. Back-fill by the evidence `seq`/`id` returned from `append_evidence`.

### Accessibility / responsive (MEDIUM/LOW — batch)
- [ ] **A11Y-1 (H11/M12) — No `prefers-reduced-motion`.** Infinite animations (`index.css:313-337,704-708`) never disabled. Add a `@media (prefers-reduced-motion: reduce)` block. (WCAG 2.3.3)
- [ ] **A11Y-2 (H12/H13) — Mobile layout:** `ChatWindow.tsx:1577` uses `h-screen` (100vh) inside a 100dvh+header parent → overflow; double mobile header (`ChatPage.tsx:33-51` + `ThreadHeader.tsx:131` sticky, no mobile guard).
- [ ] **A11Y-3 (M9/L13) — Landmarks/tabs:** desktop has no `<main>` / skip link (`ChatPage.tsx:78-96`); Brain sub-tabs are plain buttons with no `tablist`/`aria` (`BrainGlobalPage.tsx:245-260`).

### Performance / structure (LOW — post-beta)
- [ ] **PERF-1 — Memoization gaps:** `MessageView` not `React.memo` (`ChatWindow.tsx:732`, re-renders per token); `useThreadArtifacts` `userItems/metaItems` unmemoized (`:241-242`); `OverviewTab` recomputes `adjustedConfidence` ~4× in render (`:43-74`). Lazy-load Leaflet (`MapTab` static import in the chat chunk).
- [ ] **STRUCT-1 (BLOCKER-2/F-09) — `index.ts` is a 4,614-LOC monolith** with the tool registry as one inline literal (`:261`). Your `BETA_READINESS_AUDIT.md` lists the modular split as a gate for the *open-beta* path. Extract the inline tools into the existing `tools/` modules.
- [ ] **CLEAN-1 (N3) — Delete dead `src/App.css`** (unimported; the only `prefers-reduced-motion` reference lives here, uselessly).
- [ ] **REL-5 (L21) — Dedup callKey reserved at completion, not dispatch** (`circuit.ts:262-277`) → concurrent duplicate calls both bill. Reserve on dispatch.

---

## Beta-readiness criteria (captured from your existing docs)

Your `BETA_READINESS_AUDIT.md` defines three release paths — use them to scope the cut:
- **Path A — Limited/closed beta:** clear the evidentiary-integrity blockers (Tier-0 EV-1→4) + the silent-failure blockers (DB-1, DB-2, FE-1, FE-2, REL-1, SEC-1/2). *(This is the minimum honest bar given the app names people.)*
- **Path B — Open beta:** Path A + P1 (rest of evidence chain, FK/custody/retention, dossier correctness, OPS-1/2, `index.ts` split).
- **Path C — Public:** Path B + load test, incident runbook, kill switch, privacy policy + beta terms, remote error sink (OPS-3), SLA.

`AUDIT_main_2026-06-08` definition of done (the hard gate): *a crime-attribution artifact built from a single weak/unknown/ai_summary source, or sharing only name+DOB with a living identity, can **never** surface as `confirmed`/`corroborated` and is routed to manual review — proven by an end-to-end test replaying the trace-`51d82d5a` shape.*

---

## Verified NOT issues (do not re-file — checked against source)

- **Hardcoded Supabase key** in `client.ts:11` is the **anon/publishable** key (RLS-enforced, meant to ship). Not a leak.
- **`seedValueRaw`** is fixed (#42) — declared at `index.ts:4204`; `deno check` shows 0 TS2304. No other use-before-declare in index.ts.
- **Cache cross-user leak** — none; both reads filter `.eq("user_id", ctx.userId)`.
- **`increment_thread_cost` / old `save_agent_memories(_user_id)`** cross-tenant concerns — mitigated (service-role-only / now derives `auth.uid()`).
- **All tables have RLS + PK**; no `USING(true)` policies; `evidence_log` is genuinely append-only; storage buckets are private with owner-folder policies.
- **Security headers (#43)** correctly shipped as real HTTP headers in `vercel.json`.
- **Map tiles** use CartoCDN (not Google); tiles load fine — only *geocoding* (FE-1) is blocked.
- **`MissingConfigScreen`** is unreachable in prod (env baked in) — don't file work against it.
- **Auth/authz core** (setupRequest fail-closed, per-page guards, admin `has_role` gate, evidence-export ownership check) is correct.
- **`infrastructure.ts` is LIVE, not dead** — imported at `tools/index.ts:41` (deepfind_mac_lookup, deepfind_dark_web_link). An older handoff said "safe to delete"; that is stale. **Do NOT delete it.**
- **Audit pipeline (`src/lib/audit/*`) ships but is frontend-only** — `source-independence.ts`/`confidence-linter.ts` are NOT wired into the backend record path, so they do **not** close EV-3/EV-5 at the persistence layer (those still need backend fixes).
- **Already fixed since prior audits (don't re-report):** v6 tool-part parsing (#28), per-request gating reset, DOB-never-merge + its regression test, transport-error UX, `?health=1` readiness probe, structured error envelope, anon-key fail-closed, AbortSignal.timeout polyfill, security headers (#43), sidebar search a11y, DNS virtual types, hypothesis-discipline prompt.

---

## Suggested sequencing

1. **One-line/cheap blockers first:** FE-1 (CSP nominatim), DB-1 (grant), DB-2 (grant) — hours, restore silently-broken features.
2. **Evidence Tier-0 chain** (EV-1→EV-2→EV-3→EV-4, then EV-5/EV-6/EV-8) — the marquee risk; one reviewable workstream. *Touches evidence-ranking — get explicit sign-off (project rule).*
3. **REL-1** (thread-key edge state) — required for safe concurrent load.
4. **SEC-1+SEC-2** (SSRF) together with shared test vectors.
5. **FE-2** (Brain persistence) + **FE-3** (server-side spend totals).
6. **OPS-1/OPS-2** (audit fix + lockfiles), **DB-3/DB-4/DB-5** (FKs, append race, retention).
7. P2/P3 during the beta.

**Definition of beta-ready (proposed):** all P0 closed + an end-to-end test replaying the trace-`51d82d5a` shape proving a single weak/unknown/ai_summary source can never surface as `confirmed`/`corroborated` and is routed to manual review.
