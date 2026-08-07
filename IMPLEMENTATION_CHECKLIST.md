# IMPLEMENTATION_CHECKLIST.md

Master checklist. Companion document: `INSIGHT_FINDER_CONTEXT.md`.

**Statuses:** `[ ]` open · `[x]` done · `EXISTS-AUDITED` capability already present, item is now audit-and-harden rather than build · `PLAN-GATED` produce a plan and get explicit approval before editing · `BLOCKED` waiting on a named dependency.

Annotations record what a repo scan found. No item has been dropped or merged.

---

## PHASE 0 — CONTEXT

- [x] **0.1** `INSIGHT_FINDER_CONTEXT.md` — stack, constraints, tool ground truth, health counters, rate-limit ledger
- [x] **0.2** `IMPLEMENTATION_CHECKLIST.md` — this list
- [x] **0.3** Repo scan: tool registry, reference tools (`leakcheck_lookup:1637`, `google_dorks:3024`), health-tab wiring, secrets pattern — recorded in the context file

---

## PHASE 1 — FIX BROKEN CORE

- [ ] **1.1 RESCOPED** — RDAP hardening for `whois_lookup` (public tool name unchanged)
  - `whois_lookup` (`tool-registry.ts:2405`) **is already an RDAP lookup** against `rdap.org`, so this is hardening, not replacement.
  - **No CLI/subprocess fallback** — removed from spec. The edge runtime has no subprocess capability.
  1. IANA bootstrap fallback: cache `dns.rdap.bootstrap.json` 24h; route ccTLDs `rdap.org` does not serve to their registry RDAP endpoint.
  2. Error semantics split: registry 404/empty → `measured_empty`, no retry; 5xx/timeout/network → `failed`, one retry now (backoff/DLQ arrives with 1.2).
  3. GDPR-redacted fields return `redacted: true`, never throw.
  - **Acceptance:** `example.com` → registrar + status; an `rdap.org`-unserved ccTLD resolves via bootstrap; a simulated registry 502 → `failed`, not `measured_empty`; a redacted registrant → `redacted: true`.
- [ ] **1.2** Skip-reason logging + exponential backoff retry + dead-letter queue
  - `fetch_retry.ts` already provides retry/timeout. ~30 call sites return `skipped: true` with a free-text reason that is **not persisted in a structured column** — that needs a `tool_usage_log` column, not just logging.
  - Keep one vocabulary with the sweep's `found` / `not_found` / `unverified` / `error` (landed in #413).
- [ ] **1.3 NEW** — stop `minimax_correlate` being called with an empty payload
  - The guard at `tool-registry.ts:553` is an **input guard**, not config gating: it refuses an empty `seed` or zero valid artifacts so a paid call is not spent on nothing. The model is invoking it with nothing to correlate.
  - Rewrite its `catalog.ts` description with an explicit input contract plus two worked examples.
  - When the guard fires, return a **structured hint naming the artifacts available to correlate**. No auto-fill.
  - Measure whether empty calls drop.

---

## PHASE 2 — FREE SIGNAL TOOLS (no keys)

- [ ] **2.1 EXISTS-AUDITED** — audit `wayback_cdx_search:2683` / `wayback_snapshots:2539` / `archive_url:4465`; add dead-page candidate extraction (status ≥ 400) + unique-URL dedupe if missing, else close as audited
- [ ] **2.2 PART-EXISTS** — crt.sh half exists (`crtsh_lookup:2752`, `crtsh_subdomains:2450`): verify backoff. **New half:** Censys certs (key-optional) + sibling-domain extraction from `name_value`
- [ ] **2.3 NEW** — `dnsbl_check` (DoH via `dns.google`; Spamhaus/SURBL; ≤3 lists per target)
- [ ] **2.4 SCORING-ONLY** — `email_domain_posture` on top of `dns_records:2467`, which already resolves virtual SPF/DMARC/DKIM/BIMI via `tools/dns-virtual.ts`. **No duplicate resolution.**
- [ ] **2.5 EXISTS-AUDITED** — `gravatar_profile:3993` exists; add: emit the md5 hash as a linkable artifact + feed correlator inputs
- [ ] **2.6 HASHING-ONLY** — inline murmur3 (~40 lines, no new dependency) of favicon bytes; emit a ready `icon_hash=` query into `fofa_search:2218`, which already accepts it
- [ ] **2.7 NEW** — `ripestat` (ASN / prefix / abuse contacts)
- [ ] **2.8 BLOCKED → UNBLOCKED** — audit `username_sweep:2418` vs WhatsMyName `wmn-data`; merge WMN definitions as an additive source (24h cache, concurrency ≤10, cap 150 probes) **only if the coverage delta is material — report the delta first**
  - Was blocked on #413 (merging WMN into a substring sweep multiplies false positives). **#413 merged as `5bd6ead`**, so the substring test is gone: whole-token matching, floor 5, and `confirm`-replaces-echo are in. Unblocked.
  - Carry forward: the sweep's residual echo-on-404 class is still open (see 2.11), so expand coverage cautiously.
- [ ] **2.9 NEW** — `open_meteo_history`
- [ ] **2.10 NEW** — dork **execution** path
  - `google_dorks:3024` is a **generator**: its own comment says it *"only emits search URLs"*. It never contacts Google, so its success counter measures string templating and must never earn discovery credit.
  - **First: trace and report who consumes `google_dorks` output today.**
  - Then execute generated patterns through available search APIs (Tavily / Exa / Perplexity), recording per-provider **operator fidelity as unverified**. Cap dorks per run; respect `MIN_START_GAP_MS`.
  - Note `dork_harvest:3347` already executes and relevance-gates recording; do not duplicate it.
- [ ] **2.11 NEW** (approved, bounded) — region-restricted echo matching for the sweep
  - Landed after #413. Require the handle echo in `<title>`, `og:*`, or `rel=canonical` rather than anywhere in the body.
  - Can only move a site `found → unverified`, **never the reverse**. If it surfaces new `unverified` sites that is data; if it surfaces none that is also data.
  - Does not close the residual: a platform echoing the handle in its own `<title>` on a not-found page still passes. Per-platform `confirm` measurement remains the real fix and needs an environment with open egress — 92 of 99 sites return 403 at the agent proxy.

---

## PHASE 3 — CORRELATION & CANONICALIZATION

- [ ] **3.1 PLAN-GATED, BLOCKED on #414** — entity canonicalization (email/phone/domain/username/url/crypto)
  - **Deliverable first: a disagreement matrix** — the three engines × phone fixtures → outputs, plus a unification proposal. **No engine behavior changes until approved.**
  - The three: `src/lib/entity-graph.ts` `selectorsFor` (digit-strips phones), `src/lib/intel.ts` `buildIdentityClusters` (lowercase only — leaves phone fragments), `supabase/functions/osint-agent/lib/cluster.ts` `clusterArtifacts` (true E.164; persists `cluster_id`/`subject_id`).
  - Integrity-critical (clustering/merge).
- [ ] **3.2 PLAN-GATED, BLOCKED on #414** — deterministic correlator v1 (ASN //24, NS-pair, favicon, GA/AdSense, SAN, MX → typed edges + confidence)
  - **Consumes only keys produced by an approved 3.1.**
  - Integrity-critical (confidence + merge).
- [ ] **3.3** FireCrawl extraction schema expansion (tracking IDs, OG meta, emails/phones, outlinks) — feeds 3.2's GA/AdSense rule, so sequence **3.3 before 3.2**

---

## PHASE 4 — REGISTRIES & WATCHLISTS (free keys)

- [ ] **4.1 NEW** — `sanctions_screen` (OpenSanctions; OFAC secondary)
  - Name-only matching is the exact weak-linkage class #414 quarantines. Must emit `subject_unlinked` unless matched on a concrete selector.
- [ ] **4.2 NEW** — `court_search` (CourtListener v4). CourtListener currently appears **only inside `google_dorks` query strings** (`:3168`, `:3194`, `:3195`, `:3386`) — suggested to a human, never fetched.
- [ ] **4.3 PART-EXISTS** — `registry_search`. `opencorporates_search:2912` and `gleif_lei_search:2857` exist; Companies House + SEC EDGAR are new. Confirm they are not redundant before adding two more.
- [ ] **4.4 EXISTS-AUDITED** — audit `crypto_wallet:3004`, which already calls `api.blockchair.com:3015`. Confirm counterparties + first/last-seen fields; add degraded soft-fail on 402/429 if missing.

---

## PHASE 5 — PAID (pauses for secrets)

- [ ] **5.1** `twilio_lookup` (line-type / burner detection). No `TWILIO_*` key provisioned — this item pauses for a secret.

---

## PHASE 6 — EVIDENCE & OUTPUTS

- [ ] **6.1 PLAN-GATED — INTEGRITY, EXPLICIT GO REQUIRED** — `record_artifacts` v2 (sha256 + raw capture + screenshot hook)
  - `evidence_log` already implements SHA-256 `content_hash` over 9 pipe-joined fields plus `chain_hash = sha256(prev || content_hash)`. Scored fields are permanently forward-only.
  - **Additive columns only. Forward-only. Nothing may rehash or rewrite historical rows.** PLAN + explicit GO before edits.
- [ ] **6.2** Export pack: GraphML/Cypher, STIX/MISP CSV, MD/PDF report with confidence + custody appendix, timeline JSON
  - Lands in `evidence-export`, which per CLAUDE.md has **drifted** from `main`. Reconcile the drift first or new exporters ship against stale code.
- [ ] **6.3** Cross-case entity edges table + `memory_recall` graph query
  - Requires a migration. Migrations do **not** reach production by merging — separate Lovable-owned channel plus post-apply verification.

---

## PHASE 7 — VERIFY

- [ ] **7.1** Smoke-test every new tool with fixture entities; health rows appear
  - Fixtures must use RFC 2606 / RFC 5737 reserved values. Real third-party selectors must never enter the repo.
  - **Design rule established by the #418 finding:** domain-scoped runs record zero evidence because `auto-persist-findings.ts` has **no infrastructure branch at all** — every `toolName ===` guard targets person shapes. CI could not catch it because there were no infra fixtures, and **absence of a fixture looks identical to passing**. Every new tool needs a *persistence* fixture, not just a call test.
  - "Health rows appear" is per-thread: a row appears only for a tool that executed on that thread.
- [ ] **7.2** Rate-limit ledger enforcement (per-provider token buckets)
  - **Net-new.** Today: `MIN_START_GAP_MS`, `MAX_PARALLEL_TOOLS` (queues, not a semaphore), a 400 ms same-tool cooldown, and a per-origin circuit breaker.
  - Establish per-provider limits from response headers (`X-RateLimit-*`, `Retry-After`) and observed 429s — **not** from vendor documentation — and record them in the context file once measured.
  - Any bucket held in module memory shares the durability gap in context §4: it will not survive a cold isolate or bound concurrent runs on one thread.
- [ ] **7.3** Final audit: every checklist item closed or annotated

---

## PHASE 8 — SOURCE OF TRUTH & ROUTING

- [ ] **8.1 PLAN-GATED** — per-step `activeTools` subset keyed by entity/phase instead of the full registry
  - Today the **entire 107-tool registry is visible on every ordinary step**. The only narrowing anywhere is the persistence nudge: `activeTools: input.nudgePersistence ? ["record_artifacts"] : [...normalActiveTools]` (`orchestrator-budget.ts`).
  - Fix `system-prompt.ts:116`, which tells the model *"You have ~30 tools"* against a real 107.
  - Target ≤40 model-visible tools per step.
- [ ] **8.2** (approval-gated) delete dead `tools/index.ts` + `tools/meta.ts`
  - `tools/meta.ts` holds a **second `list_tools`** with different filtering. It is imported only by `tools/index.ts`, which **nothing imports** — so it never executes. Dead, not competing, but dead code that reads as authoritative is exactly the trap CLAUDE.md warns about.
- [ ] **8.3 PLAN-GATED** — derive `FREE_TEXT_QUERY_TOOLS` + `availableToolsForAudit` + `catalog` from the registry / `inputSchema`: **one source of truth**
  - `availableToolsForAudit` (`tool-registry.ts:5254`) is a hand-maintained third registry holding **64** of 107 names and has already drifted: `breach_check` is listed only when `STOLENTAX_API_KEY` is set, but the runtime falls through to a keyless leakcheck endpoint when the key is absent.
  - `FREE_TEXT_QUERY_TOOLS` (#414) is a fourth such list. A tool whose `inputSchema` is `{query: string}` with no concrete selector key **is** the definition — derive it.
  - **Absorb 8.1's `system-prompt.ts:116` count fix into this plan.**
  - Also in scope: `CATALOG_CACHE` (`tool-registry.ts:302-311`) caches nothing — `filtered` is rebuilt and returned every call and the cached value is read only as a boolean for `cached_for_investigation`, so all 107 entries re-enter context on every call. It stores **unfiltered** `TOOL_CATALOG` while returning **filtered**, so serving the cached value without fixing that would start advertising provider-disabled tools.
  - Add an **end-to-end contract test**: execute the authoritative `list_tools`, apply readiness filtering, assert a nonzero count, assert every returned name is step-callable or explicitly internal, and pin the response shape (a top-level `tools` array via object spread — no count field). Log `catalog_count`, `runtime_count`, `deploy_eligible_count`, `step_eligible_count`, a registry/version hash, and per-tool exclusion reasons. Existing tests prove static catalog↔`buildTools()` parity only and never execute `list_tools`.
- [ ] **8.4** — #410 consumes `subject_unlinked` (evidence **totals** and **board rendering**); track to merge
  - `subject_unlinked` appears **nowhere in `src/`**. Until #410 lands, #414's quarantined rows still count in evidence totals and still render on the board. Backend containment before display is acceptable; an orphaned flag is not.

---

## Cross-cutting notes

- **Registration is two-sided.** Every new tool needs a `catalog.ts` entry **and** a `tool-registry.ts` runtime definition. `catalog_contract_test.ts` enforces 1:1 with no exemptions and fails loudly on either half alone.
- **Also update per tool:** `costs.ts`, `capabilities.ts` (`PROVIDER_REQUIREMENTS`), `source-classification.ts`, `cache.ts` timeout map, and `availableToolsForAudit` until 8.3 replaces it.
- **Nine new tools take the catalog from 107 to ~116** while `activeTools` is still the full registry every step. Adding capability without 8.1/8.3 widens the surface the model must reason over.
- **Do not flip** `FORCE_TOOL_CALL_UNTIL_FINALIZE` or `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`. Both are pinned by tests for documented incident reasons.
- **Open PRs on this surface:** #414 (name-only quarantine, merge-ready pending 8.4 confirmation), #418 (infra extraction, clean on main, CI re-run pending). #413 merged as `5bd6ead`.
- **Deploy:** merge → `npm run stamp:build` → surgical mirror sync → explicit Lovable deploy → verify the `/health` build SHA moved. A mirror push is not a deploy. **Currently held** until 1.1 lands and there is a clean baseline.
