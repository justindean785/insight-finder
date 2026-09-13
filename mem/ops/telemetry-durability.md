# Where each telemetry number durably lives

**Measured 2026-09-13.** A meter nobody can read a week later is not a meter. Check this before
planning any measurement that spans days.

| Store | Retention, measured | Holds |
|---|---|---|
| `tool_usage_log` | **15,136 rows back to 2026-06-08** — three months | every tool call: `outcome`, `status_code`, `cached`, cost. **Durable.** |
| `evidence_log` / `artifacts` / `threads` | back to 2026-06-08 / 07-05 / 07-05 | case data. Durable. |
| `orchestrator_invocations` / `orchestrator_step_metrics` | **only 2026-09-11 onward** (58 / 350 rows) | per-invocation and per-step timing + context |
| `prompt_size_initial` / `prompt_size_step` / `run_budget_prior` | **nothing — `console.log` only** | the honest prompt terms and prior spend |

## The two-day floor is NOT a purge — do not report it as one

No `pg_cron`. No trigger on either table (`pg_trigger` where `NOT tgisinternal` returns zero rows
for both). Every other table holds months. They are a **two-day-old feature**:
`supabase/migrations/20260908000000_orchestrator_telemetry.sql` from #560, applied live around
2026-09-11. They accumulate normally from here.

Incidentally that migration is **absent** from the live ledger, which still tops out at
`20260825024640` — more evidence that `supabase/migrations/` is intent, not mechanism.

## The real gap: the durable table records the WRONG number

`orchestrator_invocations.initial_context_chars` and `orchestrator_step_metrics.context_chars` are
fed by `approxPromptChars` (`telemetry.ts:175,223`) — the meter that omits the workflow addendum,
the analyst-decisions block, the per-step directives and **every tool schema**. The honest
measurement added in #587 goes to `console.log`, so it reaches only short-lived edge-function logs.

A week from now the durable store still holds the floor, and the accurate figure may be gone.

## Consequences

- **A2b (the per-investigation budget) is SAFE.** `run_budget_prior` classifies rows it reads out
  of `tool_usage_log`, which retains three months. The evidence will be there even though the log
  line will not.
- **A context-size target is NOT safe to set from telemetry yet.** Give `prompt_size_step` a
  durable home first — add the term breakdown to `orchestrator_step_metrics` (a schema change, so
  through Lovable and verified against the live DB).
- **Do not "fix" `approxPromptChars`** to close the gap. It *routes providers*; changing it changes
  behaviour. That is exactly why #587 left it alone and shipped an honest meter beside it.
