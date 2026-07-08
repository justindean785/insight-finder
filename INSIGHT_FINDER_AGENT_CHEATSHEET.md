# Insight Finder — Agent Operating Cheatsheet

**Audience:** Any AI agent (Claude Code, Codex, Lovable, or an auditor instance) working on Insight Finder.
**Read this first.** It encodes lessons paid for in wasted sessions. Last verified: 2026-07-05.

---

## 0. The One Rule That Causes the Most Pain

**Merging code ≠ deploying code. Deploying ≠ verified live.** Nearly every "it's slow again / the fix didn't work" incident traces to prod running stale code while everyone assumed the merge shipped it. Do not declare anything done until the live build marker confirms it.

---

## 1. Deploy Pipeline (memorize this exact chain)

```
insight-finder main  ──(sync PR)──►  Lovable mirror repo  ──(explicit deploy)──►  live Supabase edge fn
(justindean785/         seeker-spark-search-5362c57c        osint-agent @ skzqwbyvmwqarfgfvyky
 insight-finder)                                            .supabase.co
```

Three separate steps. Each one can silently stop here:

1. **Merge to `insight-finder` main** — records canonical code. Does **not** deploy.
2. **Sync PR merged to the Lovable mirror** — updates the mirror. **Does NOT auto-deploy.** This is the trap.
3. **Explicit Lovable `deploy_edge_functions` call** — the only thing that actually swaps prod.

**Observed failure (2026-07-05):** Telling Lovable "redeploy, pull latest" produced only a *commit* — the `deploy_edge_functions` tool never fired. Prod sat on stale `e50142a` for hours across two "Deployed" confirmations. It moved only when an agent explicitly forced the deploy call. **A "Deployed" self-report from any agent is not proof.**

### Deploy channel rules
- **Lovable owns deploys.** `supabase functions deploy` **403s** on this project — do not use it.
- To deploy: instruct Lovable to run the actual edge-function deploy for `osint-agent`, and have it report the deploy result verbatim + which git ref/SHA it pulled.
- Then **verify independently** (next section). Always.

---

## 2. Live-Verification Protocol (do this before trusting anything)

```bash
curl -sS "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

Returns e.g.:
```json
{"ok":true,"service":"osint-agent","version":"1.2.2","build":"bfe3d3e",
 "build_committed_at":"2026-07-05T10:17:33-07:00",
 "checks":{"tools":{"ok":true,"detail":"16/18 optional tool APIs configured"}},
 "intelbase_enabled":false}
```

- **`build`** — the deployed git SHA. This is the source of truth for "did the deploy land." If it hasn't changed, nothing shipped, no matter what any agent said.
- **`build_committed_at`** — commit time of the deployed build. If it predates your deploy attempt, the deploy did nothing.
- **`checks.tools.detail`** — count of optional tool APIs the *deployed code* knows about + keyed. A newly-added provider not showing up here means its code isn't live yet (a set API key alone does nothing without deployed code that reads it).

**Verification rule:** never write deploy state into memory, a report, or a "done" claim from an agent's self-report. Curl the marker yourself. This applies to auditor instances especially.

---

## 3. Agent Lane Discipline (prevents collisions)

| Lane | Owner | Scope |
|------|-------|-------|
| Backend, edge fn, integrity code, PR merges, mirror sync, deploys | **Claude Code** | `supabase/functions/osint-agent/**` |
| Frontend-only, dedicated branch, **PR-without-merge** | **Codex** | `src/**` |
| Independent audit — reads source/logs, verifies live, never merges | **Auditor (this instance)** | read-only |

- **Collision detection before any file edit.** Two agents editing the same file lane = silent overwrites.
- **Branch off `main`**, not off a feature branch. Confirm with `git branch --show-current` before committing.
- **`feat/prompt-bloat-summarization` is DO-NOT-MERGE** (as of 2026-07-05): ~183 lines ahead of `origin/main` post-#239 that were never explained. Do not branch off it, do not merge it, until that diff is accounted for.
- Frontend fixes that touch integrity display (provenance labels, confidence) are a gray zone — coordinate before crossing lanes.

---

## 4. Key Infrastructure Reference

| Thing | Value |
|-------|-------|
| GitHub repo | `justindean785/insight-finder` (public) |
| Lovable mirror repo | `seeker-spark-search-5362c57c` |
| Lovable project ID | `4ce11bc3-039d-4439-b293-acacca9e1e3a` |
| Supabase host | `skzqwbyvmwqarfgfvyky.supabase.co` |
| Edge function | `osint-agent` |
| Health endpoint | `/functions/v1/osint-agent?health=1` |
| Live prod alias | `insight-finder-sandy.vercel.app` |
| DEAD alias (404s) | `insight-finder-swart.vercel.app` — do not use |
| Vercel project | `prj_WCNXWbrxaXiOS5w6ZWKhkQXTVIWF` |
| Orchestrator | MiniMax-M2.7 (primary), Gemini/Lovable gateway (fallback) |

- **Lovable mirror reflects merged `main` only** — unmerged PRs aren't present. For open-PR state, use the Vercel deployment list, not the mirror.
- Edge fn source lives under `supabase/functions/osint-agent/`; frontend under `src/`.

---

## 5. Common Failure Patterns (and what "slow again" usually means)

1. **Deploy didn't land (P0 default suspect).** Prod on old code. Check the health marker *first*, every time. This is the most common root cause of "slow again."
2. **Context bloat = dominant latency driver.** Unbounded orchestrator context (prompts have hit 250K–538K chars, re-sent every step) → 6–7 min runs. Selector-preserving summarization + per-run tool-call caps mitigate it. Target: **avg <30 tool calls/run, p95 tool-time <120s**. Runs hitting 100+ calls (e.g. `minimax_web_search` ×29) are a red flag.
3. **`jina_reader_scrape` timeout tax.** ~88% failure on hard-block domains (X/Twitter, Twitch, Instagram, Reddit return 451/403). Each timeout burned up to the fetch window before the breaker tripped. Fixes: forward the abort signal from the tool `execute` through `fetchRetry` (Jina historically ignored `opts.abortSignal`), fail-fast the breaker on first timeout, and per-provider skip-list for always-blocked hosts (keep it Jina-specific — those domains are still valid for `socialfetch_lookup` / `reddit_user`).
4. **`dork_harvest` noise.** Auto-records unread URLs (FEC/court PDFs) as artifacts — inflates artifact count, tool calls, and context for zero corroboration value.
5. **Idle timeout too tight.** MiniMax reasoning pauses need `idleMs` ≥ 60–90s inter-chunk, or thinking gets false-aborted (worse than a hang).

---

## 6. Evidence / Confidence Discipline (product invariants — never regress)

- **Correlation, not confirmation.** One tool hit is a lead, never proof.
- **Data-broker / breach / AI-summary results are lead-tier** (~60 cap). Never auto-CONFIRMED on a single class.
- **A non-hit must never look like a hit.** (See known bug #1 below — `{found:0}` misread as a record.)
- **Inferred ≠ verified.** Any inferred value (esp. location targets) must carry provenance and be visually distinct from verified data.
- Do not touch confidence caps, chain-of-custody hashing, or minor-safety gating (`auto_pivot_blocked`, `minor_warning`, adult×minor collision) without explicit sign-off. These work; leave them.

---

## 7. Known Open Issues Currently Live in Prod (`bfe3d3e`)

These three Codex P2s merged into `bfe3d3e` **unresolved** and are now running in prod. Fix before they cause bad output:

1. **Indicia metadata-only → false hit** *(integrity)* — `extractIndiciaRecords` substantive-check ends with `typeof v === "number" || "boolean"`, so `{found:0}` / `{count:0}` / `{found:false}` return a one-record `ok:true`. A valid negative logged as a hit. (Its own comment claims to guard this and doesn't.)
2. **No Indicia provider-family suppression** *(integrity/latency)* — `circuit.ts` `PROVIDER_TOOLS` has no `indicia` entry, so a 402/429 on one endpoint doesn't suppress the other five. **And** the `http_402` branch in `recordResult` never calls `suppressProvider` (only 429/403/timeout/5xx do) — so "map the family" alone won't fix 402; the `http_402` branch must also suppress. Two edits, not one.
3. **Catalog/gate drift** — `list_tools` advertises `indicia_*` unconditionally while the readiness gate strips them when `INDICIA_API_KEY` is absent → keyless deploys plan calls they can't make.

Also pending: seed-provenance fix (`src/lib/intel.ts`) — `US_STATE_TOKENS` maps bare two-letter tokens (`co→CO`, `in`, `or`, `me`…) and `extractStateFromText` returns the first hit, so a free-form seed containing "co" (e.g. `supabase.co`) invents a phantom Colorado target. Frontend lane. Confirm where `seedState` originates before scoping.

---

## 8. "Done" Checklist (don't declare done until all pass)

- [ ] Code merged to `insight-finder` main.
- [ ] Synced to Lovable mirror via PR (true merge — **never** `rsync --delete`).
- [ ] Lovable `deploy_edge_functions` **actually ran** (not just a commit).
- [ ] `?health=1` `build` marker moved to the new SHA — **verified by curl, not self-report.**
- [ ] For a bug fix: re-ran the exact repro and confirmed it's gone in prod.
- [ ] No lane collision (checked file ownership before editing).
- [ ] Branched off `main`, not a stale/DO-NOT-MERGE branch.

---
*Maintainer note: update the "last verified" date and the live `build` SHA in §2 whenever the deploy state is re-confirmed. Treat every claim here as re-verifiable against live infra, per JD's standing rule: live sources over any agent's memory or self-report.*
