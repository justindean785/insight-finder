-- Structured Pivot Loop: pivot_rounds table
-- Stores the complete history of investigation rounds for structured pivot loop feature

create table public.pivot_rounds (
  id text not null default gen_random_uuid()::text,
  investigation_id text not null,

  -- Seed context
  seed_artifact_id text,
  seed_reason text,

  -- Round metadata
  round_number integer not null,
  plan jsonb not null, -- PivotPlan serialized

  -- Execution state
  execution_started_at timestamp with time zone,
  execution_completed_at timestamp with time zone,
  execution_results jsonb, -- array of ExecutionResult

  -- Intelligence delta
  intelligence_delta jsonb, -- IntelligenceDelta

  -- Round completion state
  round_complete boolean not null default false,
  final_reason text,

  -- Timestamps
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  primary key (id),
  constraint pivot_rounds_investigation_id_fkey
    foreign key (investigation_id) references public.investigations(id) on delete cascade
);

create index idx_pivot_rounds_investigation_id on public.pivot_rounds(investigation_id);
create index idx_pivot_rounds_created_at on public.pivot_rounds(created_at desc);
create index idx_pivot_rounds_round_number on public.pivot_rounds(investigation_id, round_number);

-- Trigger to update updated_at
create or replace function public.pivot_rounds_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger pivot_rounds_update_updated_at_trigger
  before update on public.pivot_rounds
  for each row
  execute function public.pivot_rounds_update_updated_at();

-- RLS policy: users can view rounds for their own investigations
alter table public.pivot_rounds enable row level security;

create policy "Users can view pivot rounds for their investigations"
  on public.pivot_rounds for select
  using (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );

create policy "Users can insert pivot rounds for their investigations"
  on public.pivot_rounds for insert
  with check (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );

create policy "Users can update their own pivot rounds"
  on public.pivot_rounds for update
  using (
    (select user_id from public.investigations where id = investigation_id) = auth.uid()
  );
