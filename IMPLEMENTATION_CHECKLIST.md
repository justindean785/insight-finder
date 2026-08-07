# IMPLEMENTATION_CHECKLIST.md

Master checklist. All items open. Companion document: `INSIGHT_FINDER_CONTEXT.md`.

Annotations marked **⚠ PRE-EXISTING** flag items where a repo scan found the
capability already present, or where the stated premise diverges from verified
code. They are recorded so scope can be decided before work starts — no item has
been altered, merged, or dropped.

---

## PHASE 0 — CONTEXT

- [ ] **0.1** Create `INSIGHT_FINDER_CONTEXT.md` (stack, constraints, tool ground truth, health counters, rate-limit ledger)
- [ ] **0.2** Create `IMPLEMENTATION_CHECKLIST.md` (this list)
- [ ] **0.3** Repo scan: locate tool registry, reference tools (`leakcheck_lookup`, `google_dorks`), health-tab wiring; record paths

---

## PHASE 1 — FIX BROKEN CORE

- [ ] **1.1** `rdap_lookup` replaces `whois_lookup` (keep CLI-whois fallback alias)
  - ⚠ **PRE-EXISTING**: `whois_lookup` (`tool-registry.ts:2405`) **is already an RDAP lookup** against `rdap.org`. As specified this is a rename plus hardening, not a replacement.
  - ⚠ **NOT IMPLEMENTABLE AS WRITTEN**: a CLI-whois fallback cannot exist. The Supabase edge runtime has no subprocess capability (no `Deno.run` / `Deno.Command` / `child_process` anywhere under `supabase/functions/`). Viable substitutes: a second RDAP endpoint (IANA bootstrap → registry-specific RDAP), an HTTP WHOIS-proxy provider, or accepting `measured_empty` as a truthful terminal answer.
  - Real work available here: RDAP bootstrap for ccTLDs `rdap.org` does not serve; distinguish 404 (`measured_empty`) from 5xx/timeout (`failed`).
- [ ] **1.2** Skip-reason logging + exponential backoff retry + dead-letter queue
  - Note: `fetch_retry.ts` already provides retry/timeout; ~30 distinct call sites return `skipped:true` with a free-text reason that is **not** persisted in a structured column. Structured skip reasons require a `tool_usage_log` column, not just logging.

---

## PHASE 2 — FREE SIGNAL TOOLS (no keys)

- [ ] **2.1** `wayback_cdx`
  - ⚠ **PRE-EXISTING**: `wayback_cdx_search` (`tool-registry.ts:2683`) and `wayback_snapshots` (`:2539`) and `archive_url` (`:4465`). Decide: extend or close as done.
- [ ] **2.2** `ct_search` (crt.sh primary, Censys optional-if-key)
  - ⚠ **PRE-EXISTING (partial)**: `crtsh_lookup` (`:2752`) and `crtsh_subdomains` (`:2450`). Censys is genuinely new.
- [ ] **2.3** `dnsbl_check` (DoH-based DNSBL: Spamhaus / SURBL)
  - Genuinely new. `dnsBlocklists` appears only as a passthrough field from another provider (`:2667`).
- [ ] **2.4** `email_domain_posture` (SPF / DMARC / DKIM spoofability score)
  - ⚠ **PRE-EXISTING (plumbing)**: `dns_records` (`:2467`) already resolves virtual types SPF / DMARC / DKIM / BIMI via translated TXT queries (`tools/dns-virtual.ts`). Only the scoring layer is new.
- [ ] **2.5** `gravatar_lookup`
  - ⚠ **PRE-EXISTING**: `gravatar_profile` (`:3993`). Likely closeable as-is.
- [ ] **2.6** `favicon_hash` (murmur3 → FOFA `icon_hash`)
  - ⚠ **CONSUMER EXISTS**: `fofa_search` (`:2218`) already accepts `icon_hash=`. Only murmur3 + fetch/base64 is new.
  - `npm:` specifiers work in this project, so a package is available; a ~40-line pure-TS murmur3 is still preferred (no supply-chain surface, no cold-start cost).
- [ ] **2.7** `ripestat` (ASN / prefix / abuse contacts)
  - Genuinely new. Zero registry mentions.
- [ ] **2.8** `whatsmyname_sweep`
  - ⚠ **OVERLAPS**: `username_sweep` (`:2418`) already sweeps ~95 platforms, and `username_search` is a deprecated alias of it. Decide: adopt the WhatsMyName dataset *inside* `username_sweep`, or justify a second sweeper.
  - Sequencing: PR #413 (open) rewrites `sweeper.ts` existence logic to require positive evidence. Land or reconcile before touching this.
- [ ] **2.9** `open_meteo_history`
  - Genuinely new. Zero registry mentions.

---

## PHASE 3 — CORRELATION & CANONICALIZATION

- [ ] **3.1** Entity canonicalization module (email / phone / domain / username / url / crypto)
  - ⚠ **THREE ENGINES ALREADY DIVERGE** and must be reconciled, not bypassed: `src/lib/entity-graph.ts` `selectorsFor` (digit-strips phones), `src/lib/intel.ts` `buildIdentityClusters` (lowercase only — leaves phone fragments), `supabase/functions/osint-agent/lib/cluster.ts` `clusterArtifacts` (true E.164; persists `cluster_id`/`subject_id`).
  - Integrity-critical (clustering/merge). Requires sign-off.
- [ ] **3.2** Deterministic correlator v1 (ASN //24, NS-pair, favicon, GA/AdSense, SAN, MX rules → typed edges + confidence)
  - Integrity-critical (confidence + merge). Requires sign-off.
- [ ] **3.3** FireCrawl extraction schema expansion (tracking IDs, OG meta, emails / phones, outlinks)
  - Feeds 3.2's GA/AdSense rule — sequence 3.3 before 3.2.

---

## PHASE 4 — REGISTRIES & WATCHLISTS (free keys)

- [ ] **4.1** `sanctions_screen` (OpenSanctions; OFAC secondary)
  - Genuinely new. Note the false-positive profile: name-only matching is the exact weak-linkage class PR #414 quarantines. Must emit `subject_unlinked` unless matched on a concrete selector.
- [ ] **4.2** `court_search` (CourtListener v4)
  - Genuinely new as an API tool. CourtListener currently appears only inside `google_dorks` query strings (`:3168`, `:3194`, `:3195`, `:3386`) — i.e. as a suggestion to a human, never fetched.
- [ ] **4.3** `registry_search` (Companies House + SEC EDGAR)
  - ⚠ **PRE-EXISTING (adjacent)**: `opencorporates_search` (`:2912`) and `gleif_lei_search` (`:2857`). Companies House and EDGAR are new sources; confirm they are not redundant before adding two more.
- [ ] **4.4** `blockchain_lookup` (Blockchair keyless tier)
  - ⚠ **PRE-EXISTING**: `crypto_wallet` (`:3004`) already calls `api.blockchair.com` (`:3015`) and has a shared error helper (`blockchairError`). Likely an extension of that tool, not a new one.

---

## PHASE 5 — PAID (pauses for secrets)

- [ ] **5.1** `twilio_lookup` (line-type / burner detection)
  - Genuinely new. No `TWILIO_*` key in the provisioned list — this item pauses for a secret.

---

## PHASE 6 — EVIDENCE & OUTPUTS

- [ ] **6.1** `record_artifacts` v2 (sha256 + raw capture + screenshot hook)
  - ⚠ **INTEGRITY-CRITICAL — SIGN-OFF REQUIRED.** `evidence_log` already implements SHA-256 `content_hash` over 9 pipe-joined fields plus `chain_hash = sha256(prev || content_hash)`. Scored fields are permanently forward-only. This must **extend** the existing chain, never replace it, or every historical row's chain verification breaks.
- [ ] **6.2** Export pack: GraphML / Cypher, STIX / MISP CSV, MD / PDF report with confidence + custody appendix, timeline JSON
  - Lands in `evidence-export`, which per CLAUDE.md has **drifted** from `main` (mirror runs an older 273-line `index.ts` with no `text-sanitize.ts`). Reconcile the drift before adding formats, or the new exporters ship against stale code.
- [ ] **6.3** Cross-case entity edges table + `memory_recall` graph query
  - Requires a migration. Migrations do **not** reach production by merging — they go through the Lovable-owned channel and need post-apply verification.

---

## PHASE 7 — VERIFY

- [ ] **7.1** Smoke-test every new tool with fixture entities; health rows appear
  - Fixtures must use RFC 2606 / RFC 5737 reserved values. Real third-party selectors must never enter the repo.
  - "Health rows appear" is per-thread: a row appears only for a tool that *executed on that thread*.
- [ ] **7.2** Rate-limit ledger enforcement (per-provider token buckets)
  - **Net-new.** No per-provider bucket exists today; only `MIN_START_GAP_MS`, `MAX_PARALLEL_TOOLS` (queue, not semaphore), a 400 ms same-tool cooldown, and a per-origin circuit breaker.
  - Any bucket held in module memory shares the durability gap in `INSIGHT_FINDER_CONTEXT.md` §4 — it will not survive a cold isolate or bound concurrent runs on one thread.
- [ ] **7.3** Final audit: every checklist item closed or annotated

---

## Cross-cutting notes

- **Registration is two-sided.** Every new tool needs a `catalog.ts` entry **and** a `tool-registry.ts` runtime definition. `catalog_contract_test.ts` enforces 1:1 with no exemptions and will fail loudly on either half alone.
- **Also update per tool**: `costs.ts`, `capabilities.ts` (`PROVIDER_REQUIREMENTS`), `source-classification.ts`, `cache.ts` timeout map, and the hand-maintained `availableToolsForAudit` set (`tool-registry.ts:5254`) until it is replaced.
- **Nine new tools bring the catalog from 107 to ~116** while `activeTools` is still the full registry on every ordinary step, and `system-prompt.ts:116` still claims "~30 tools". Adding capability without narrowing selection widens the surface the model must reason over.
- **Do not flip** `FORCE_TOOL_CALL_UNTIL_FINALIZE` or `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`. Both are pinned by tests for documented incident reasons.
- **Open PRs touching this surface**: #418 (infra extraction, clean on main), #414 (name-only quarantine), #413 (sweeper existence evidence). All three merge cleanly in that order.
- **Deploy**: merge → `npm run stamp:build` → surgical mirror sync → explicit Lovable deploy → verify the `/health` build SHA moved. A mirror push is not a deploy.
