# SESSION HANDOFF — 2026-08-24 · address-seed google_dorks routing fix

Read the newest architecture memory first if you read only one thing:
`mem/architecture/address-seed-google-dork-cross-layer-mismatch.md`. This file is the
session record; that one is the durable lesson.

---

## 0. Orientation — the 60-second version

- Reverified `main` = `17e5289778e91fbc7f1f22d9b3f85cbdd154be88`, Vercel production READY
  at that exact SHA (`insight-finder-sandy.vercel.app`).
- Reverified live edge `/health`: `build: 14e42a5`, `ok:true`, `deepseek` slot → `glm-5.2`,
  `reveal_breach_data:true`. **Unchanged all session — nothing was deployed.**
- Fixed the reported defect: an address seed (`79 WAVERLY AVE\nCINCINNATI OH, 45215`)
  fell through to `other` on both client and server, then `google_dorks` was dispatched
  twice with `kind:"domain"`, producing `site:79 Waverly Ave Cincinnati OH 45215` and
  similarly broken queries.
- Root cause was a **5-layer contract mismatch**, not one bad model decision — see the
  mem entry above for the full chain. Fixed all five layers.
- Branch: `claude/address-seed-google-dork-fix-uhc2is`. **Nothing merged, nothing
  deployed.** PR opened as draft against `main`.

---

## 1. What was actually broken (origin → sink)

1. `src/lib/seed.ts` had no `address` `SeedKind` — its own comment says it "must mirror
   server detection," but the server had an address kind and the client didn't.
2. `validation.ts`'s server address regex required a single line and whitespace (not a
   comma) before the ZIP, so the pasted two-line form classified as `other`.
3. `playbooks.ts` already required `google_dorks` for the `address` query type
   (`query-type-router.ts` already recognized it) — but the live `google_dorks` runtime
   schema (`tool-registry.ts`, `z.enum([...])`) had no `"address"` member, so the only
   enum value that would compile for a postal address was `"domain"`.
4. `catalog.ts` advertised `google_dorks` as `{ target, kind? }`; the runtime actually
   required `{ seed, kind }` — a second, independent drift from what the planner was
   told.
5. `cache.ts`'s `detectSelectorType()` trusted the model-supplied `input.kind` verbatim,
   with no validation against the value — so `kind:"domain"` on a street address was
   recorded as ground truth in telemetry (`_runtime.selector_type: "domain"`), and the
   domain family blindly interpolated the address into `site:`, `site:*.`, `%.`,
   certificate and secret-exposure templates meant for hostnames.

`tools/search.ts` was checked: it is a stale duplicate, unreachable — `tools/index.ts`
(the only importer of `tools/search.ts`'s `google_dorks`) has **zero importers itself**.
The live tool is exclusively `tool-registry.ts`'s `buildTools()`. Fixing the dead copy
would have changed nothing at runtime; it was left alone (not touched, not deleted —
out of scope for this fix).

`dork_harvest` was NOT touched or re-enabled, per the task constraint.

---

## 2. The fix

Two new shared, side-effect-free modules (both unit-tested directly, no mocking of the
tool registry needed for the logic itself):

- **`supabase/functions/osint-agent/address.ts`** — `looksLikePostalAddress` (strict:
  house-number + 2-letter state + ZIP, whitespace-flattened so multi-line input matches),
  `looksLikeStreetAddress` (loose: house-number + street-suffix, ZIP optional — used only
  by the kind guard, not seed-kind detection), `normalizeAddressValue` (cache key),
  `parseUsAddress` (street/city/state/zip split for building targeted queries).
- **`supabase/functions/osint-agent/dork-queries.ts`**:
  - `isHostname()` + `resolveDorkKind()` — the untrusted-`kind` guard. `kind:"domain"`
    is honored only if the seed passes `isHostname()`; otherwise it's re-routed to the
    address family (if address-shaped) or refused with a legible
    `{ ok:false, error:"kind_mismatch", ... }` — never a silent empty `ok:true`, per the
    project's standing rule that a quarantine/refusal must read as a refusal.
  - `buildAddressDorks()` — the address query family: exact-address, property/parcel/
    assessor/auditor/recorder, ownership/deeds, address+person and address+business
    disambiguation, public records (liens/permits/court), documents, archives, real
    estate references. Zero domain-infrastructure/secret/admin/certificate/subdomain
    templates — pinned by a test that scans every emitted query for those patterns.
  - `splitQuotedSeed()` — separates already-quoted phrases from loose tokens so a
    compound selector (`"79 Waverly Ave" Cincinnati "Patrick Damon"`) rebuilds into
    single, non-nested quoting instead of `""..." ... "..."""`.
  - `searchUrl()` / `canonicalizeDorks()` — ONE encoder for every dork URL (Google,
    Bing, DuckDuckGo, Yandex, crt.sh, Google cache). Applied to **every** kind, not just
    address: the hand-written table's `url` fields had encoded only a prefix of their
    `query` field project-wide, so the link an analyst clicked frequently executed a
    different search than the one displayed. `canonicalizeDorks()` regenerates every
    `url` from its own `query`.

Wired into `tool-registry.ts`'s live `google_dorks`: schema now accepts
`kind: "address"` alongside the existing seven; `execute()` calls `resolveDorkKind`
before touching the `map` table; `map.address = buildAddressDorks(seed)`; the returned
`dorks` are canonicalized; a `kind_corrected` field is added to the response whenever the
model's claimed kind was overridden, so the model (and any test) can see the correction
happened rather than silently getting different output than it asked for.

`catalog.ts`'s `google_dorks` entry rewritten: accurate `{ seed, kind }` input contract,
explicit "Address → kind:'address'; Domain → kind:'domain' ONLY for a valid hostname"
guidance, and a description of what a `kind_mismatch` refusal looks like.

`validation.ts`'s `detectSeedServer` now calls `looksLikePostalAddress` /
`normalizeAddressValue` from `address.ts` instead of its own narrower inline regex.

`src/lib/seed.ts` gained a mirrored `"address"` `SeedKind`, `looksLikePostalAddress` /
`normalizeAddressValue` (kept textually parity-tested against the server copy — no
shared module exists between `src/` and `supabase/functions/`, same constraint as
`formatThreadTitle`), and `extractDisplaySeed` now special-cases a postal address so a
two-line paste doesn't get truncated to its first line by the generic "messy blob"
fallback.

**Ripple from adding `"address"` as a first-class `SeedKind`** (required — `typecheck`
caught both, both are minimal, mechanical, and in-scope for "seed.ts must mirror server
detection"):
- `src/components/workspace/WorkspaceHeader.tsx` — `KIND_ICON`/`KIND_LABEL` are
  `Record<SeedKind, ...>`; added `address: MapPin` / `address: "Address"`.
- `src/lib/recommended-pivots.ts` — `pivotType()` maps a detected seed kind to
  `PivotType` (a *separate*, narrower union in `intel.ts` with no `"address"` member,
  consumed by two other exhaustive `Record<PivotType, ...>` maps in `intel.ts` and
  `pivot-engine.ts`). Rather than widen `PivotType` project-wide (real scope creep),
  `"address"` folds into the existing `"name"` fallback — `isAddressLike()` in the same
  file already gives an address-shaped value its own "Corroborate address" action label
  and property/assessor-aware priority independent of `type`, so nothing downstream
  actually loses behavior.

---

## 3. Before / after

**Multiline/comma Cincinnati input** (`79 WAVERLY AVE\nCINCINNATI OH, 45215`):
- Before: `detectSeedServer` → `kind:"other"`. Planner forced to call `google_dorks`
  with `kind:"domain"` to satisfy the address playbook → `site:79 Waverly Ave Cincinnati
  OH 45215`, `%.79 Waverly Ave Cincinnati OH 45215`, plus private-key/.env/admin-panel/
  certificate/subdomain templates.
- After: `detectSeedServer` → `kind:"address"`, `normalized:"79 waverly ave cincinnati
  oh 45215"`. `google_dorks(seed, kind:"address")` returns ~26 queries across Exact
  Address / Property Records / Ownership-Deeds / Residents-People / Address+Business /
  Public Records / Documents / Archives / Real Estate / Alt Search Engines — e.g.
  `"79 WAVERLY AVE" "CINCINNATI" OH 45215 (auditor OR assessor OR recorder OR "county
  auditor" OR "property appraiser")`. If the model still sends `kind:"domain"` on this
  seed, it's silently re-routed to the address family with a `kind_corrected` marker —
  no domain template is ever emitted for it.

**Compound selector** (`"79 Waverly Ave" Cincinnati "Patrick Damon"`):
- Before: nested/doubled quoting (`""79 Waverly Ave" Cincinnati "Patrick Damon""`) in the
  second production call.
- After: `"79 Waverly Ave" "Patrick Damon" Cincinnati` (single-quoted phrases, no
  nesting) plus a dedicated `Address + Person` category:
  `"79 Waverly Ave" "Patrick Damon" Cincinnati (address OR resident OR owner OR
  property OR deed)`.

**URL/query divergence** (project-wide, not address-specific): every dork's `url` now
decodes back to exactly its displayed `query` — pinned by a test that round-trips every
kind, not just address.

---

## 4. Test results (exact commands, exact counts)

Focused (new tests only), run first:
```
cd supabase/functions/osint-agent && deno test --no-check --allow-net --allow-env \
  --allow-sys --allow-read dork_address_test.ts
# 18 passed | 0 failed
```
```
npx vitest run src/test/seed-address.test.ts src/test/catalog-guidance.test.ts
# 14 passed (2 test files)
```

Full gates, after:
```
npm run test:edge   # deno test --no-check --allow-net --allow-env --allow-sys --allow-read *_test.ts
# 1297 passed | 0 failed | 5 ignored   (baseline was 1279/0/5 — +18 net new)
```
```
npx vitest run
# 117 test files, 1441 passed | 1 skipped   (baseline was 1422/1/115 files — this PR adds
# exactly one new frontend test file, seed-address.test.ts (11 tests); the +19 test / +2
# file delta beyond that one file is NOT fully accounted for by this PR's changes and
# was not investigated further — re-measure against origin/main before trusting the
# CLAUDE.md baseline as a delta reference, per its own repeated re-measurement warning)
```
```
npm run typecheck   # tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json
# clean
```
```
npm run lint        # eslint .
# 0 errors, 10 warnings — all pre-existing react-refresh/only-export-components warnings,
# none in a file this PR touches for a new reason (WorkspaceHeader.tsx's warning already
# existed on that file before this change)
```
```
npm run build
# ✓ built in 10.66s
```

`deno check index.ts`'s pre-existing AI-SDK/Supabase type-graph errors were NOT
re-measured for a delta this session — CLAUDE.md already documents these as
non-gating background noise (~12-157 pre-existing errors); this PR added no `.ts` file
that changes that count materially (two small pure-logic modules).

One incidental artifact from running `deno test` locally: it rewrote `deno.lock` with an
unrelated `jsr:@deno/installer-shell-setup` entry and dropped two Lovable-only npm
specifiers that aren't resolved locally. **Reverted before committing** — confirmed the
focused edge suite still passes against the original `deno.lock`. If CI's `deno test`
step regenerates the lock differently, that's pre-existing sandbox/CI drift, not
something this PR should paper over.

---

## 5. Secondary artifact-noise finding — traced, not a separate defect

The task asked me to determine whether the 36 low-confidence URL artifacts in the
Cincinnati report are a separate auto-persist/relevance-writer bug. Traced to ground:

- **Exact writer:** `extractFindings()` in `auto-persist-findings.ts`, reached via the
  **zero-evidence escalation path** (`ESCALATION_ELIGIBLE_TOOLS`), not the normal
  auto-persist path. `minimax_web_search` is in `AUTO_PERSIST_TOOL_DENYLIST` (normally
  never auto-persisted — the model is expected to call `record_artifacts` on the good
  hits) but is ALSO in `ESCALATION_ELIGIBLE_TOOLS`, which is deliberately allowed to
  bypass the denylist only when the thread still holds zero artifacts and the model has
  fanned out without recording (documented rationale: "Noise is the price of the
  alternative being total evidence loss").
- **The query that produced the rows:** a `minimax_web_search` call whose input matched
  `queryIsNameOnly()` — a person-name-shaped string in the generic `query`/`q`/`value`
  slot (e.g. a "Patrick Damon" / "Patrick Damon Cincinnati Ohio"-style query), not scoped
  to the address.
- **How many were irrelevant / whether the relevance gate applied:** all 36 were stamped
  `subject_unlinked: true` with reason `"harvested from a name-only query — same-name
  collision axis; linkage to the subject is unproven"` at write time, and confirmed by
  production screenshots this session: **0 Findings, 40/51 quarantined, 2 Leads, 0
  Excluded** for the original run — the rows never reached Findings, clusters, or
  confidence dimensions. **The existing relevance gate worked correctly.**

**Verdict: this is not a separate defect.** It's a documented, intentional tradeoff
(evidence-loss prevention) whose noise happened to be visible here because the
escalating search was name-only rather than address-scoped — which is a symptom of the
same root cause already fixed in this PR (the address playbook couldn't get the model a
correctly-shaped address query in the first place). No follow-up issue filed for this
specific one; if the pattern recurs on an address run *after* this fix ships, that would
indicate a genuinely separate problem worth then investigating.

---

## 6. Deliberately NOT done in this PR (follow-ups only, not filed as GitHub issues this
session — draft text below for whoever picks these up)

Per the task's explicit "avoid a large unrelated refactor" constraint, and confirmed by
this session's own screenshot review of production, the following are real but separate:

- **`gemini_deep_dork`'s kind enum also lacks `"address"`**, despite the address playbook
  requiring it. Same contract-mismatch shape as the fixed `google_dorks` bug, but a
  second tool's schema — deliberately not touched here ("unrelated search tools").
- **`jina_reader_scrape` and `oathnet_lookup` are listed as unconditional `required`
  steps in the address playbook** despite needing a derived URL (for
  `jina_reader_scrape`) or a derived name/email/phone/domain (for `oathnet_lookup`)
  that a raw address alone doesn't supply. Restructuring `playbooks.ts` to distinguish
  direct/conditional/optional steps is a real fix but a materially larger, separate
  change than this PR's scope.
- **The catalog↔runtime contract test (`catalog_contract_test.ts`) only checks tool-name
  equality**, not argument-shape or seed-type compatibility — which is exactly how the
  `{ target, kind? }` vs `{ seed, kind }` drift and the missing `"address"` enum member
  both shipped past it undetected. A stronger, argument-aware contract test is a
  legitimate follow-up; not added here beyond the two focused tests this PR does add
  (`google_dorks`-specific catalog↔schema↔runtime agreement, in `dork_address_test.ts`).
- **Zero-hit / empty-result tool outputs being persisted as `breach_exposure` artifacts**
  (e.g. `OathNet breach search on 'Terrance Shelton Cincinnati Ohio' — 0 hits` stored at
  50% confidence as `breach_exposure`) — flagged from a later production screenshot in
  this session, on a **different** thread/subject than the Cincinnati address case. This
  looks like a real evidence-integrity defect (a negative result becoming positive-shaped
  evidence) but needs its own investigation of the breach-recording write path; out of
  scope for a dork-routing fix and not investigated further this session.
- **Activity/Health/Audit tool-outcome surfaces disagreeing on the same call count**
  (e.g. 70 total calls bucketed as 61/1/4/4 on Activity vs 56/5/7/2/0 on Health, with
  Audit separately showing "Tools Run 35") and a **fully signed Supabase Storage URL
  rendered in a Review-cycle card** (a temporary credential displayed in plain UI) were
  both observed in this session's production screenshots on unrelated threads. Neither
  is related to address/google_dorks routing; both are worth their own issues if the
  user wants them tracked, but are not addressed here.

None of the above were implemented, and none required changing breach reveal behavior,
confidence scoring, report-label authority, clustering, or `dork_harvest`'s disabled
state — all held exactly as instructed.

---

## 7. Repository state at handoff

| | value |
|---|---|
| `origin/main` | `17e5289778e91fbc7f1f22d9b3f85cbdd154be88` |
| Vercel production | READY, `target:"production"`, same SHA, alias `insight-finder-sandy.vercel.app` |
| Live edge `/health` | `build:"14e42a5"`, `ok:true` — **unchanged, nothing deployed this session** |
| Working branch | `claude/address-seed-google-dork-fix-uhc2is` |
| Lovable SQL inspection | Not attempted — task said prior handoff found it blocked by scope; this session didn't need production DB rows (worked from the supplied report + repo source), so this wasn't re-tested. If a future session needs it, re-check the connector's `projects:write` scope first. |

Nothing merged. Nothing deployed to Vercel or Supabase/Lovable. No production data
written.
