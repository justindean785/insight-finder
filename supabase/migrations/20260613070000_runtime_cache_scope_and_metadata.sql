alter table public.tool_call_cache
  add column if not exists user_id uuid,
  add column if not exists selector_normalized text,
  add column if not exists selector_type text,
  add column if not exists params_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists source_created_at timestamptz,
  add column if not exists stale boolean not null default false;

update public.tool_call_cache
set user_id = coalesce(
  user_id,
  (
    select t.user_id
    from public.threads t
    where t.id = tool_call_cache.investigation_id
  )
)
where user_id is null;

-- Rows whose investigation no longer resolves to an owner cannot be reused
-- safely. Remove them before making user ownership mandatory.
delete from public.tool_call_cache
where user_id is null;

alter table public.tool_call_cache
  alter column user_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tool_call_cache_user_id_fkey'
      and conrelid = 'public.tool_call_cache'::regclass
  ) then
    alter table public.tool_call_cache
      add constraint tool_call_cache_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end
$$;

create index if not exists tool_call_cache_user_lookup_idx
  on public.tool_call_cache (user_id, tool_name, created_at desc);

create index if not exists tool_call_cache_selector_lookup_idx
  on public.tool_call_cache (user_id, selector_type, selector_normalized, created_at desc);

create index if not exists tool_call_cache_expiry_idx
  on public.tool_call_cache (expires_at)
  where expires_at is not null;

drop index if exists tool_call_cache_unique_idx;

-- The previous uniqueness scope included investigation_id. Collapse duplicate
-- same-user cache rows before introducing the broader reusable key.
delete from public.tool_call_cache older
using public.tool_call_cache newer
where older.user_id = newer.user_id
  and older.tool_name = newer.tool_name
  and older.input_hash = newer.input_hash
  and (
    older.created_at < newer.created_at
    or (older.created_at = newer.created_at and older.id < newer.id)
  );

create unique index if not exists tool_call_cache_user_tool_hash_uidx
  on public.tool_call_cache (user_id, tool_name, input_hash);
