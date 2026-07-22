-- Structured Pivot Loop: pivot_excluded_selectors table
-- Persistent registry of excluded selectors to prevent retry across crashes and rounds

create table public.pivot_excluded_selectors (
  id text not null default gen_random_uuid()::text,
  investigation_id text not null,

  -- Selector identity
  tool_name text not null,
  selector text not null,

  -- Exclusion context
  reason text not null, -- 'collision' | 'noise' | 'safety' | 'queried' | 'corroboration_held'
  excluded_in_round integer,
  excluded_by_decision text, -- the PivotDecision that led to exclusion
  exclusion_rationale text,

  -- Escalation state
  escalated_at timestamp with time zone, -- if the user escalated a HOLD to PROCEED
  escalation_artifact_id text,

  -- Timestamps
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  primary key (id),
  unique(investigation_id, tool_name, selector),
  constraint pivot_excluded_selectors_investigation_id_fkey
    foreign key (investigation_id) references public.investigations(id) on delete cascade
);

create index idx_pivot_excluded_selectors_investigation_id on public.pivot_excluded_selectors(investigation_id);
create index idx_pivot_excluded_selectors_reason on public.pivot_excluded_selectors(investigation_id, reason);
create index idx_pivot_excluded_selectors_escalated_at on public.pivot_excluded_selectors(escalated_at)
  where escalated_at is not null;

-- Trigger to update updated_at
create or replace function public.pivot_excluded_selectors_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger pivot_excluded_selectors_update_updated_at_trigger
  before update on public.pivot_excluded_selectors
  for each row
  execute function public.pivot_excluded_selectors_update_updated_at();

-- RLS policy: users can manage excluded selectors for their own investigations
alter table public.pivot_excluded_selectors enable row level security;

create policy "Users can view excluded selectors for their investigations"
  on public.pivot_excluded_selectors for select
  using (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );

create policy "Users can insert excluded selectors for their investigations"
  on public.pivot_excluded_selectors for insert
  with check (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );

create policy "Users can update their own excluded selectors"
  on public.pivot_excluded_selectors for update
  using (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );
