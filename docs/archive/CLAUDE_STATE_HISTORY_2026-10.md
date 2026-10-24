# CLAUDE.md dated-state history (archived 2026-10-19)

Verbatim copy of the dated-state lines that sat near the top of `CLAUDE.md` (lines 23-27 at `e262431`, last edited 2026-10-15).
Every line here is a dated MEASUREMENT from 2026-10-14/15 and is STALE; kept only for history. `CLAUDE.md` keeps the rules; take current
state from the deploy ledger, `git log origin/main`, the mirror tree hashes and the newest handoff.

---

> Last verified (2026-10-14T02:46Z): live `osint-agent` = `66cf1c3` (batch #744 #745 #703 #698 #751 #746 #747), `deploy/live` -> `66cf1c3`, mirror `120c76e`, canonical `main` `5faa6ce`.
> **The orchestrator is GLM-5.2 PRIMARY, Anthropic is the BACKUP** (operator decision, JD, 2026-10-15). Live `/health` (build `dd20ed4`) reports `selected_provider: deepseek`, `selected_model: glm-5.2`, `orchestrator_reason: "pinned"`; 41 clean GLM runs in the 4 days to 2026-10-15. The Anthropic key works again (19 clean runs 2026-10-14), but 11 Anthropic runs died on HTTP 400 `tool_use.input: Input should be an object` — fixed by #765. Anthropic-as-fallback (GLM can't START a run → Anthropic; never mid-run) is #769, stacked on #765; proof key `checks.orchestrator_fallback`. **Do not re-pin `ORCHESTRATOR_PROVIDER=anthropic`** without JD. Z.AI ran out of balance on 2026-10-13 — that is the failure the backup exists for. History: #748 pinned Anthropic on 2026-10-14; `SESSION_HANDOFF_2026-10-14_anthropic-orchestrator-and-the-dropped-connection.md`.
> **The S1a run lease is deployed but DISABLED** (`RUN_LEASE_DISABLED=true`; `/health` `checks.run_lease` reads `LEGACY`). Do not re-enable it, or change that secret, without JD's explicit authorization. Details: `SESSION_HANDOFF_2026-10-10_s1a-admission-lease-and-the-heartbeat-incident.md`.
> Recent proof keys, newest last: `checks.run_end_log` (#714), `checks.breach_origin_cap` (#718), `checks.memory_context` (#721), `checks.user_supplied_status` (#724), `checks.run_lease` (#730/#734), `checks.orchestrator_anthropic` (#748), `checks.seed_account_id` / `checks.exact_boolean_repair` / `checks.memory_input_normalization` (#744/#746/#747). Unmerged, waiting on JD: `checks.client_cancel_isolation` (#758 — a dropped browser connection no longer ends the run) and the LeakCheck guard (#756).
> Baselines drift every PR: edge 2316 passed / 0 failed / 6 ignored, frontend 2560 passed / 1 skipped / 198 files, `npm run test:e2e` 52 passed / 2 skipped (measured 2026-10-14 on the #758/#759 branches; re-measure before blaming a diff).
