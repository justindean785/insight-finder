# Full Extensive Audit Plan

Goal: produce a written report (no code changes) covering current state of the OSINT agent backend, frontend, database, and deploy pipeline — pinpointing what's actually wrong vs. what's healthy.

## Scope

### 1. Live backend probe
- Hit `osint-agent?health=1`, confirm build marker + orchestrator/tool readiness.
- Pull recent `edge_function_logs` for `osint-agent` (errors, timeouts, 4xx/5xx patterns).
- Run `supabase--cloud_status` + `db_health` + `linter`.

### 2. Edge function code audit (`supabase/functions/osint-agent/**`)
Apply the bundled `osint-agent-audit` skill across 5 dimensions:
- Observability (tool_usage_log coverage, no throw-on-log)
- Artifact quality (no per-row floods, dedup, real `source`)
- Cost tracking (every tool in `costs.ts`, atomic increments, cached=0)
- Memory quality (`save_agent_memories` upsert semantics, normalized subject)
- Investigation stability (per-tool try/catch, stepCount, fetchRetry, fallback model, graceful key-missing)
Plus: degraded-tool + dead-host logic, SSRF guard, circuit breaker, rate limiter, runtime policy, collision/exclusion.

### 3. Database audit
- RLS coverage on `threads`, `messages`, `artifacts`, `agent_memory`, `tool_usage_log`, `evidence_log`, `user_roles`.
- Grants on public tables.
- Indexes for hot paths (thread_id, user_id, dedup keys).
- Evidence chain integrity (`verify_evidence_chain` sanity).

### 4. Frontend audit (`src/**`)
- ChatWindow transport + status mapping (401/403/404/429/5xx → analyst UX).
- Auth flow, session refresh, thread ownership handling.
- Artifact rendering, panel tabs, confidence display coherence with backend.
- Error boundaries, toasts, command palette, cost meter.

### 5. Deploy pipeline / drift
- Confirm whether GitHub→Lovable→Supabase auto-deploy is currently firing for `supabase/functions/**` changes.
- Diff source build marker vs. live build marker.
- Identify why manual redeploy was needed (the recurring issue).

### 6. Security
- Run `security--run_security_scan` + review findings.
- Check secret usage in code vs. `secrets` list — flag orphans / missing.

### 7. Tests
- Inventory of `*_test.ts` (Deno) + `src/test/*` (Vitest); call out any obviously stale or skipped suites.

## Deliverable

A single markdown report posted in chat with:
- **Verdict** (healthy / degraded / broken) per area
- **Findings table** (severity, file:line, evidence, fix)
- **Root cause** for the recurring "needs manual redeploy" pain point
- **Prioritized remediation list** (P0/P1/P2)
- **Smoke tests to run after fixes**

No files modified. Implementation of any fixes happens only after you pick which findings to action.
