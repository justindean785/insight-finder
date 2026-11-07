# Context.dev Tool Set (3 tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: PLAN — awaiting JD's approval before any code is edited** (the brief says "Plan first").

**Goal:** Add Context.dev as a provider in `osint-agent` with exactly three tools — `contextdev_web_search`, `contextdev_scrape`, `contextdev_people_search` — wired through every house checkpoint, with prefer-free-first routing, in-run URL dedup, bounded retries, hard response trimming, a kill switch and one `/health` proof key.

**Architecture:** One pure provider module, `lib/contextdev.ts`, with injected `fetch`/clock/sleep (the house pattern since Opsis, `lib/opsis.ts`, 2026-10-01: zero imports, testable in milliseconds with a scripted fetch). Three inline `name: tool({...})` entries in `tool-registry.ts` delegate to it, exactly as `opsis_search` does. Everything else is table entries in the existing checkpoint files. **Edge-only PR, no frontend files, no schema change.**

**Tech Stack:** Deno edge function, AI SDK `tool()` + zod (`memoSchema`), Deno std assert tests under `supabase/tests/osint-agent/lib/`.

**Spec:** the uploaded brief `claude-code-context-dev-tool-integration-2026-11-03.md` (Objective → Return) and the Context.dev API reference pages read 2026-11-03 (`api-reference/web/search`, `api-reference/web/scrape`, `api-reference/people/search`, `account/credits`, pricing page). Exact values below are copied from those pages.

## 0. Where the brief's file map is stale (read before executing)

The brief was written against an older layout. Verified on `main` `e872203`:

| Brief says | Reality on `main` | Plan uses |
|---|---|---|
| tools are `tool({...})` entries in `index.ts` `streamText` | `index.ts` has **zero** tool defs; live defs are `buildTools()` in `tool-registry.ts` (CLAUDE.md) | `tool-registry.ts` |
| env binding "at top of `index.ts`" | provider keys live in `env.ts` (`OPSIS_API_KEY`, `EXA_API_KEY`, … lines 308–323); `index.ts` reads env only for flags | `env.ts` |
| "always use `fetchRetry`" | `fetch_retry.ts` **cannot honor `Retry-After`** (fixed `400ms·2^n` backoff on 429/5xx) and is not injectable, so a test cannot script a 429. Opsis, the newest provider, uses an injected `deps.fetch` with its own bounded policy. | injected fetch + module-level retry policy that *does* honor `Retry-After` (Task 1). Noted as a deliberate deviation. |
| `toolList` array | `baseToolList` (`tool-registry.ts:1153`) filtered into `toolList` (`:1240`) with per-key gates | add to `baseToolList` + a key gate in the filter |
| 6 checkpoints | there are **eleven** files a provider touches here (see Task 3) — the contract tests (`catalog_contract_test`, `costs_contract_test`, `tool_timeout_contract_test`) fail the PR if any is missed | all eleven |
| `tools/email.ts` Hunter dormant copy | `tools/*.ts` is a **stale mirror**, not runtime (CLAUDE.md) | not touched; flagged only |
| "note Opsis missing from planner base list" | **confirmed**: `opsis_search`/`opsis_results` absent from `baseToolList` (grep of `:1153–1240`) | flagged in PR body, not fixed |
| `a.source ?? null` empty-source gap | not re-verified in this pass | flagged in PR body as "reported, unverified" |

**Branch-name discrepancy, JD's call:** the branch is `claude/people-enrichment-api-er67pv` and the uploaded reference is `POST /people/enrich` (20 credits/match), but the brief's scope says **do NOT add people enrich** in this PR. This plan follows the brief. Enrich is listed as follow-up #1 — note that `pdl_person_enrich` (People Data Labs) already fills that slot, so enrich would need its own overlap rule.

## Global Constraints

- Tool names, exact: `contextdev_web_search`, `contextdev_scrape`, `contextdev_people_search`.
- Secret env name, exact: `CONTEXT_DEV_API_KEY`. Never created, printed, logged, committed, or placed in any tool output. Auth header `Authorization: Bearer <key>`.
- Base URL: `https://api.context.dev/v1`. Endpoints: `POST /web/search`, `POST /web/scrape`, `POST /people/search`.
- Kill switch, read at CALL time: `CONTEXT_DEV_DISABLED=true` → every contextdev tool returns the house "not configured" skip and the three tools are removed from the schema.
- Credit → USD: **$0.002 per credit** (Developer plan, $20 / 10,000 credits; also Pro overage $2.00 per 1,000). Source: context.dev pricing page + `docs.context.dev/account/credits.md`, read 2026-11-03. Costs in `costs.ts` are micro-USD: `contextdev_web_search` 2,000 (1 credit per 10 results; `highlights` adds 1 credit — the entry is the default, not the ceiling), `contextdev_scrape` 2,000 (1 credit, markdown only, no modifiers), `contextdev_people_search` 20,000 (10 credits per non-empty page, `fast` mode only; empty pages are free upstream).
- Trimming caps: search ≤10 results, snippet ≤600 chars, highlights ≤4 × 280 chars; scrape markdown ≤2,000 chars with `truncated:true`; people ≤10 results. No raw HTML, screenshots, or full-page markdown ever leaves the module.
- Failure shape: provider errors return `{ ok:false, status, error:<CONSTANT>, error_code?, provider_message? (≤200 chars) }`. Never throw. Never `skipped:true` for a provider error (a tool-emitted skip is logged as outcome "ok" and hides the failure from `checks.credentials` — the Opsis lesson in `lib/opsis.ts` header).
- Retry policy: 429 → honor `Retry-After` seconds (cap 10 s, default 1 s if absent), 1 retry; 408/5xx → `500ms·2^attempt`, 2 retries; network error/timeout → 1 retry unless the wrapper signal aborted; **any other 4xx → no retry**.
- People search: one page per call. `cursor` is NOT in the input schema; `has_more` is returned as a boolean only. `PREMIUM_TOOLS` membership enforces one call per normalized query per investigation.
- Confidence/authority: scrape = `independent_public` (page observation); web search = `ai_summary` (discovery, never corroboration); people search = `data_broker` (cap 60, NEVER_HIGH, lead only). No change to `confidence.ts`, `record_finding`, reveal, lease or model config.
- Small-PR rule: this is ONE edge PR with ONE new `/health` key (`checks.contextdev`). Docs ride separately.
- Bundle: `osint-agent` is 2,973,184 bytes; limit 4,300,000. Tests go under `supabase/tests/osint-agent/lib/`, never in the function folder.

## Review Focus

Inputs the spec implies but no requirement names; each has a test added to its owning task.

1. **A 200 with a failed output** — scrape returns HTTP 200 with `markdown.success:false` + `error_code` (e.g. `WEBSITE_BLOCKED`). Expected: `ok:false`, not an empty "page". (Task 2)
2. **A search result whose `description` is the empty string** (documented: "empty when the provider supplies no snippet"). Expected: `snippet` omitted, result kept. (Task 2)
3. **`Retry-After` that is absurd or non-numeric** (`Retry-After: 3600`, `Retry-After: Wed, …`). Expected: wait is capped at 10 s / falls back to 1 s; never a minute-long stall inside a tool cap. (Task 1)
4. **A URL that cannot be parsed** (`javascript:`, bare text) in a result. Expected: `canonicalUrl` returns `null`, the item is dropped and counted in `dropped_invalid`, not thrown. (Task 1)
5. **People query containing a private individual's name with no professional disambiguator.** The API will answer; the result must still carry `authority:"lead"` and be denylisted from auto-persist so a stranger cannot enter the subject cluster. (Task 3 — denylist test)

---

### Task 1: `lib/contextdev.ts` core — deps, gate, request/retry, URL canon + dedup

**Files:**
- Create: `supabase/functions/osint-agent/lib/contextdev.ts`
- Test: `supabase/tests/osint-agent/lib/contextdev_test.ts`

**Interfaces:**
- Consumes: nothing (zero imports, like `lib/opsis.ts`).
- Produces:
  ```ts
  export const CONTEXT_DEV_BASE_URL = "https://api.context.dev/v1";
  export const CONTEXT_DEV_API_KEY_ENV = "CONTEXT_DEV_API_KEY";
  export const CONTEXT_DEV_DISABLED_ENV = "CONTEXT_DEV_DISABLED";
  export const CONTEXT_DEV_PROVIDER = "context.dev";
  export const CONTEXT_DEV_SEARCH_TIMEOUT_MS = 20_000;
  export const CONTEXT_DEV_SCRAPE_TIMEOUT_MS = 30_000;
  export const CONTEXT_DEV_PEOPLE_TIMEOUT_MS = 25_000;
  export const CONTEXT_DEV_RETRY_AFTER_CAP_MS = 10_000;
  export const CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS = 1_000;
  export const CONTEXT_DEV_ERRORS = {
    not_configured: "CONTEXT_DEV_API_KEY not configured",
    disabled: "context.dev provider disabled in config",
    http: "context.dev request failed",
    network: "context.dev request did not complete",
    output_failed: "context.dev scrape output failed",
  } as const;
  export interface ContextDevDeps {
    apiKey: string | undefined; disabled: boolean;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  }
  export function contextdevKillSwitchOn(env?: (k: string) => string | undefined): boolean;
  export function contextdevDepsFromEnv(signal?: AbortSignal): ContextDevDeps;
  export function contextdevGate(deps: Pick<ContextDevDeps,"apiKey"|"disabled">): Record<string,unknown> | null;
  export function canonicalUrl(raw: unknown): string | null;   // lowercase scheme+host, drop hash, strip utm_*/fbclid/gclid/mc_cid/mc_eid/igshid, collapse trailing slash on path "/"
  export function dedupByUrl<T extends { url: string }>(items: T[], seen: Set<string>): { kept: T[]; deduped: number; dropped_invalid: number };
  export type ContextDevHttp =
    | { ok: true; status: number; json: Record<string, unknown>; credits_consumed?: number; request_id?: string }
    | { ok: false; status: number | null; error: string; error_code?: string; provider_message?: string; retries: number };
  export async function contextdevRequest(path: "/web/search"|"/web/scrape"|"/people/search", body: Record<string,unknown>, deps: ContextDevDeps, timeoutMs: number): Promise<ContextDevHttp>;
  export function contextdevHealthDetail(hasKey: boolean, disabled: boolean): { ok: true; detail: string };
  ```

- [ ] **Step 1: Write the failing tests** (scripted-fetch harness copied from `opsis_test.ts` lines 20–55: `harness({ replies, apiKey, disabled, signal })` returning `{ deps, calls, elapsed }` with a fake clock that `sleep` advances)

```ts
Deno.test("gate: missing key → not-configured skip, no fetch", () => {
  const out = contextdevGate({ apiKey: undefined, disabled: false });
  assertEquals(out, { error: CONTEXT_DEV_ERRORS.not_configured, skipped: true, provider_attempted: false });
});
Deno.test("gate: kill switch → disabled skip", () => { /* disabled:true → CONTEXT_DEV_ERRORS.disabled, skipped:true */ });
Deno.test("gate: key present and enabled → null", () => {});
Deno.test("canonicalUrl: lowercases host, strips tracking params, drops hash, keeps path case", () => {
  assertEquals(canonicalUrl("HTTPS://Example.COM/Path?utm_source=x&b=2&fbclid=1#frag"), "https://example.com/Path?b=2");
  assertEquals(canonicalUrl("https://example.com/"), "https://example.com/");
  assertEquals(canonicalUrl("https://example.com"), "https://example.com/");
  assertEquals(canonicalUrl("javascript:alert(1)"), null);
  assertEquals(canonicalUrl("not a url"), null);
  assertEquals(canonicalUrl(42), null);
});
Deno.test("dedupByUrl: same URL twice in one batch → one kept, deduped 1; seen set carries across calls", () => {
  const seen = new Set<string>();
  const a = dedupByUrl([{ url: "https://a.com/x?utm_source=1" }, { url: "https://A.com/x" }, { url: "nope" }], seen);
  assertEquals(a.kept.length, 1); assertEquals(a.deduped, 1); assertEquals(a.dropped_invalid, 1);
  const b = dedupByUrl([{ url: "https://a.com/x" }, { url: "https://b.com/" }], seen);
  assertEquals(b.kept.map((k) => k.url), ["https://b.com/"]); assertEquals(b.deduped, 1);
});
Deno.test("request: sends bearer auth + JSON body to BASE_URL+path, returns json + credits on 200", async () => {
  // reply json(200, { results: [], key_metadata: { credits_consumed: 1, credits_remaining: 9 }, request_id: "r1" })
  // assert calls[0].url === "https://api.context.dev/v1/web/search", headers.Authorization === "Bearer test_key", out.credits_consumed === 1
});
Deno.test("request: 429 with Retry-After: 2 → sleeps 2000ms, retries once, succeeds", async () => { /* elapsed() >= 2000, calls.length === 2 */ });
Deno.test("request: 429 Retry-After: 3600 → wait capped at 10_000ms; non-numeric → 1_000ms", async () => {});
Deno.test("request: 429 twice → ok:false status 429, retries 1, error_code RATE_LIMITED", async () => {});
Deno.test("request: 503 → backoff 500ms then 1000ms, 2 retries, then ok:false status 503", async () => { /* calls.length === 3 */ });
Deno.test("request: 408 is retried like 5xx", async () => {});
Deno.test("request: 400 / 402 / 422 → ok:false, status, error_code from body, NO retry, provider_message ≤ 200 chars", async () => { /* calls.length === 1 each */ });
Deno.test("request: thrown network error → one retry, then ok:false status null error network", async () => {});
Deno.test("request: already-aborted signal → no retry, ok:false, calls.length === 1", async () => {});
Deno.test("request: error path never echoes the api key", async () => { /* JSON.stringify(out) does not include "test_key" */ });
Deno.test("healthDetail: disabled / unset / configured strings", () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read lib/contextdev_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the exports above in `lib/contextdev.ts`.** `contextdevRequest`: per-attempt `AbortController` + `setTimeout(timeoutMs)` chained to `deps.signal` (copy the `abortableSleep`/signal pattern from `lib/opsis.ts:78–90`); parse `Retry-After` with `Number.parseInt`, `Number.isFinite` guard, `Math.min(secs*1000, CAP)`; read `error_code`/`message` from the JSON body when present; `provider_message = message.slice(0,200)`.

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit** — `feat(osint-agent): lib/contextdev.ts core — deps, gate, retry policy, URL canon + dedup`

---

### Task 2: Shapers and the three tool functions

**Files:**
- Modify: `supabase/functions/osint-agent/lib/contextdev.ts`
- Test: `supabase/tests/osint-agent/lib/contextdev_test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  ```ts
  export const CONTEXT_DEV_SEARCH_MAX_RESULTS = 10;   // 1 credit per 10 → never more than 1 credit base
  export const CONTEXT_DEV_SNIPPET_MAX_CHARS = 600;
  export const CONTEXT_DEV_HIGHLIGHTS_MAX = 4; export const CONTEXT_DEV_HIGHLIGHT_MAX_CHARS = 280;
  export const CONTEXT_DEV_MARKDOWN_MAX_CHARS = 2_000;
  export const CONTEXT_DEV_PEOPLE_MAX_RESULTS = 10;
  export interface SearchInput { query: string; numResults?: number; includeDomains?: string[]; excludeDomains?: string[]; freshness?: "last_24_hours"|"last_week"|"last_month"|"last_year"; highlights?: boolean }
  export interface ScrapeInput { url: string; fresh?: boolean }          // fresh:true → maxAgeMs: 0, else provider default (3 days)
  export interface PeopleInput { query: string; countries?: string[] }   // mode is ALWAYS "fast"; no cursor
  export function shapeSearchResponse(raw: unknown, seen: Set<string>): Record<string, unknown>;
  export function shapeScrapeResponse(raw: unknown): Record<string, unknown>;
  export function shapePeopleResponse(raw: unknown, seen: Set<string>): Record<string, unknown>;
  export async function contextdevWebSearch(input: SearchInput, deps: ContextDevDeps, seen: Set<string>): Promise<Record<string, unknown>>;
  export async function contextdevScrape(input: ScrapeInput, deps: ContextDevDeps): Promise<Record<string, unknown>>;
  export async function contextdevPeopleSearch(input: PeopleInput, deps: ContextDevDeps, seen: Set<string>): Promise<Record<string, unknown>>;
  ```
  Output shapes (success):
  - search: `{ ok:true, provider:"context.dev", query, results:[{ url, title, snippet?, relevance, highlights? }], count, deduped, dropped_invalid, partial?, credits_consumed?, request_id? }`. Request body sent: `{ query, numResults: min(n,10), includeDomains?, excludeDomains?, freshness?, highlightsOptions?: { enabled:true, query }, timeoutOpts: { milliseconds: 15_000, behavior: "return-partial" } }` — provider deadline sits under our 20 s fetch cap. Only `highlights.code === "SUCCESS"` passages are kept.
  - scrape: `{ ok:true, provider, url, url_canonical, final_url, title, markdown, chars, truncated, cache_status, credits_consumed?, request_id? }`. Body: `{ url, formats: { markdown: true }, sharedParams: { mainContentOnly: true }, maxAgeMs?: 0, timeoutOpts: { milliseconds: 25_000, behavior: "fail" } }`. `markdown.success !== true` → `{ ok:false, status:200, error: CONTEXT_DEV_ERRORS.output_failed, error_code: markdown.error_code, provider_message }`.
  - people: `{ ok:true, provider, query, results:[{ name, headline, profiles:string[], location:{ city?, region?, country? }, role:{ title?, company? }, years_of_experience? }], count, deduped (on profiles[0]), empty:boolean, has_more:boolean, authority:"lead", credits_consumed?, request_id? }`. Body: `{ query: query.slice(0,500), mode:"fast", filters?: { countries } }`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("search: trims to 10 results, snippet ≤600, highlights ≤4×280, drops tracking params, reports deduped", async () => {});
Deno.test("search: empty description → snippet omitted; empty results → ok:true count 0", async () => {});
Deno.test("search: request body has numResults ≤ 10, timeoutOpts return-partial, highlightsOptions only when asked", async () => {});
Deno.test("search: partial:true is passed through", async () => {});
Deno.test("scrape: 200 success → markdown capped at 2000 chars, truncated:true, chars = original length, title/final_url from metadata", async () => {});
Deno.test("scrape: 200 with markdown.success:false → ok:false, error output_failed, error_code WEBSITE_BLOCKED", async () => {});
Deno.test("scrape: fresh:true → maxAgeMs 0 in body; default omits maxAgeMs", async () => {});
Deno.test("people: trims to 10, maps name/headline/profiles/location/role, authority lead, has_more from next_cursor", async () => {});
Deno.test("people: empty results → ok:true, empty:true, count 0", async () => {});
Deno.test("people: body is mode fast, never contains cursor, query ≤ 500 chars", async () => {});
Deno.test("people: profile URL already in seen → deduped 1", async () => {});
Deno.test("each tool: missing key → gate skip without a fetch; provider 402 → ok:false status 402", async () => {});
Deno.test("each tool: no output field is HTML, screenshot or longer than its cap", async () => {});
```

- [ ] **Step 2: Run → FAIL (functions undefined).**
- [ ] **Step 3: Implement.** Each tool function = `contextdevGate` → build body → `contextdevRequest` → shaper. Shapers are defensive: every field type-checked, unknown shapes return `{ ok:false, status:200, error: CONTEXT_DEV_ERRORS.http, error_code:"UNEXPECTED_SHAPE" }`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(osint-agent): contextdev search/scrape/people shapers and tool functions`

---

### Task 3: Wire the eleven checkpoints

**Files (all under `supabase/functions/osint-agent/`):**
- Modify `env.ts:315` area — `export const CONTEXT_DEV_API_KEY = Deno.env.get("CONTEXT_DEV_API_KEY");` with a one-line comment (`lib/contextdev.ts`). No `!`.
- Modify `costs.ts:118` area — `// ---- Context.dev (docs.context.dev/account/credits, pricing page, 2026-11-03): $0.002/credit (Developer $20/10k) ----` then the three entries from Global Constraints.
- Modify `capabilities.ts:66` area — three `{ requiresKey: "CONTEXT_DEV_API_KEY" }` entries (this alone adds the key to `capabilityEnvKeys()` → `index.ts:540` presence map).
- Modify `circuit.ts:52` `PROVIDER_TOOLS` — `contextdev: ["contextdev_web_search","contextdev_scrape","contextdev_people_search"]`; `GENERAL_MULTI_ORIGIN_TOOLS` (`:140`) — add `contextdev_scrape`; `PREMIUM_TOOLS` (`:373`) — add `contextdev_people_search` with a comment (one page per query per investigation, 10 credits).
- Modify `source-classification.ts:91` `TOOL_CLASS` — `contextdev_web_search: "ai_summary"`, `contextdev_scrape: "independent_public"`, `contextdev_people_search: "data_broker"`; `PAGE_FETCH_TOOLS` (`:601`) — add `contextdev_scrape`.
- Modify `cache.ts:79` `TOOL_TIMEOUT_OVERRIDE_MS` — `contextdev_web_search: 25_000`, `contextdev_scrape: 35_000`, `contextdev_people_search: 30_000` (each ≥ 5 s above the module's own fetch cap so the module fails first — the `tool_timeout_contract` invariant); `AUTO_EVIDENCE_TOOLS` (`:2146`) — add `contextdev_scrape` (parity with `jina_reader_scrape`).
- Modify `auto-persist-findings.ts:55` `AUTO_PERSIST_TOOL_DENYLIST` and `:101` `ESCALATION_ELIGIBLE_TOOLS` — add all three (same class as `exa_search`/`jina_reader_scrape`: the model records good hits via `record_artifacts`, where `artifactDedupKey` is the write-path dedup; escalation keeps the zero-evidence durability path).
- Modify `catalog.ts:50` area — three `CatalogEntry` rows (see Task 4 copy for wording; `input` strings match the zod schemas exactly — `catalog_param_names_test` checks this).
- Modify `tool-registry.ts`:
  - import `{ contextdevDepsFromEnv, contextdevKillSwitchOn, contextdevPeopleSearch, contextdevScrape, contextdevWebSearch } from "./lib/contextdev.ts"` and `CONTEXT_DEV_API_KEY` from `./env.ts`;
  - inside `buildTools` next to `pendingQuarantineRows` (`:701`): `const contextdevSeenUrls = new Set<string>();` (per-request = per-run);
  - key-absent block (`:788`): `if (!CONTEXT_DEV_API_KEY || contextdevKillSwitchOn()) { for (const n of [...]) disabled.push({ name: n, reason: "Context.dev is not configured or switched off — use exa_search / jina_reader_scrape / indicia_person." }); }`;
  - `baseToolList` (`:1198` "Search + scrape" group): append the three names after `exa_find_similar`;
  - `toolList` filter (`:1240`): `if (name.startsWith("contextdev_") && (!CONTEXT_DEV_API_KEY || contextdevKillSwitchOn())) return false;`
  - three inline defs after `opsis_status` (`:3297`), each `memoSchema(name, () => z.object({...}))` and `execute: async (input, opts) => await contextdevWebSearch(input, contextdevDepsFromEnv(opts?.abortSignal), contextdevSeenUrls)` (scrape without the set). Schemas:
    - `contextdev_web_search`: `query: z.string().min(2).max(500)`, `numResults: z.number().int().min(1).max(10).default(10)`, `includeDomains/excludeDomains: z.array(z.string()).max(20).optional()`, `freshness: z.enum([...]).optional()`, `highlights: z.boolean().default(false)`.
    - `contextdev_scrape`: `url: z.string().url()`, `fresh: z.boolean().default(false)`.
    - `contextdev_people_search`: `query: z.string().min(3).max(500)`, `countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(5).optional()`. **No `cursor`, no `mode`.**
- Test: `supabase/tests/osint-agent/lib/contextdev_wiring_test.ts` (source-reading, like `reviews_wiring_test.ts`; needs `--allow-read`).

**Interfaces:** consumes Task 2 functions; produces the three runtime tools the contract tests enumerate.

- [ ] **Step 1: Write the failing wiring tests**

```ts
Deno.test("wiring: costs — each contextdev tool has an explicit non-zero cost", () => {
  for (const [n, c] of [["contextdev_web_search", 2_000], ["contextdev_scrape", 2_000], ["contextdev_people_search", 20_000]]) assertEquals(costForTool(n), c);
});
Deno.test("wiring: capabilities require CONTEXT_DEV_API_KEY and capabilityEnvKeys() lists it", () => {});
Deno.test("wiring: circuit provider is contextdev; scrape is multi-origin; people_search is premium", () => {});
Deno.test("wiring: source classes ai_summary / independent_public / data_broker; scrape is a page-fetch tool", () => {});
Deno.test("wiring: wrapper timeout cap exceeds the module fetch budget for all three", () => {
  assert(toolTimeoutMs("contextdev_web_search") > CONTEXT_DEV_SEARCH_TIMEOUT_MS); /* …scrape, people */
});
Deno.test("wiring: all three are auto-persist denylisted AND escalation-eligible", () => {});
Deno.test("wiring: catalog advertises all three with when_to_use naming the cheaper tool first", () => {});
Deno.test("wiring: tool-registry source has the three inline defs, the key gate, the baseToolList entries and the per-request seen set", () => {
  // regex over tool-registry.ts: /contextdev_web_search: tool\(\{/, /startsWith\("contextdev_"\)/, /"contextdev_people_search",/ inside baseToolList slice, /contextdevSeenUrls = new Set/
});
Deno.test("wiring: people_search schema has no cursor and no mode", () => { /* regex on the def body */ });
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Make the table edits listed above.**
- [ ] **Step 4: Run the new test file, then the three contract tests: `catalog_contract_test.ts costs_contract_test.ts tool_timeout_contract_test.ts catalog_param_names_test.ts` → PASS.** (`tool_timeout_contract` floor is `bodies.length >= 80`; three more inline defs are fine. Injected-set test is unaffected because the defs are inline, not `(tools as X).name = symbol`.)
- [ ] **Step 5: Commit** — `feat(osint-agent): wire contextdev_* through env, costs, capabilities, circuit, class, cache, catalog, registry`

---

### Task 4: System-prompt bullets, `/health` key, self-test

**Files:**
- Modify: `supabase/functions/osint-agent/system-prompt.ts:102` (after the WEB SEARCH + SCRAPE bullet)
- Modify: `supabase/functions/osint-agent/health-handler.ts:11` (import `CONTEXT_DEV_API_KEY`), `:361` (providers block: `contextdev: has(env.CONTEXT_DEV_API_KEY)` — moves the optional-tools denominator, the cheap "did the deploy ship capability" signal), `:600` area (`r.checks.contextdev = contextdevSelfTest(!!CONTEXT_DEV_API_KEY, contextdevKillSwitchOn());`)
- Modify: `lib/contextdev.ts` — add `export function contextdevSelfTest(hasKey: boolean, disabled: boolean): { ok: boolean; detail: string }` — pure: runs `canonicalUrl` + `dedupByUrl` on a fixed probe and the Retry-After parser on `"2"`, `"3600"`, `"garbage"`; `ok` is false if any expectation fails; `detail` = health-detail string + `"; selftest ok"`. PRESENCE proves the build; `ok:false` means canon/dedup regressed.
- Test: `supabase/tests/osint-agent/lib/contextdev_test.ts` (self-test) and `contextdev_wiring_test.ts` (prompt + health source checks).

System-prompt copy (exact; under two lines each, routing-first):

```
- CONTEXT.DEV (paid, $0.002/credit — PREFER FREE FIRST): \`contextdev_web_search\` { query, numResults≤10, includeDomains?, excludeDomains?, freshness?, highlights? } → up to 10 {url,title,snippet,relevance} (1 credit; highlights +1). Only AFTER \`exa_search\`/\`minimax_web_search\` returned empty, failed, or when Google-style operators (site:, inurl:, quoted phrases) or a freshness window are the point.
  • \`contextdev_scrape\` { url, fresh? } → page markdown ≤2,000 chars + title/final_url (1 credit; cached ~3 days unless fresh:true). Only when \`jina_reader_scrape\` (free) failed, was origin-blocked, or returned junk for that exact URL; never as the first reader.
  • \`contextdev_people_search\` { query, countries? } → ≤10 professional profiles {name, headline, profiles[], location, role} for a natural-language description (10 credits per non-empty page; ONE page per call; NEVER repeat the same query in a run). Distinct capability: role/employer/location descriptions that no selector tool answers. Results are LEADS [VERIFY], broker-grade (cap 60) — never identity proof; \`indicia_person\`/\`pdl_person_enrich\` stay first for a known name.
  • Overlap guard: a URL, person or company already collected by another provider is NOT re-fetched through Context.dev unless you deliberately need a second independent source — then record it with its own provenance (source: context.dev) and never merge authority. Results carry \`deduped: N\` for URLs already seen this run.
```

- [ ] **Step 1: Write the failing tests** — `contextdevSelfTest` returns `ok:true` with key, `ok:true` + "disabled via" when disabled; wiring: `SYSTEM_PROMPT` source contains all three names, the phrase `PREFER FREE FIRST`, `ONE page per call`, `never merge authority`; `health-handler.ts` source contains `r.checks.contextdev =` and `contextdev: has(env.CONTEXT_DEV_API_KEY)`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the three edits + self-test.** Check `prompt-size.ts` and any prompt-budget test after the edit (`grep -rn "SYSTEM_PROMPT" supabase/tests/osint-agent | grep -i "length\|size"`); if a byte ceiling is pinned, shorten the bullet, do not raise the ceiling.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(osint-agent): contextdev routing bullets + checks.contextdev health key`

---

### Task 5: Full verification, PR body, follow-ups

- [ ] **Step 1: Install Deno if absent** (`DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`) and run `npm run test:edge` with `--no-lock`. Expected: previous baseline (2828 passed / 0 failed / 6 ignored on `a753f56`) + the new tests, 0 failed. Paste the exact summary line.
- [ ] **Step 2: `npm run typecheck && npm run lint && npx vitest run`** — frontend untouched, so baseline must be unchanged (3037 passed / 1 skipped / 256 files on `5743177`; re-measure).
- [ ] **Step 3: `npx vitest run src/test/edge-deploy-bundle.test.ts src/test/catalog-guidance.test.ts`** → PASS (bundle still < 4,300,000 bytes).
- [ ] **Step 4: Confirm no file outside `supabase/functions/osint-agent/**` and `supabase/tests/osint-agent/**` changed** (`git diff --stat origin/main`), and `git grep -n "CONTEXT_DEV_API_KEY" -- ':!*.md'` shows only `Deno.env.get` reads and capability/health names.
- [ ] **Step 5: No live call.** The one optional 1-credit `contextdev_web_search` smoke is JD's call after deploy, not in CI.
- [ ] **Step 6: Push, mark the PR ready (not draft — CLAUDE.md: drafts never merge), PR body contains:**
  - the credit→USD conversion and its source;
  - deploy note: edge-only, ships via the `edge-deploy` skill after merge; proof = `/health` `checks.contextdev` present AND `tools.contextdev` in the provider block; secret `CONTEXT_DEV_API_KEY` added by JD via the secure form AFTER the mirror sync (rotate the exposed key first);
  - follow-up candidates with credits: `people/enrich` 20 per match (overlaps `pdl_person_enrich`), `web/answers` 10 fast / 100 ultra, `brand/retrieve` 10, `web/crawl` 1 per page, batches (reserved per URL), monitors 1–10 per run, `news/search` 1 per 10, `company/search` 2 fast / 10 ultra, `parse` 1 + OCR;
  - known adjacent gaps NOT fixed here: `opsis_search`/`opsis_results` absent from `baseToolList` (confirmed); dormant `tools/email.ts` Hunter diagnostic (stale mirror dir); `a.source ?? null` empty-source gap in `tool-registry.ts` (reported, not re-verified);
  - remaining risks: cost entries are flat while real charge varies with `highlights` and empty people pages (free upstream, billed 20,000 µUSD here — an over-estimate, never under); `tool_call_cache` replay returns the pre-dedup `deduped` count; `deduped` only covers URLs Context.dev itself returned this run, not URLs another provider found (that cross-provider rule is prompt-level by design).

## Self-review notes

- Spec coverage: secret ✔ T3 · cost ✔ T3 · env ✔ T3 · implementation/`Retry-After`/no-throw/trim/zod/maxAge ✔ T1–T3 · planner ✔ T3 · prompt ✔ T4 · prefer-free-first in descriptions AND prompt ✔ T3/T4 · result dedup + `deduped:N` ✔ T1/T2 · overlap guard ✔ T4 · one-page cap ✔ T2/T3 · provenance/authority ✔ T3 (class map, denylist) · no key in logs ✔ T1 test · tests for every acceptance bullet ✔ · no changes outside the function + tests ✔ T5.
- Deviations from the brief, each stated: `fetchRetry` not used (cannot honor `Retry-After`, not injectable); env binding in `env.ts` not `index.ts`; "in-run dedup before recording" is implemented as dedup of returned results + the existing write-path `artifactDedupKey`, because these tool classes do not record artifacts themselves.
- Not in scope, not touched: `REVEAL_BREACH_DATA`, `RUN_LEASE_*`, `MAX_ORCHESTRATOR_STEPS`, `confidence.ts`, `record_finding`, `lib/tool-cache-version.ts` (new tools have no stale rows).
