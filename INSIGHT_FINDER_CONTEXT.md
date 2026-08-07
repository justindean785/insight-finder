# INSIGHT_FINDER_CONTEXT.md

Phase 0 context record. Written 2026-08-07 against `origin/main` @ `c820195`
(behavior commit `04decb5`, which is the live production build).

Everything in the "Verified" sections was read out of the code or measured
against production on that date. Everything in "As supplied" is reproduced
verbatim from the task brief and is annotated where it diverges from the code.

---

## 1. Stack

| Layer | Technology |
|---|---|
| Frontend | Vite + React + TypeScript + Tailwind / shadcn, deployed on Vercel from `main` |
| Backend | Supabase (Postgres / Auth / Storage) |
| Edge functions | Deno — `osint-agent`, `evidence-export`, `security-test-lab`, sharing `supabase/functions/_shared/` |
| Orchestrator model | DeepSeek `deepseek-v4-pro` (pinned); MiniMax is the healthy fallback |
| Supabase project | `skzqwbyvmwqarfgfvyky` (owned by Lovable Cloud, not by the account holder) |

Backend deploys go through the Lovable project, never `supabase functions deploy`.
A mirror push syncs code only — the edge-function deploy is a separate explicit
step, and the only proof of deploy is a moved `/health` build SHA. See CLAUDE.md.

---

## 2. Paths found (Phase 0.3)

### Tool registry — authoritative
| What | Path |
|---|---|
| Runtime tool definitions (`buildTools`) | `supabase/functions/osint-agent/tool-registry.ts` (5533 lines) |
| Tool catalog the model reads via `list_tools` | `supabase/functions/osint-agent/catalog.ts` (107 entries) |
| Catalog↔runtime contract test | `supabase/functions/osint-agent/catalog_contract_test.ts` |

Four tools are defined in `tools/*.ts` and imported into the registry:
`tools/dns-virtual.ts` (:51), `tools/peopledatalabs.ts` (:78),
`tools/gemini_vision.ts` (:79), `tools/serus.ts` (:108).

`tools/index.ts` (barrel) and `tools/meta.ts` (a second, differently-filtered
`list_tools`) are **dead** — nothing imports the barrel. Do not treat
`tools/meta.ts` as authoritative; it never executes.

### Reference tool implementations
| Tool | Path : line | Notes |
|---|---|---|
| `leakcheck_lookup` | `tool-registry.ts:1637` | Keyed provider; returns `skipped:true` on missing key, rate-limit, and unsupported query type |
| `google_dorks` | `tool-registry.ts:3024` | **Generator, not a search tool.** In-code comment: *"google_dorks is intentionally ungated — it only emits search URLs."* Performs no network I/O |
| `dork_harvest` | `tool-registry.ts:3347` | The executing, relevance-gated dork stage (Perplexity Sonar, Exa fallback, bounded Gemini read) |
| `gemini_deep_dork` | `tool-registry.ts:3688` | Documented fallback, ~46% success in production telemetry |
| `whois_lookup` | `tool-registry.ts:2405` | 13-line **RDAP** wrapper over `rdap.org`. Keyless. Item 1.1 hardens it |
| `username_sweep` | `tool-registry.ts:2418` | ~95-platform HTTP existence sweep. Reworked by #413 (`5bd6ead`) |

### Health / audit recording path
| Stage | Path : line |
|---|---|
| Write (single insert site) | `supabase/functions/osint-agent/cache.ts:678` (legacy-shape retry at `:683`) |
| Outcome classification (backend) | `supabase/functions/osint-agent/tool-outcome.ts` |
| Coverage read (thread-scoped) | `tool-registry.ts:5281` `callsForThread()` |
| Utilization read | `tool-registry.ts:5412` `tool_audit` |
| Outcome taxonomy (frontend) | `src/lib/tool-outcome.ts` — 11 canonical outcomes |
| Health hook | `src/hooks/useThreadToolHealth.ts` |
| Health UI | `src/components/panel/ToolHealthPanel.tsx` |

`tool_usage_log` live columns (queried from production):
`id, user_id, thread_id, tool_name, cost_micro_usd, cached, ok, duration_ms,
created_at, error_msg, status_code, input_json, charged_micro_usd, outcome`

There is **no** `run_id`, `selector_type`, `objective`, `result_class`,
`findings_kept`, or `observation_id` column. The stored `outcome` is the coarse
4-value form (`ok | skipped | empty | failed`); the 11-category taxonomy is
derived client-side only, so measured-empty vs unmeasured is **not** persisted.

### Secrets access pattern
| What | Path |
|---|---|
| Central bindings | `supabase/functions/osint-agent/env.ts` |
| Pattern | `export const X_API_KEY = Deno.env.get("X_API_KEY")` — module scope, read once per isolate |
| Per-tool gating | Tools self-skip when their key is absent, returning `{ skipped: true, error: "…not configured" }` |
| Capability gating | `capabilities.ts` `PROVIDER_REQUIREMENTS`, plus a hand-maintained set at `tool-registry.ts:5254` |

`env.ts` carries a logging policy worth honouring in every new tool: log tool
names, statuses, error codes, durations, cost counters — never seeds, raw
request bodies, full API responses, breach contents, extracted PII, JWTs, or keys.

---

## 3. Deno rules for this project (Phase 0.2 requirement)

| Rule | Status | Evidence |
|---|---|---|
| fetch-only HTTP | **Confirmed.** Use `fetchRetry` / `fetchT` from `fetch_retry.ts`, not bare `fetch`, so timeouts and retry policy apply | `fetch_retry.ts` |
| Web Crypto for SHA-256 | **Confirmed and already the house style.** `crypto.subtle.digest("SHA-256", …)` | `archiver.ts:125`, `safety.ts:139`, `tool-registry.ts:1156`, `:4000`. SHA-1 also in use at `:2836` for the HIBP k-anonymity range API |
| No Node `crypto` | **Confirmed.** Zero `node:` specifiers anywhere under `supabase/functions/` | grep |
| **`npm:` specifiers DO work** | **Confirmed — heavily used.** `npm:ai@6`, `npm:@supabase/supabase-js@2`, `npm:@ai-sdk/openai-compatible@1`, `npm:pdf-lib@1.17.1`, `npm:fflate@0.8.2` | `env.ts:19`, `auth.ts:7,9`, `cache.ts:7,8`, `evidence-export/index.ts:4-6` |
| `deno.json` | `{"nodeModulesDir": "none"}` — npm specifiers resolve without a `node_modules` dir | `supabase/functions/osint-agent/deno.json` |
| Secrets | `Deno.env.get` only, via `env.ts` | see above |

**Consequence for the checklist:** murmur3 (item 2.6) does **not** require a
pure-TS implementation. An `npm:` specifier is available and consistent with
existing practice. A small pure-TS murmur3 is still the lower-risk choice —
it is ~40 lines, has no supply-chain surface, and avoids adding a dependency
to the cold-start path — but that is a preference, not a constraint.

**Hard constraint that is not negotiable:** there is **no subprocess capability**.
No `Deno.run`, `Deno.Command`, `child_process`, `execSync`, or `spawn` exists
anywhere under `supabase/functions/`, and the Supabase edge runtime does not
provide one. `whois`, `dig`, `nslookup`, `openssl`, `curl`, and `nmap` are
**analyst-manual** capabilities. They cannot be called by the agent and must not
appear as automated fallbacks in any routing graph.

Test command: `npm run test:edge` — `--allow-read` is required or the
source-level wiring tests abort with `NotCapable` before asserting.

### Sweep outcome vocabulary (#413, merged as `5bd6ead`)

`sweeper.ts` now reports one of four outcomes per site, and item 1.2 should keep
`tool_usage_log` on the same vocabulary:

| outcome | meaning |
|---|---|
| `found` | positive evidence — a configured `confirm` marker, or a whole-token echo of a handle ≥ 5 chars |
| `not_found` | **proven** absence — a configured `absent` status, a configured `absent` body marker, or a bare 404/410 |
| `unverified` | reached, nothing proved either way — a 2xx whose body does not evidence the account, **or** a refusal (401/403/451) where the account may exist behind the wall |
| `error` | the question was never answered — 429, 5xx, timeout, network failure, budget exhaustion |

`missed` is proven absence only; unreachable sites are listed under `errored`.

**Known residual:** a platform that repeats the requested handle on its own
not-found page still passes the echo test. `confirm` is deliberately unpopulated
— each marker must be measured against the live platform, and **92 of 99 sites
return HTTP 403 at the agent proxy**, so that measurement needs an environment
with open egress. Inventing markers would manufacture the false confidence the
change exists to remove. Item 2.11 is the approved bounded mitigation.

---

## 4. Orchestrator constraints (verified in code)

| Constant | Value | Defined in | Scope |
|---|---|---|---|
| `MAX_ORCHESTRATOR_STEPS` | 22 | `orchestrator-budget.ts:52` | request closure |
| `MAX_TOOL_CALLS_PER_RUN` | 36 | `orchestrator-budget.ts:153` | request closure |
| `MAX_TOTAL_CALLS` | 30 | `runtime-policy.ts:147` | request closure |
| `MAX_PAID_CALLS` | 12 | `runtime-policy.ts:163` | request closure |
| `MAX_SAME_TOOL_CALLS` | 16 | `runtime-policy.ts:211` | request closure |
| `MAX_CONCURRENT_CALLS` / `MAX_PARALLEL_TOOLS` | 3 | `runtime-policy.ts:162`, `:230` | request closure |
| `MIN_START_GAP_MS` | 100 (env-overridable) | `runtime-policy.ts:265` | request closure |
| `ORCHESTRATOR_WALL_CLOCK_MS` | 180 000 | `orchestrator-budget.ts:264` | request closure |
| `CONCURRENCY_BACKOFF_MS` | 250, max 5000 | `runtime-policy.ts:250-251` | — |
| `SAME_TOOL_COOLDOWN_MS` | 400 | `runtime-policy.ts:259` | — |
| `FORCE_TOOL_CALL_UNTIL_FINALIZE` | `false` | `orchestrator-budget.ts:73` | do not flip |
| `REQUIRE_TOOL_CALL_IN_OPENING_PHASE` | `true` | `orchestrator-budget.ts:99` | do not flip |

Behavioural notes every new tool must respect:

- **`MAX_PARALLEL_TOOLS` is not a semaphore.** `startCall` returns
  `{allow:true, …, waitMs}` (`runtime-policy.ts:474`) — overage is *delayed*,
  not refused.
- **`ALWAYS_ALLOW_TOOLS`** (`runtime-policy.ts:237`) — 9 recording/finalize
  tools bypass the total/paid/same-tool caps so a closing `record_artifacts`
  can never be starved. New tools must not be added to this set.
- **Every limit above is per-request and in-memory.** None survives a cold
  isolate, and `clearRuntime(threadId)` runs at the top of every request
  (`index.ts:316`). `index.ts:333-338` documents that `setupRequest` does not
  lock out a concurrently active run on the same thread.
- **`activeTools` is currently the full registry on every ordinary step.** The
  only narrowing anywhere is the persistence nudge:
  `activeTools: input.nudgePersistence ? ["record_artifacts"] : [...normalActiveTools]`
  (`orchestrator-budget.ts`).

`GRAPH_PIVOTS_ENABLED` and `ORCHESTRATOR_PROVIDER` are read from env; provider
is currently pinned to `deepseek`.

---

## 5. Rate-limit ledger (Phase 0.1 requirement)

**In-code controls that exist today** — these are all that is actually enforced:

| Control | Value | Scope |
|---|---|---|
| Start gap between tool calls | `MIN_START_GAP_MS` = 100 ms | per request |
| Parallelism | `MAX_PARALLEL_TOOLS` = 3, over-cap calls queue with escalating backoff | per request |
| Same-tool cooldown | 400 ms | per request |
| Same-tool ceiling | 16 calls | per request |
| Paid-call ceiling | 12 calls | per request |
| Circuit breaker | `circuit.ts` — per-origin, refcounted per thread, shared across overlapping runs | per thread |
| Provider suppression | `markToolDegraded(...)` on provider failure | per request |

**There is no per-provider token bucket.** Checklist item 7.2 is therefore net-new
work, not a change to an existing ledger.

**Per-provider vendor limits are NOT recorded here as fact.** The figures
circulating in prior handoffs (VirusTotal 4/min·500/day, Hunter 15 rps, LeakCheck
3 rps, PDL 10/min, Exa 10 QPS, Tavily 100/min, IPGeolocation 1k/day, GitHub 5k/hr,
FOFA ~1 rps, Nominatim 1 rps) are vendor-documentation claims that have **not**
been verified against this deployment's actual plan tiers. Item 7.2 should
establish them from response headers (`X-RateLimit-*`, `Retry-After`) and observed
429s rather than from documentation, and record them here once measured.

One vendor limit is worth respecting from day one regardless: **Nominatim's
public endpoint has a 1 req/sec usage policy**, and `nominatim_geocode`
(`tool-registry.ts:2790`) should be confirmed to honour it.

---

## 6. Tool ground truth

### 6a. As supplied in the task brief (verbatim)

Provisioned API keys: INDICIA, FOFA, VIRUSTOTAL, DEEPSEEK, PEOPLEDATALABS,
TAVILY, MINIMAX, RAPIDAPI, URLSCANNER, RANSOMWARELIVE, SERUS, SERUS_AI, DEEPFIND,
SYNAPSINT, OSINT_NAVIGATOR, GITHUB, PERPLEXITY, CORDCAT, GEMINI, EXA, FIRECRAWL,
IPGEOLOCATION, LEAKCHECK, INTELBASE, HUNTER, SOCIALFETCH, OSINTNOVA, OATHNET.

Wired internal tools with last-known health: `serus_darkweb_scan` (4 OK / 2 skip),
`gemini_deep_dork` (2 OK / 2 skip), `minimax_web_search` (3 OK), `whois_lookup`
(0 OK / 1 skip / 3 no-record — BROKEN), `nominatim_geocode` (2 OK),
`leakcheck_lookup` (1 OK / 1 skip), `minimax_correlate` (0 OK / 2 skip — GATED),
`record_artifacts` (13 OK), `indicia_person` (1 OK), `pdl_person_enrich` (0 OK),
`memory_recall` (19 OK), `google_dorks` (7 OK), `github_code_search` (3 OK),
`memory_save` (3 OK), `dns_records` (1 OK), `finalize_no_findings`,
`unknown_tool_ignored`, `username_sweep`, `minimax_extract`.

### 6b. Verified corrections to 6a

These are measurement-provenance corrections, not disagreements about intent.

| Claim | Verified state |
|---|---|
| "19 wired internal tools" | **107.** `catalog.ts` has 107 entries, 1:1 with `buildTools()`, enforced with no exemptions by `catalog_contract_test.ts:50`. The 19 are the tools that *executed on one thread* — the Health tab reads `tool_usage_log` filtered by `thread_id` (`useThreadToolHealth.ts:11`) |
| `whois_lookup` **BROKEN** | Not broken. It is a keyless RDAP wrapper with **no `skipped` branch at all** — its only outcomes are `ok: r.ok` or a thrown error. "3 no-record" are `rdap.org` 404s, which is routine (RDAP does not cover many ccTLDs). That is `measured_empty`, not failure. The single "skip" cannot have originated in the tool and must be orchestrator-level (dedup / circuit / budget) |
| `minimax_correlate` **GATED** | Not gated by config or cost. `tool-registry.ts:553-566` is an **input guard**: it refuses when `seed` is empty or zero valid artifacts were passed, with the comment *"never spend a paid MiniMax call on an empty/invalid payload."* The model is invoking it with nothing to correlate. This is an orchestration defect (`invalid_candidate`), not a provider failure |
| `google_dorks` 7 OK = reliable discovery | It is a **generator**. It emits dork strings and `google.com/search?q=…` URLs and never contacts Google, so a 100% success rate is a property of string templating. Zero of those 7 calls fetched a page. It must never receive discovery-yield credit |
| "OK / Skipped / No record" is the outcome space | The stored column is 4-valued; the derived taxonomy is 11-valued (`src/lib/tool-outcome.ts`). ~30 distinct code conditions return `skipped:true` — missing key, NXDOMAIN, provider 429, unsupported query type, invalid URL, HTTP 451, dedup gate. They cannot share one reliability score |
| Shodan / HIBP not provisioned | Both are **wired and keyless-or-key-gated in the always-on block** (`tool-registry.ts:5275-5279`): `shodan_internetdb` (the keyless InternetDB endpoint) and `hibp_lookup` |
| `pdl_person_enrich` is mirror-only | It is on `main` — `tool-registry.ts:78` imports it from `tools/peopledatalabs.ts` |
| `ipqualityscore_lookup` available | **Cut 2026-07-05** (dead key), disabled in `capabilities.ts` |

"Wired" is not the same as "currently callable". The available set is rebuilt
per deploy from env keys (`tool-registry.ts:5254-5279`), then further filtered by
readiness, circuit state, and policy.

---

## 7. Known source-of-truth defects (recorded, not yet fixed)

1. **`callsForThread()`** (`tool-registry.ts:5281`) scopes coverage to
   `thread_id`, treats `ok=true` as coverage, and discards the query `error` so a
   failed read silently becomes "nothing was called". Its only consumer is
   `coverage_audit`, which is **advisory** by explicit design
   (`workflow_prompt.ts:32`; `recovery.ts:78` lists `coverage_audit`/`tool_audit`
   in `NON_EVIDENCE_KINDS`). So the harm is advisory contamination across runs,
   not a gate bypass — there is no coverage-keyed finalization gate today.
2. **`CATALOG_CACHE` caches nothing** (`tool-registry.ts:302-311`). `filtered` is
   rebuilt and returned on every call; the cached value is only ever read as a
   boolean for `cached_for_investigation`. It also stores *unfiltered*
   `TOOL_CATALOG` while returning *filtered* — serving the cached value without
   fixing that would start advertising provider-disabled tools.
3. **`availableToolsForAudit`** (`tool-registry.ts:5254`) is a third
   hand-maintained registry holding 64 of 107 names. Already drifted:
   `breach_check` is listed only when `STOLENTAX_API_KEY` is set, but the runtime
   falls through to a keyless leakcheck endpoint when the key is absent — the
   tool works without it.
4. **Contract tests prove static parity only.** `catalog_contract_test.ts` calls
   `buildTools(stubCtx())` and compares name sets; it never executes
   `list_tools`, applies readiness, or checks a consumer.
5. **`system-prompt.ts:116`** tells the model *"You have ~30 tools"* against a
   real 107.
6. **Comment drift**: `index.ts:862` says "240s − 90s = 150s" while the constant
   is 180 s, and `orchestrator-budget.ts:252` explicitly refutes the 240 s value.
   `index.ts:855` references a "~80% of the tool budget" soft trigger that was
   removed. `system-prompt.ts` still carries 9 MiniMax-as-primary references
   while production is pinned to DeepSeek.

---

## 8. Integrity rules — changes here require explicit sign-off

Evidence ranking, confidence caps, chain-of-custody, credential masking,
minor-safety detection, source classification, analyst review/exclusion, and
clustering/merge behaviour are integrity-critical.

Specifically relevant to checklist item 6.1: `evidence_log` already implements a
content hash and a hash chain — `content_hash` is SHA-256 over 9 pipe-joined
fields and `chain_hash = sha256(prev || content_hash)`. Scored fields are
**permanently forward-only**; `archive_*` columns sit outside the hash and are
safely backfillable. Any "record_artifacts v2" work must extend that scheme
rather than replace it, and needs sign-off before it lands.
