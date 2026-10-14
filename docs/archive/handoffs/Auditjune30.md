▶ HOW TO RUN THIS (read first)

Recommended surface: Claude Code on the web (**claude.ai/code**), pointed at justindean785/insight-finder. It works against the GitHub repo and opens a PR you review + merge — and merging to main is exactly what triggers your Lovable edge deploy + Vercel. No local machine needed; drive it from your phone.

Kickoff message to paste into the session (commit this file to the repo root first):
Read INSIGHT_FINDER_MASTER_UPGRADE_2026-06-30.md and execute the master prompt in §7, following its Hard Process Rules exactly. Mirror the exact test/lint/build commands from .github/workflows/ci.yml, and install deno for the edge test suite. Do NOT report done until every §7 gate passes and you've pasted the actual command output. Open a PR against main when green — do not merge.

Two setup facts that decide success:
	1.	Toolchain: a cloud session starts blank — it must install deno (edge tests) + node deps (frontend) before it can satisfy the "paste passing tests" gate. Mirroring ci.yml handles this.
	2.	Approvals: tool calls need confirmation, so a long run isn't hands-off unless you pre-allow the test/lint/build commands (or accept prompts as they come).

Deploy reminder: neither Claude Code surface deploys the edge function. The change goes live only when the PR is merged to main and the Lovable mirror syncs (NOT supabase functions deploy, NOT a Vercel preview). Merge → verify ?health=1 version.

Alternative (only if your dev machine is on): local CLI + Remote Control for exact-CI fidelity / local MCP. Run claude in the repo, /remote-control, scan the QR with the Claude mobile app, steer from your phone. Machine must stay awake — closing the terminal ends the session.

————————

Insight Finder — Master Upgrade Brief (telemetry-grounded)
Date: 2026-06-30 · Basis: live tool_usage_log (83 runs, ~5,900 tool calls, 2026-05-28 → 07-01) + orchestrator source + model-latency research
Scope: speed (priority), tool/API scoring audit, model audit, and one master checklist-driven Claude Code prompt (§7)

————————

1. Executive verdict

Three findings, in priority order:

	1.	Speed is a structural problem, not a tuning problem. Runs average 71.5 tool calls each (p95 174) and 275s of tool execution time (p50 3.6 min, p95 15 min, max 17.6 min) — before counting ~50 sequential MiniMax LLM steps on top. The agent fans out too wide, calls slow/low-yield tools freely, and runs them through a slow orchestrator model.
	2.	The scoring engine is blind to the two things that matter most for speed and accuracy: latency and historical reliability. scoreExpectedValue penalizes price tier, duplicates, and in-run consecutive failures — but has no latency term and no persistent success-rate prior. So a 29-second, 19%-success tool scores the same as a 200 ms, 100%-success one if both are "free." This is why junk keeps getting scheduled and why you keep hand-maintaining blocklists.
	3.	Cost is a non-issue; don't optimize for it. Total charged spend is ≈ cents per run (~$0.08/run). Optimize purely for speed + accuracy.

The single highest-leverage change is to make the scoring engine latency- and reliability-aware, fed by tool_usage_log — it fixes speed and accuracy at once and retires the manual blocklist treadmill. Details in §3–§4; speed plays in §5; model in §6; the build brief in §7.

————————

2. Speed diagnosis (the #1 priority)

Real numbers, this dataset:

Metric
Value
Runs analyzed
83
Tool calls per run (avg / p95)
71.5 / 174
Tool-execution time per run (p50 / p95 / max)
217s / 904s / 1,059s
Cache-hit rate (most tools)
0–10% (near-zero)
Orchestrator model
MiniMax-M2.7 @ ~48 tok/s (below the ~96 t/s median; a HighSpeed ~100 t/s variant exists)

Where the time goes (volume × latency):
	•	minimax_web_search — 1,027 calls, avg 3.8s, p95 8.1s. The #1 tool by volume; necessary but heavy.
	•	jina_reader_scrape — 795 calls, avg 6.2s, p95 24.9s. The single biggest aggregate time sink after web search.
	•	socialfetch_lookup — 441 calls, avg 3.6s, p95 10.3s.
	•	username_sweep — 179 calls, avg 5.2s.
	•	Latency bombs (low volume, catastrophic tails): bosint_phone_lookup avg 29s / max 105s; archive_url avg 16s / max 151s; wayback_cdx_search avg 22s / max 65s; wayback_snapshots avg 16s / max 60s; crtsh_subdomains max 121s; oathnet_lookup max 68s.
	•	The "smart" reasoning sub-calls are slow AND weak: minimax_correlate 60.6% ok @ 14s; minimax_plan_pivots 24.2% ok @ 6.9s; minimax_extract 100% ok but 13.4s. These run the expensive MiniMax smart tier and mostly stall or fail.

Plain reading: each run does ~70 tool calls, a big fraction of them 5–30s, some 60–150s, orchestrated by a model generating at half the going token rate across dozens of round-trips. That's the "so slow."

————————

3. Tool / API audit vs the scoring system (all live tools)

Verdict key: KEEP (healthy) · FIX (keep but harden latency/timeout or reliability) · REPLACE (bad value, swap provider) · REMOVE (dead weight / already blocked / key-gated 0%).

3.1 Workhorses & healthy (KEEP)
Tool
Calls
OK%
avg ms
p95 ms
Verdict
minimax_web_search
1027
96.8
3845
8105
KEEP — but cache + see §5/§6
record_artifacts
257
98.8
750
1767
KEEP (internal)
memory_recall / memory_save
192 / 191
87.5 / 87.4
277 / 165
604 / 282
KEEP
breach_check
172
92.4
2237
4008
KEEP
google_dorks
133
94.7
187
659
KEEP
exa_search
104
90.4
5091
12106
KEEP (watch p95)
dork_harvest
100
96.0
3036
17628
KEEP
dns_records
47
100
240
788
KEEP
ip_intel
63
98.4
431
1527
KEEP
detect_contradictions
64
98.4
236
518
KEEP
virustotal_lookup
24
100
558
1430
KEEP
triage_seed
67
100
1504
3653
KEEP
rapidapi_breach_search
6
100
961
1569
KEEP (new mandatory-first)
gleif_lei_search / opencorporates_search / census_geocode / nominatim_geocode / hackertarget
low
100
fast
—
KEEP

3.2 Keep but HARDEN (FIX — timeout caps + reliability)
Tool
Calls
OK%
avg ms
p95 ms
max ms
Why
jina_reader_scrape
795
89.1
6234
24857
46715
Biggest aggregate time sink. Cap timeout ~8–10s; consider a faster reader (see §4).
socialfetch_lookup
441
80.0
3592
10322
30530
20% failure at volume; cap + verify provider health.
username_sweep
179
93.9
5160
7488
9670
Fine, but parallelize the sub-checks.
oathnet_lookup
172
72.7
1540
3818
68339
max 68s tail → hard cap ~10s.
wayback_snapshots
60
76.7
15766
41609
60523
Cap ~12s; only on explicit freshness need.
gemini_deep_dork
59
86.4
16106
46311
47046
Works but slow; cap + run async.
serus_darkweb_scan
43
81.4
11813
29135
31965
Cap ~12s.
crtsh_subdomains
28
71.4
8972
33414
121300
max 121s → hard cap.
minimax_correlate
33
60.6
14079
38322
45064
Smart tier, slow + unreliable → see §6 (different model for smart tier).
minimax_plan_pivots
33
24.2
6909
34829
42911
76% failure on the expensive planner. Fix the prompt/parse or gate it off until fixed.

3.3 Bad value — REPLACE
Tool
Calls
OK%
avg ms
max ms
Action
bosint_phone_lookup
53
18.9
29047
105615
Worst tool in the system: 19% success, 29s avg, 105s worst. Replace the phone path (e.g. a fast phone-intel API) or make it manual-override only with a 10s cap.
archive_url
29
31.0
16346
151021
151s worst case, 31% success. Replace with a bounded wayback-availability check; never block a run on archiving.
wayback_cdx_search
14
57.1
21965
65194
Slow + coin-flip. Cap hard or fold into one wayback tool.
deepfind_reverse_email
85
65.9
10426
—
10s avg, 1/3 fail. Evaluate vs breach_check/rapidapi coverage; likely redundant.
github_user
64
51.6
379
—
Fast but coin-flip; fix auth/rate handling or replace with github_code_search coverage.
crtsh_lookup
9
33.3
7531
—
Redundant with crtsh_subdomains; consolidate.

3.4 Dead weight — REMOVE (most already blocked; confirm they're fully out of the planner + catalog)
Tool
Calls
OK%
Status
intelbase_email_lookup
35
2.9
culled — verify gone
deepfind_ransomware_exposure
25
8.0
culled — verify gone
synapsint_lookup
104
10.6
blocked #39
deepfind_profile_analyzer
41
12.2
culled
hibp_lookup
16
0.0
key-gated dead — remove or fix key
ipqualityscore_lookup
24
0.0
key-gated dead — remove or fix key
hackernews_user
15
0.0
blocked
gravatar_profile
38
21.1
blocked
emailrep
44
22.7
blocked
stolentax_footprint
98
21.4
blocked (also 10s avg)
osint_navigator_query / username_search
2 / 1
0.0
remove

3.5 The scoring gap (root cause of §3.3/§3.4 recurring)
scoreExpectedValue (cache.ts) inputs: selectorConfidence, sourceIndependenceBonus, corroborationPotential, freshnessNeed, freshSeedBonus, costPenalty(price tier), duplicatePenalty, priorFailurePenalty(in-run consecutive only), collisionPenalty, weakLeadPenalty, repeatedToolPenalty.

Missing entirely:
	•	Latency term — nothing penalizes a tool for being slow. archive_url (151s) and dns_records (240ms) are treated identically on time. This is the direct cause of the 15-minute p95.
	•	Persistent reliability prior — priorFailurePenalty only counts consecutive failures within the current run. A tool that is 20% successful historically still starts every run at full EV. That's why you keep hand-maintaining PERMANENT_BLOCK.

Fix (single highest-leverage change): feed the scorer two persistent, telemetry-derived signals per tool:
	1.	latencyPenalty ∝ the tool's p95 duration_ms (bucketed: <1s none, 1–5s small, 5–15s medium, >15s large).
	2.	reliabilityPrior ∝ the tool's rolling ok_pct from tool_usage_log (e.g. a materialized tool_health view refreshed hourly). A <40% tool is EV-suppressed unless manual_override.

This makes the agent self-prune slow and low-yield tools by data, improving speed and accuracy simultaneously, and lets you delete most of the hardcoded blocklist. It also means new/underperforming providers demote themselves without a code change.

————————

4. API weak areas — what to add / replace / remove

Weak/absent capabilities (accuracy + data gaps):
	•	Scraping/reader is slow and single-track (jina_reader_scrape, 6.2s avg / 25s p95, 89%). Add a faster primary reader and keep jina as fallback. Candidates: a fast HTML-first fetch → readability, with a headless/render fallback only when needed (most OSINT pages don't need JS render). This alone removes a large chunk of run time.
	•	Phone intelligence is broken (bosint_phone_lookup 19% / 29s). This is a real capability gap for phone seeds — replace with a reliable phone-intel provider or drop phone as a first-class seed until fixed.
	•	Breach coverage is fragmented and uneven: rapidapi_breach_search (100%, new mandatory-first) and breach_check (92%) are strong; leakcheck_lookup (70.6%), oathnet_lookup (72.7%, 68s tail), deepfind_reverse_email (66%), serus_darkweb_scan (81%, 12s) overlap and underperform. Consolidate to the 2 strong ones + 1 dark-web scan, demote the rest to corroboration-only (partly done in #170/#171).
	•	The two "reasoning" sub-tools underperform (minimax_plan_pivots 24%, minimax_correlate 61%). These are the analytic core — see §6; likely a model problem, not a prompt problem alone.

Remove/retire: everything in §3.4 (dead or key-gated 0%). Removing them shrinks the tool schema the model sees each step (faster planning, fewer wrong turns) — a secondary speed win.

Add (data/accuracy upside): a fast reader (above); a reliable phone provider; and — highest value — the tool_health view in §3.5 so the platform tunes itself from telemetry.

————————

5. Speed plan — 4 plays, ranked by impact

Play 1 — Cut tool-call volume (biggest win). Target ~25–30 calls/run, down from 71.5.
	•	Add the latency + reliability terms to scoreExpectedValue (§3.5) so slow/weak tools stop firing.
	•	Lower stopWhen: stepCountIs(50) → ~30 with an added wall-clock deadline (e.g. stop after N seconds elapsed).
	•	Fix or gate minimax_plan_pivots (24% ok) — a broken planner drives wasted fan-out.
	•	Expected: roughly halves both tool time and LLM steps.

Play 2 — Kill the latency tails. Add a per-tool hard timeout (default ~8–12s) enforced in the wrapper, and demote/replace §3.3 tools. The 15-min p95 is dominated by bosint_phone (105s), archive_url (151s), wayback (60–65s), crtsh (121s), oathnet (68s). Expected: collapses the p95/max tail from minutes to seconds.

Play 3 — Faster orchestrator model. MiniMax-M2.7 standard is ~48 tok/s; across ~50 steps that's minutes of pure generation. Two options (see §6): drop-in MiniMax-M2.7 HighSpeed (~100 t/s, identical output) for ~2× on the LLM half, or A/B a Flash-class / LPU model (Gemini 3.5 Flash ~200 t/s; Cerebras-hosted Llama sub-second/call) purpose-built for many-step agent loops. Expected: 2–4× faster LLM half; with many sequential steps this compounds.

Play 4 — Bounded parallelism + real caching. Execute independent lookups concurrently (bounded, e.g. 3–4 at a time) instead of one-per-step — requires the MissingToolResults fix first so parallel calls pair results correctly. And fix cache hit-rate (currently ~0–10%; investigation_cache was empty due to the RLS/service-role bug, now fixed in code) so repeat seeds return instantly. Expected: wall-time cut on wide steps + near-instant repeat runs.

————————

6. Model audit — MiniMax-M2.7 vs alternatives (researched)

Current: MiniMax-M2.7 (released 2026-03-18; 230B MoE / 10B active; 205K ctx; $0.25/$1.00 per M; strong agentic index). Used for BOTH the orchestrator loop and the smart sub-tools.

The problem is speed and smart-tier reliability, not raw intelligence:
	•	Per Artificial Analysis / Design for Online, M2.7 standard runs ~48 tok/s — about half the ~96 t/s median for its class. A HighSpeed variant (~100 t/s) exists with identical output.
	•	Your telemetry shows the MiniMax smart sub-calls underperform (plan_pivots 24% ok, correlate 61%) — a signal the smart tier specifically may benefit from a different model.

Alternatives worth A/B testing (current, 2026 data):

Model
Speed
Agentic fit
Cost /M (in/out)
Notes
MiniMax-M2.7 HighSpeed
~100 t/s
same as today
$0.25 / $1.00
Lowest-risk: drop-in, identical quality, ~2× faster. Do this first.
Gemini 3.5 Flash
~4× faster output than same-tier frontier; Flash-class TTFT
Purpose-built for agentic/tool loops (leads Terminal-Bench 2.1, MCP Atlas)
~$1.50 / $9
Best "frontier quality at Flash speed" for many-step agents. Your fallback path already speaks Gemini.
Gemini 2.5 Flash
~200 t/s, sub-600ms TTFT
Strong tool-calling; the common default for agent loops
~$0.30 in
Cheaper/faster; verbose (1.8× output) so cap max tokens. GA + already wired as fallback family.
Cerebras-hosted Llama 70B
~2,000 t/s, sub-second/call
"Especially interesting for agentic workflows with many sequential calls"
free/low tier
For a 50-step loop this is the biggest wall-clock lever; OpenAI-compatible, easy to slot behind your provider selector.
Claude Haiku 4.5
~597ms TTFT, concise (fewer output tokens)
Strong tool-calling reliability
mid
Conciseness = fewer tokens = faster+cheaper per step; good for the smart/synthesis tier.
DeepSeek V4 Flash
fast, huge cache discount
decent
$0.14 / $0.28, 1M ctx
Cheapest; not the fastest; good if cost ever matters.

Recommendation:
	1.	Now: switch the orchestrator to MiniMax-M2.7 HighSpeed (zero-risk 2× on the LLM half).
	2.	A/B (infra already supports alt providers — Grok/OpenAdapter selectors exist): put Gemini 3.5 Flash or Cerebras-Llama behind an env flag as the orchestrator and measure wall-clock + accuracy against the same seeds. TTFT × ~50 steps is where the wall-clock hides; a sub-second-per-call model can cut minutes.
	3.	Consider splitting tiers: keep a strong model for the smart/synthesis step (Haiku 4.5 or Gemini 3.5 Flash), a fast one for routine steps. Your models.ts tiering already supports this — the smart tier is where plan_pivots/correlate live and where quality matters most.

Do NOT swap models blindly — A/B on real seeds, because MiniMax's tool-call ID format and JSON-args behavior differ from Gemini/OpenAI-compatible providers, and the §7 crash fix (parallel-tool-call handling) must be verified per provider.

————————

7. MASTER CLAUDE CODE PROMPT (copy-paste)

Paste from repo root. This is a checklist-driven, gated brief. The agent must build the checklist first, work items strictly one at a time, and is forbidden from reporting completion until every box is checked and every test passes with pasted output.


# ROLE
You are a senior engineer hardening a production OSINT agent (Supabase edge fn
`osint-agent`, Vercel AI SDK `ai@6`, MiniMax-M2.7 orchestrator). Work carefully,
verify everything, and DO NOT claim done until every gate below passes.

# HARD PROCESS RULES (follow exactly)
1. FIRST, restate the work as an explicit numbered CHECKLIST (every task + every
   acceptance check) and print it. Nothing else until the checklist exists.
2. Work the checklist ONE ITEM AT A TIME, top to bottom. After each item: run the
   relevant tests, paste the actual output, and only then tick the box.
3. You may NOT say "done", "complete", "ready", or similar until:
   - every checklist box is ticked,
   - the FULL edge test suite AND frontend suite pass (paste counts),
   - typecheck + lint + build are green (paste output),
   - you have added the NEW tests required below and they pass.
   If any test fails, keep working; do not report success.
4. If a task is blocked or ambiguous, STOP and list the blocker — do not guess on
   integrity-sensitive code.
5. Touch NO evidence-integrity logic (confidence engine/caps, chain-of-custody,
   minor-safety/DOB, credential masking, source attribution/independence). These
   are sign-off-gated. Everything here is resilience/perf only.

# OBJECTIVE
Ship three things, gated and verified: (A) stop the MissingToolResults crash,
(B) make the agent materially faster, (C) make the tool-scheduler self-prune slow
and unreliable tools from telemetry. Beta-ready = all gates green.

# CONTEXT (verify against the repo; paths may differ — search, don't assume)
- Orchestrator loop + streamText config: supabase/functions/osint-agent/index.ts
- Tool wrapper + EV scorer glue: supabase/functions/osint-agent/cache.ts
- EV scorer: supabase/functions/osint-agent/runtime-policy.ts (scoreExpectedValue)
- Cost tiers: supabase/functions/osint-agent/costs.ts
- Model/provider: models.ts, providers.ts, env.ts, _shared/ai-gateway.ts
- Sanitizer (reuse, don't duplicate): message-sanitize.ts
- Tool catalog / registry: catalog.ts, tool-registry.ts, playbooks.ts
- Telemetry table: tool_usage_log (columns incl. tool_name, ok, outcome,
  duration_ms, cached, charged_micro_usd).

# PHASE 1 — P0: stop the MissingToolResults crash (blocker)
Symptom: "Tool results are missing for tool calls <id>_N" kills runs. Cause:
MiniMax emits parallel tool calls; trailing ones get truncated mid-stream (no
result) and/or a tool throws into the live step; the sanitizer only runs between
steps so it can't repair the live step.
Requirements:
1. In index.ts streamText: set an explicit `maxOutputTokens` (justify the value in
   a comment) AND constrain parallel tool calls on the MiniMax orchestrator.
   Verify the correct lever for ai@6 + @ai-sdk/openai-compatible@1 BEFORE coding
   (provider option / body field `parallel_tool_calls:false`, or toolChoice/active-
   tool shaping). Default the orchestrator to SERIAL tool calls (one/step); make it
   one named constant.
2. In cache.ts wrapToolsWithCache: in BOTH `execute` catch blocks, REPLACE `throw e`
   with a RETURN of a schema-safe error result
   `{ ok:false, error:<redacted>, _tool_error:true, ...runtime meta }`. Preserve
   tool_usage_log write, circuit.recordResult, finishCall, billing, redactSecrets.
3. Graceful escape in index.ts: if MissingToolResults/InvalidPrompt still escapes,
   END THE RUN CLEANLY (persist partial assistant/artifacts, thread->finished), no
   red failure card. Do not mask genuine provider/context errors.
4. Fix onError classifier regex to also match the plural stock message
   "Tool results are missing for tool calls" (keep the singular form).

# PHASE 2 — Speed: scheduler is latency- and reliability-aware
Data (tool_usage_log, 83 runs): avg 71.5 tool calls/run, avg 275s tool time/run,
p95 15 min. scoreExpectedValue has NO latency term and NO persistent success prior.
Requirements:
1. Add a persistent tool-health signal: a `tool_health` SQL view/materialized view
   over tool_usage_log exposing per-tool rolling p95 duration_ms and ok_pct (last
   ~30d), refreshed periodically. (SELECT-only migration; no data mutation.)
2. Extend scoreExpectedValue with:
   - `latencyPenalty` from the tool's p95 duration (buckets: <1s 0, 1-5s small,
     5-15s medium, >15s large),
   - `reliabilityPrior` from rolling ok_pct (a <40% tool is strongly EV-suppressed
     unless manual_override).
   Keep it a pure function; unit-test the new terms.
3. Enforce a per-tool hard TIMEOUT in the wrapper (default ~8-12s; per-tool
   overrides allowed), returning a schema-safe timeout error result (never throw).
4. Lower stopWhen stepCountIs(50) -> a named constant (~30) AND add a run wall-clock
   deadline that ends the run cleanly when exceeded.
Do NOT delete tools yet — the reliability prior should demote them by data. (You
MAY remove tools already in PERMANENT_BLOCK if they're pure dead weight; list them.)

# PHASE 3 — Model speed (safe, env-gated, no default behavior change)
1. Switch the primary orchestrator model id to the MiniMax-M2.7 HighSpeed variant
   if MiniMax exposes it (verify the exact model string against MiniMax docs);
   identical output, higher t/s. If unsure, leave a clearly-marked TODO + env flag
   instead of guessing the string.
2. Ensure an alternate orchestrator provider (Gemini 3.5 Flash OR Cerebras-hosted,
   OpenAI-compatible) can be selected purely via env (the provider selector already
   supports alternates). Default provider UNCHANGED. Add nothing that fires without
   an env flag.

# OSINT / ANALYST GUARANTEES
- A degraded/timed-out/failed tool still logs a truthful outcome (skipped/failed).
- Partial investigations persist real artifacts and render.
- No change to confidence/custody/safety/redaction/attribution.

# DO NOT
- Do not touch integrity modules (above). Do not weaken sanitizeModelMessages.
- Do not remove the credit gate, cost checkpointing, or circuit breaker.
- Do not bind the stream to req.signal. Do not add new external deps without noting them.
- Do not swap the default model blind — env-gate any alternate.

# NEW TESTS REQUIRED (must pass, paste output)
- A throwing tool returns a paired error result and does NOT orphan sibling calls
  (simulated parallel batch with one throwing member -> all calls have results).
- scoreExpectedValue: a high-latency, low-reliability tool scores below a fast,
  reliable one at equal price tier.
- Wrapper timeout returns a schema-safe error result, not a throw.
- onError regex matches the plural MissingToolResults message.

# VERIFICATION GATES (all must be green; paste every output)
- deno check on the edge function entry + changed files
- full edge deno test suite (report N/N)
- frontend: lint (0 errors), typecheck, tests (N/N), build
- a manual note: which parallel-tool-call lever you used and why it is correct for
  ai@6 + @ai-sdk/openai-compatible@1 (quote the API you verified)

# RETURN (only after all gates green)
- The printed checklist with every box ticked
- Changed files, one-line rationale each
- Test counts before/after (edge + frontend) + coverage delta
- The exact model string / provider flags added
- Remaining risks + the ONE deploy step: this edge change goes live via the
  Lovable mirror of `main` (NOT `supabase functions deploy`, NOT a Vercel preview),
  so it must be merged to `main` to deploy. State that explicitly.


————————

8. Sequencing for tonight
	1.	Run §7 Phase 1 first (crash) → verify green → merge to main (edge deploys via Lovable mirror; a Vercel preview does NOT deploy the edge fn).
	2.	Phase 2 (scheduler speed) is the biggest UX win — do it in the same pass if time allows; it's independently testable.
	3.	Phase 3 (model) is env-gated and safe to land dark, then A/B on real seeds.
	4.	Re-pull the run-level query after a day of traffic; target avg <30 tool calls/run and p95 tool-time <120s.
