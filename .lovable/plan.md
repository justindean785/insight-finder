## Goal
Stop false identity merges and wasted tool spend. Make every artifact deduplicated, conservatively scored, and tied to a defensible cluster. Reshape the final report around evidence strength.

All changes are scoped to `supabase/functions/osint-agent/` plus the two UI surfaces that render artifacts/findings (`CaseReport.tsx`, `OverviewTab.tsx`, `KeyFindings.tsx`). No schema migrations required — everything fits in existing `tool_usage_log`, `artifacts.metadata`, and `agent_memory`.

---

## 1. Tool Budget + Circuit Breakers
New module `supabase/functions/osint-agent/circuit.ts`:

- In-memory per-thread `Map<tool, BreakerState>` with: `consecutiveFailures`, `totalFailures`, `disabledUntil`, `disabledReason`.
- Status-code policy table:
  - `402` → disable for thread (`reason: 'payment_required'`)
  - `403` → disable for thread unless `credentials_refreshed` flag set
  - `400` / `404` → mark `(tool, normalizedSelector)` as non-retryable
  - `429` → exponential backoff (`disabledUntil = now + min(2^n * 5s, 5min)`)
  - `500` → allow 1 retry, then disable for selector
  - `timeout` (AbortError / >30s) → 1 retry, then disable for selector
  - any tool: 3 thread-wide failures → disable
- Specific hard-coded baselines applied at thread start: `bosint_phone_lookup` capped at 1 attempt per selector + 25s timeout (already partially done — enforce here), `stolentax_footprint` disabled on first 403, `synapsint_lookup` disabled after one 500 (current code already does this — move into circuit module).
- `wrapToolsWithCache` (index.ts ~L817) calls `circuit.shouldRun(tool, selector)` before invoking, records outcome into `circuit.recordResult(...)`, and writes the breaker decision into `tool_usage_log.metadata` so the Audit tab can show why a tool was skipped.

## 2. Query Deduplication
Same `circuit.ts` exposes `callKey(toolName, normalizedSelector, purpose)`:

- Normalization helpers per kind (email lowercase, phone digits-only E.164, username strip `@`, URL strip fragment + trailing `/`).
- `purpose` defaults to `"default"` but planner can pass `"verify"`, `"deep"`, `"pivot:<source_artifact_id>"` to legitimately re-run with new intent.
- Backed by `tool_call_cache` (already exists) keyed by SHA-256 of `call_key`. Cache hit → return prior `output_json`, log `cached=true, cost=0`.
- Refuse re-run if prior call produced ≥1 artifact for the same selector unless `force=true` flag from planner. Planner prompt updated to set `force` only when it can name a new evidence trigger.

## 3. Artifact Type Cleanup
Replace the freeform `kind` whitelist in `validateArtifact` (index.ts ~L366) with the strict enum from the brief:

```
person, alias, username, social_profile, email, phone, address, domain,
organization, employer, law_enforcement_unit, court_case,
criminal_case_event, media_report, music_profile, account_id, hash,
crypto_wallet, breach_exposure, contradiction, weak_lead,
excluded_collision
```

- `kind="other"` is rejected — agent must pick a real type or call `record_weak_lead(value, reason)` helper that maps to `kind=weak_lead`.
- Add inference helpers: regex `/LAPD|FBI|sheriff|police dept/i` → `law_enforcement_unit`; `/People v\.|case no\.|docket/i` → `court_case`; Spotify/Apple-Music URLs → `music_profile`; `0x[a-f0-9]{40}` → `crypto_wallet`.
- `metadata.role` accepted on `person` (`victim`, `co_defendant`, `subject`, `associate`).
- Update `src/lib/entityIcons.ts` to add icons for the new kinds (court_case, music_profile, law_enforcement_unit, crypto_wallet, etc.).

## 4. Confidence Scoring Caps
`confidence.ts` gains a `applyEvidenceCaps(rawScore, sources, kind, corroborationSources)`:

- Source-class table maps each tool → class: `breach`, `username_sweep`, `social_profile_passive`, `news`, `court_record`, `official_profile_match`, `independent_public`, `ai_summary`.
- Caps:
  - `breach`-only: 60
  - 2× distinct `breach`-only: 65
  - `username_sweep`-only: 45
  - `social_profile_passive` without content match: 40
  - `news` (event facts only): 80
  - `court_record` (record-facts only): 90
  - `official_profile_match` (name+role+content/image): 75–85
  - 2× independent public sources: 85–90
  - official + independent public: ≥90
- Hard rule: 95+ blocked for any artifact whose only sources are in {`username_sweep`, `breach_check`, `oathnet_lookup`, `leakcheck_lookup`, `socialfetch_lookup`, `ai_summary`, `inferred_alias`, `same_name`}.
- Wrap every artifact insert (record_artifact and record_artifacts paths) so caps apply server-side; agent can't bypass with a raw 95.

## 5. Identity Cluster Rules
New module `clusters.ts`:

- Strong selectors: `verified_email`, `verified_phone_unique`, `court_record`, `official_social_self_id`, `unique_address_corroborated`, `business_employment_record`.
- Weak selectors: name, area code, breach collision, username similarity, shared city, music association, news mention without selector, AI summary, generic handle.
- Merge requires ≥2 distinct **strong** selectors and zero high-severity contradictions.
- `cluster_id` lives in `artifacts.metadata.cluster_id` (UUID per cluster, generated locally).
- New tool: `propose_cluster_merge(cluster_a, cluster_b, strong_selectors[])` — only mutates when threshold met, otherwise records a `candidate_link` artifact for analyst review.
- Pre-seeded "do-not-auto-merge" guard list from the brief (Maurice Shelmon, Ant Jefe, Marcus Shelmon, Kyle Ross, Angie Gonzalez, Johnnie Gray, Carl Welch, Nba1, etc.) — agent must call merge tool, which rejects without the strong-selector pair.

## 6. Collision Handling
When the same normalized phone/email/address would be inserted across artifacts that belong to different `cluster_id`s:

- Insert one `kind=contradiction` artifact with `metadata.collision_value`, `clusters[]`, `severity`.
- Lower confidence on each involved artifact by 20 (floor at 30).
- Emit a `contradictions` row consumed by `CaseReport`'s existing contradiction surface.
- Specifically wire the 3103842124 / marcusjordan3 / antjefe patterns as known examples in tests.

## 7. Minor-Signal Safety
- Detector: any artifact whose source/text contains `minor`, `child`, `under 18`, `cp`, `csam`, `loli`, or schools listed with under-18 attendance trips `MINOR_SIGNAL`.
- On trip: short-circuit pivots, do not store text content, store only `{ kind: 'weak_lead', value: 'minor_signal_detected', metadata: { status: 'manual_review_required', high_level_warning: true } }`.
- Planner prompt updated to refuse expansion when this flag is set on any cluster.

## 8 + 10 + 12. Final Report Restructure
Rewrite `src/components/panel/CaseReport.tsx` sections to exactly:

1. Executive Summary
2. Safety / Legal Flags
3. Seed Details
4. Confirmed Findings
5. Probable Findings
6. Leads Requiring Verification
7. Excluded / Collision Clusters
8. Candidate Identity Clusters
9. Contradictions & Data Quality Problems
10. Network Connections by Evidence Strength
11. Timeline of Sourced Events
12. Tool Coverage & Failure Audit
13. Cost / Efficiency Audit
14. Recommended Next Pivots
15. Source Appendix

Bucketing rule:
- **Confirmed Findings**: confidence ≥90 AND ≥2 independent strong sources.
- **Probable**: 75–89 with ≥1 strong + corroboration.
- **Leads**: everything else, including all breach-only emails/phones/hashes/migration IDs.
- **Key Findings** widget (`KeyFindings.tsx`): only items that qualify for "Confirmed". Breach-only items demoted automatically.

Language linter: post-process the agent's prose to replace `confirmed|real identity|belongs to|same person|verified` with cautious equivalents (`observed in`, `source indicates`, `candidate`, `possible match`) unless the artifact passes the strong-selector test.

## 9 / 11. Required Artifact Fields
`record_artifact` server validator requires the full envelope:

```
{ value, kind, source, source_category, confidence, status, cluster_id,
  reason_for_confidence, reason_not_confirmed, contradictions[],
  next_verification_step, created_at }
```

`status` enum: `new | verified | probable | needs_review | contradicted | excluded | exhausted | manual_review_required`. Missing fields are auto-filled with conservative defaults (`status='new'`, `reason_not_confirmed='single_source'`) and a `metadata.schema_warning` is set so audit can surface lazy recordings.

## 11. Recommended Pivot Logic
Planner gets a "gap-driven" prompt addendum: for each cluster with status `probable|needs_review`, propose at most 3 pivots that would move it to `verified`. Pivots already attempted (per dedup) are excluded. Output sorted by `confidence_uplift_potential` not by priority alone.

---

## Files Touched
- New: `supabase/functions/osint-agent/circuit.ts`, `clusters.ts`, `artifact_types.ts`
- Edit: `supabase/functions/osint-agent/index.ts` (wrapper + validator + planner prompt + record_artifact path)
- Edit: `confidence.ts`, `contradictions.ts`, `playbooks.ts`, `workflow_prompt.ts`
- Edit: `src/components/panel/CaseReport.tsx`, `KeyFindings.tsx`, `OverviewTab.tsx`, `FailedSkippedTab.tsx`
- Edit: `src/lib/entityIcons.ts` (new kinds)

## Verification
1. Re-run the ryan.r.matta@gmail.com seed; expect: zero duplicate calls for same `call_key`, `bosint_phone_lookup` capped at 1 attempt, `stolentax_footprint` disabled after first 403, no `kind=other` artifacts, no confidence ≥90 for breach-only items.
2. Phone `3103842124` collision case: confirm a `contradiction` artifact lands and Maurice/Kyle/Angie remain in separate clusters.
3. Cost audit: total micro-USD drops materially vs the 255,800 baseline.
4. Report renders the 15-section structure with breach-only items only in "Leads Requiring Verification".
