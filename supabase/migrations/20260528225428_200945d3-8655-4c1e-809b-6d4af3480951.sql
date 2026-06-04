alter table public.tool_usage_log
  add column if not exists error_msg text,
  add column if not exists status_code int;