-- CostGate v2: separate ACTUAL charged credits from ATTRIBUTED list price.
--
-- cost_micro_usd has always logged the tool's list price for every paid,
-- non-cached call — INCLUDING failures — for "charged vs. avoided" analytics.
-- That made failed-call list prices look like real charges when summed by the
-- export/UI. charged_micro_usd records the success-only credits actually
-- consumed (billing.ts creditsCharged): 0 for cache hits, free stubs, and any
-- failure. cost_micro_usd keeps its original meaning for backward compatibility.
--
-- Backfill: for existing rows the true charged value is reconstructable —
-- a successful, non-cached call was charged its logged cost; everything else 0.
alter table public.tool_usage_log
  add column if not exists charged_micro_usd integer not null default 0;

update public.tool_usage_log
  set charged_micro_usd = cost_micro_usd
  where ok = true and cached = false and charged_micro_usd = 0;
