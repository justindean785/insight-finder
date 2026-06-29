# Insight Finder — QoL / Standout Roadmap (scoping)

> Scoped 2026-06-29 from two grounded evidence sources: (1) production telemetry over ~106 real
> investigations (`tool_usage_log`, `threads`, `artifacts`), and (2) a 5-dimension code audit
> (graph, UI/design, Brain+Insights, report/dossier, cross-scan architecture). Every finding below is
> tied to real files/tables. This is a planning doc — no code changed by it.

---

## 0. The one insight that should drive everything

**Your strongest differentiators are already built — they just aren't plugged in.** Three of the five
auditors independently found analyst-grade machinery sitting dormant:

| Capability | Built & tested at | Status today |
|---|---|---|
| Real link-analysis graph (shared-selector edges w/ reasons, clusters, bridges, infra-vs-identity typing) | `src/lib/entity-graph.ts` (`buildEntityGraph`, 430 lines) | **Only referenced in tests.** Live `GraphTab.tsx` draws fake "everything-to-seed" SVG edges. |
| Rigorous report (source-independence collapsing, confidence linter w/ hard "Verified" gate, competing hypotheses, SHA-256 custody serializer) | `src/components/investigation/ReportCardV2.tsx` + `src/lib/audit/*` + `report-serializer.ts` | **Ships only to a DEV `/report-preview` with fake data.** Users get the simpler `CaseReport`. |
| "Agent learns from your feedback" loop | `artifact_reviews` table (written by review UI) | **Read nowhere in `supabase/functions/`** — the Brain UI claims it works. Overclaim. |
| Cross-case entity resolution (normalization + canonical selectors) | `useThreadArtifacts.normalizeValue`, `entity-graph.selectorsFor`, GIN-indexed `agent_memory.related_values` | Computed per-thread then **thrown away on unmount**; no cross-case UI. |

**Implication:** ~60% of the "make it analyst-grade and stand out" work is *connect-and-promote*, which
is cheap, fast, and high-trust. Build-from-scratch is mostly confined to the cross-scan features and UI polish.

---

## 1. Evidence base — where it's weak today (from your real runs)

### 1a. Tool reliability — three buckets (from `tool_usage_log`)

**🗑️ Dead weight — remove from the planner allow-list (burning latency/cost/quality for ~0 yield):**

| Tool | Calls | OK% | Why it fails |
|---|---|---|---|
| `synapsint_lookup` | 103 | 10% | self-disabled ("provider disabled in config" / "disabled after 3 failures") yet still picked |
| `stolentax_footprint` | 97 | 22% | 401 bad key + aborts; **10s avg** |
| `bosint_phone_lookup` | 50 | 14% | `bosint_phone_timeout`; **30s avg** — phone coverage is effectively broken |
| `emailrep` | 42 | 19% | 429 rate-limited (already demoted) |
| `deepfind_profile_analyzer` | 40 | 10% | 404 dead stub (culled from baseList #171; still has runtime def) |
| `gravatar_profile` | 35 | 14% | 404 |
| `intelbase_email_lookup` | 35 | 3% | 401 auth |
| `deepfind_ransomware_exposure` | 25 | 8% | 404 dead stub |
| `ipqualityscore_lookup` | 23 | 0% | invalid key (known) |
| `hibp_lookup` | 16 | 0% | broken |
| `hackernews_user` | 15 | 0% | broken |

**🔧 Tool is fine — the *orchestrator* misuses it (fix routing, not the tool):**
- `socialfetch_lookup` (414 calls, 79%): "failures" are self-inflicted — *burst limit 4/4*, *duplicate call*, and
  *"does not support platform='github'/'linkedin'/'twitch'"*. The planner over-calls it and asks for platforms it
  can't do. Fix routing → real success rate jumps.
- `leakcheck_lookup` (192, 69%): 20× *"upstream HTTP 400"* = malformed input formatting.

**✅ Workhorses (keep, protect):** `minimax_web_search` (947, 97%), `jina_reader_scrape` (712, 89%),
`username_sweep` (171, 94%), `breach_check` (162, 92%), `record_artifacts` (232, 99%), `triage_seed` (100%).

**🐢 Slow (latency UX):** `bosint_phone` 30s, `wayback_cdx_search` 18s, `archive_url` 17s, `gemini_deep_dork` 15.7s,
`wayback_snapshots` 15.4s, `minimax_correlate` 13.4s, `serus_darkweb_scan` 12.2s, `deepfind_reverse_email` 10.9s.

### 1b. Coverage by query type (avg artifacts/case)
`email` 37 (strong) · `person` 44 · `domain` 25 · `ip` 22 · **`username` 10.5 (thin — weak username tools)** ·
**`phone` under-served (primary tool broken)**. Plus **seed-type classification is messy** (many `null`/`other`/
`unknown`), which muddies routing.

### 1c. Stability bugs found/fixed this session
- ✅ Fullscreen/breakpoint remount aborted live runs & dropped messages (#173, fixed).
- ✅ Sidebar buried recent scans behind stuck-active clutter (#175, fixed).
- ✅ Real-person PII shipped as demo seed + sample dossier (#174, fixed).
- ⚠️ **Open root cause:** 70 of 106 cases are stuck in `active` status — runs don't finalize to `finished`. Pollutes
  any "is this running?" logic. **Backend fix needed.**

---

## 2. Prioritized roadmap (impact × effort)

### TIER 0 — Stabilize & clean (trust floor; mostly backend; do first)
0.1 **Finalize thread status** on run completion (`finished`/`stopped`), so `active` means active. (Backend, S–M) — fixes the 70 stuck cases.
0.2 **Tool hygiene pass** (Backend, S): cull dead tools from the planner allow-list (synapsint, stolentax, ipqs, hibp, hackernews_user, intelbase, gravatar, emailrep, the 404 stubs); fix `socialfetch` routing (don't call for unsupported platforms; lower burst); fix `leakcheck` input formatting; cap/lower timeouts on the 15–30s tools.
0.3 **Phone coverage** (Backend, M): replace/repair the phone path (bosint times out) — phone is the weakest seed type.
0.4 **Seed-type classification cleanup** (Backend, S): reduce `null`/`other`/`unknown` so routing/playbooks fire correctly.

### TIER 1 — Wire the dormant engines (HIGHEST impact-to-effort; the core of "analyst-grade & standout")
1.1 ⭐ **Graph: wire `buildEntityGraph` + adopt React Flow/Cytoscape.** Replace fake seed-star edges with real
shared-selector edges that carry a hover *reason* ("shares email …" vs "shares IP — infrastructure, not identity"),
clusters, bridges, confidence-weighted widths. (Frontend, S to wire the model + L for the lib.) Files:
`GraphTab.tsx`, `entity-graph.ts` (reuse as-is), `package.json`.
1.2 ⭐ **Report: ship the rigorous pipeline.** Feed real artifacts into `lintReport` + `checkIndependence` +
`ReportCardV2`; surface the CLEAN/ADVISORY/**BLOCKED** verdict and "N declared → M effective sources." (Frontend, L)
1.3 ⭐ **Unify the deliverable + real PDF.** One export = narrative dossier + connections graph + confidence tiers +
SHA-256 custody manifest (today split across Report and Tools/Custody tabs). Route "Download PDF" through the real
`evidence-export` generator instead of `window.print()`. (Frontend+Backend, M–L)
1.4 **Close the learning loop honestly.** Have `osint-agent` read `artifact_reviews` to reweight source confidence —
or, minimum, rewrite the Brain copy that currently overclaims it. (Backend M / copy S)
1.5 **One confidence vocabulary.** Collapse the 4–5 overlapping tier/label systems into one canonical scale + a
printed legend used in board, drawer, dossier, custody, and graph. (S–M)

### TIER 2 — Cross-scan moat (the "you can't get this anywhere else" / "no 20 tabs" differentiators)
2.1 ⭐ **Global Entity Explorer** — search any selector → every case it touches, occurrence count, best confidence,
source chain, first/last seen. Turns one-off cases into a personal intelligence database. Normalization already
exists; needs a materialized **`entities` rollup table** `(user_id, kind, norm_value, thread_ids[], first/last_seen,
occurrence, max_confidence)` for scale. (Backend M + Frontend M) — **highest impact-to-effort net-new feature.**
2.2 **"Seen before?" cross-case badge** on artifacts (Evidence/Graph) → "seen in 3 other cases." Recall query already
exists (`memory_recall`). (Frontend S)
2.3 **Cross-Case Relationship Map** — promote the graph to per-user with `case` nodes and shared-selector bridges
across `thread_id`s ("these 4 investigations are one network"). (Frontend M–L; builds on 1.1 + 2.1)
2.4 **Watchlists & alerts** — save selectors; flag when a new artifact in *any* case matches (rides the existing
Realtime insert stream). The only feature that works while you're *not* looking. (Backend M + Frontend M)
2.5 **Map view** of geo/IP/address artifacts across cases (needs a geocode step → `metadata.lat/lng`). (M)

### TIER 3 — First-impression polish (cheap, high perceived-quality; "looks like a real tool instantly")
3.1 ⭐ **Fix the phantom font.** Load Geist Mono (or standardize on JetBrains Mono) so the forensic-data UI stops
rendering two different monospace faces. (S) — biggest cohesion win for the price.
3.2 **Re-tint premium surfaces** (`.intel-node`, `.evidence-tile`, `.code-panel`) from pure grey to the blue-black hue. (S)
3.3 **Branded loading skeletons** instead of bare "Loading…" first paints. (S–M)
3.4 **Rebuild the Landing feature trio + add a real product visual** (it's the most "vibe-coded" block). (M)
3.5 Fix the leftover **violet user bubble**; extract one shared `<AmbientBackdrop>`; richer **in-flight agent status**
(active tool/stage/elapsed instead of just "Investigating…"). (S–M)

### TIER 4 — Analyst-value layers (durable reasons to return)
4.1 **Insights → real analytics:** confirm/dismiss precision rate, false-positive rate by source, time-to-first-finding,
spend-per-case (uses `artifact_reviews` + `threads` timestamps + `tool_usage_log` cost — all present, unused here). (M)
4.2 **Entity dossier / "Ask the Brain about X"** — synthesized cross-case profile for any selector. (M; pairs with 2.1)
4.3 **Semantic recall** via pgvector on `agent_memory` so recall survives spelling/format variants. (L)
4.4 **De-dupe the two Brain implementations** (`BrainPanel` vs `BrainGlobalPage` have diverged). (M)

---

## 3. If you do only 7 things (my recommended sequence)

1. **Finalize thread status + tool hygiene pass** (0.1, 0.2) — stops the bleeding; instantly faster, cleaner runs.
2. **Wire the real graph** (1.1) — the loudest visible upgrade; "weak/cheap" → analyst-grade with code you already have.
3. **Ship the rigorous report + real PDF + unified export** (1.2, 1.3) — makes the *deliverable* match the promise.
4. **Global Entity Explorer + "seen before" badge** (2.1, 2.2) — the standout moat; "no other tool connects my cases."
5. **Font fix + surface re-tint + loading skeletons** (3.1–3.3) — cheap first-impression credibility.
6. **Make the learning loop honest** (1.4) — remove the overclaim or make it true.
7. **Insights analyst layer + watchlists** (4.1, 2.4) — durable weekly-return value.

---

## 4. What needs a backend (Lovable mirror) deploy vs frontend-only
- **Frontend → merge to `main` (Vercel):** 1.1, 1.2 (UI parts), 1.5, all of Tier 3, Insights UI (4.1), entity-explorer UI.
- **Backend → double-port to the `seeker-spark-search-5362c57c` mirror:** 0.1, 0.2, 0.3, 0.4, 1.4, the `entities` rollup
  table + triggers (2.1), watchlist table/trigger (2.4), real PDF unification (1.3), pgvector (4.3).

## 5. Notes
- Per-tab cross-scan reads are RLS-safe — every table is `user_id`-scoped, so unifying a single user's own cases is
  permitted with no policy changes.
- The `entities` rollup table (2.1) is the one real schema investment; it pays off for 2.1/2.2/2.3/2.4 at once.
- Account deletion (#3 beta P0) and the support-email alias are still pending and tracked separately from this roadmap.
</content>
</invoke>
