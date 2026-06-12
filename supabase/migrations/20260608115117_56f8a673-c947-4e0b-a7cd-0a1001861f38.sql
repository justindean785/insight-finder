alter table public.tool_usage_log
  add column if not exists charged_micro_usd integer not null default 0;

update public.tool_usage_log
  set charged_micro_usd = cost_micro_usd
  where ok = true and cached = false and charged_micro_usd = 0;