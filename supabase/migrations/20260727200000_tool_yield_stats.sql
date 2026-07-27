-- Step 1 of adaptive tool selection (docs/adaptive-tool-selection.md): make tool
-- YIELD measurable, so the scheduler can rank on "what produces evidence" instead
-- of "what returns HTTP 200".
--
-- WHY THIS IS NEEDED: tool_health scores reliability and latency only, and its
-- ok_pct excludes the 'empty' outcome from BOTH the numerator and the denominator.
-- "Ran fine, found nothing" is therefore invisible to scoring rather than
-- penalised. Measured on production 2026-07-27: google_dorks logged 309 calls at
-- 99.7% ok and produced 5 artifacts, while dork_harvest produced 1,132 from 138
-- calls. Nothing in the system can currently tell those two apart.
--
-- DESIGN NOTE — why views and not columns:
-- Analyst verdicts arrive minutes to days AFTER the tool call, so "did this call
-- produce evidence that survived review" can never be known at write time. It has
-- to be computed on read. The upside is that these views work on the 13k rows
-- already in tool_usage_log — ranking data exists the moment this migration lands,
-- with no backfill and no waiting for new investigations.
--
-- Two views, deliberately separate, because they can honestly claim different
-- things:
--   • tool_yield_by_seed       — works on ALL historical data. Thread-level
--                                attribution, so it answers "what should I open an
--                                email investigation with?"
--   • tool_yield_by_transition — needs per-call extracted_findings (added below,
--                                populated going forward). Answers "what pivots
--                                well AFTER oathnet_lookup?" Empty until the edge
--                                function ships and starts logging.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Per-call structural yield. Counted by extractFindings() at call time from the
-- tool's own output, so it is exact and immune to the attribution ambiguity the
-- historical view has to live with. NULL on every pre-existing row.
-- ---------------------------------------------------------------------------
alter table public.tool_usage_log
  add column if not exists extracted_findings integer;

comment on column public.tool_usage_log.extracted_findings is
  'Count of findings extractFindings() pulled from this call''s output. NULL = not measured (rows written before the yield-logging deploy). 0 = measured and the call yielded nothing, which is the signal ok_pct throws away.';

-- Bookkeeping tools are excluded everywhere below. They are not investigative
-- pivots, they never carry an artifact source, and two of them (record_artifact /
-- record_artifacts) are substrings of each other, which would break the
-- slug-matching attribution.
create or replace view public.tool_yield_bookkeeping as
  select unnest(array[
    'record_artifacts', 'record_artifact', 'memory_save', 'memory_recall',
    'list_tools', 'coverage_audit', 'detect_contradictions',
    'finalize_no_findings', 'finalize_skip_memory', 'unknown_tool_ignored'
  ]) as tool_name;

-- ---------------------------------------------------------------------------
-- Artifact → tool attribution.
--
-- artifacts.source is FREE TEXT. Most rows name one tool; ~3.6% name several
-- ('oathnet_lookup, leakcheck_lookup, serus_darkweb_scan'). It cannot be split on
-- commas, because a source may contain commas that are not separators — e.g.
-- 'leakcheck_lookup (National Public Data — LEE, A, TAYLOR)'. So we match known
-- tool slugs against the string instead.
--
-- Credit is SPLIT evenly across the tools named. Crediting each contributing tool
-- in full inflates tools that co-occur, which is exactly the bias that would make
-- a corroborating tool look better than a tool that finds things alone.
-- ---------------------------------------------------------------------------
create or replace view public.tool_artifact_attribution as
with known_tools as (
  select distinct l.tool_name
  from public.tool_usage_log l
  where l.tool_name is not null
    and l.tool_name not in (select tool_name from public.tool_yield_bookkeeping)
),
matched as (
  select a.id as artifact_id, a.thread_id, a.user_id, k.tool_name
  from public.artifacts a
  join known_tools k
    on a.source is not null
   and a.source like '%' || k.tool_name || '%'
)
select
  m.artifact_id,
  m.thread_id,
  m.user_id,
  m.tool_name,
  1.0 / count(*) over (partition by m.artifact_id) as credit,
  -- An artifact is KEPT unless the analyst rejected it. Unreviewed counts as kept:
  -- the analyst reviews a fraction of rows, and treating "not yet looked at" as
  -- rejected would punish every high-volume tool for the analyst's backlog.
  -- Attestation is the only ground truth in the system, so it counts double.
  case
    when r.state in ('dismissed', 'wrong') then 0.0
    when r.state in ('confirmed', 'key')   then 2.0
    else 1.0
  end as keep_weight,
  r.state as review_state
from matched m
left join public.artifact_reviews r on r.artifact_id = m.artifact_id;

-- ---------------------------------------------------------------------------
-- OPENER ranking: "this seed type just arrived — what is worth running?"
--
-- Attribution is thread-level: if a tool ran 5 times in a thread and 10 artifacts
-- name it, we cannot say which call produced which, so yield is divided across the
-- calls. That is fine for an opener ranking and is why the transition view below
-- is kept separate rather than derived from the same join.
-- ---------------------------------------------------------------------------
create or replace view public.tool_yield_by_seed as
with calls as (
  select l.user_id, l.thread_id, l.tool_name, t.seed_type, count(*) as calls
  from public.tool_usage_log l
  join public.threads t on t.id = l.thread_id
  where l.outcome = 'ok'
    and l.tool_name not in (select tool_name from public.tool_yield_bookkeeping)
  group by l.user_id, l.thread_id, l.tool_name, t.seed_type
),
yield as (
  select thread_id, tool_name,
         sum(credit)                     as artifacts,
         sum(credit * keep_weight)       as kept,
         sum(credit) filter (where review_state in ('dismissed', 'wrong')) as rejected,
         sum(credit) filter (where review_state in ('confirmed', 'key'))   as attested
  from public.tool_artifact_attribution
  group by thread_id, tool_name
)
select
  c.user_id,
  c.seed_type,
  c.tool_name,
  sum(c.calls)                                   as ok_calls,
  count(distinct c.thread_id)                    as threads,
  round(coalesce(sum(y.artifacts), 0)::numeric, 2) as artifacts,
  round(coalesce(sum(y.kept), 0)::numeric, 2)      as kept_artifacts,
  round(coalesce(sum(y.rejected), 0)::numeric, 2)  as rejected_artifacts,
  round(coalesce(sum(y.attested), 0)::numeric, 2)  as attested_artifacts,
  -- THE RANKING COLUMN. Kept artifacts per successful call.
  round(coalesce(sum(y.kept), 0)::numeric / nullif(sum(c.calls), 0), 3) as kept_per_call
from calls c
left join yield y on y.thread_id = c.thread_id and y.tool_name = c.tool_name
group by c.user_id, c.seed_type, c.tool_name;

comment on view public.tool_yield_by_seed is
  'Opener ranking: kept artifacts per successful call, per (user, seed_type, tool). Works on all historical rows. Attribution is thread-level, so treat kept_per_call as directional; apply a sample-size floor (see HEALTH_MIN_SAMPLES) before ranking on it.';

-- ---------------------------------------------------------------------------
-- TRANSITION ranking: "oathnet_lookup just returned — what pivots well next?"
--
-- prior_tool is derived with a window function over the existing log, so the
-- CONTEXT is available for historical rows. The YIELD is not: it uses per-call
-- extracted_findings, which is NULL before the yield-logging deploy. Rows with no
-- measurement are excluded rather than counted as zero — silently treating
-- "unmeasured" as "yielded nothing" would make every historical transition look
-- dead and poison the ranking on day one.
-- ---------------------------------------------------------------------------
create or replace view public.tool_yield_by_transition as
with seq as (
  select
    l.user_id,
    l.tool_name,
    l.extracted_findings,
    t.seed_type,
    lag(l.tool_name) over (partition by l.thread_id order by l.created_at, l.id) as prior_tool
  from public.tool_usage_log l
  join public.threads t on t.id = l.thread_id
  where l.outcome = 'ok'
    and l.tool_name not in (select tool_name from public.tool_yield_bookkeeping)
)
select
  user_id,
  seed_type,
  prior_tool,
  tool_name,
  count(*)                                             as measured_calls,
  sum(extracted_findings)                              as findings,
  round(avg(extracted_findings)::numeric, 3)           as findings_per_call,
  count(*) filter (where extracted_findings = 0)       as empty_calls
from seq
where extracted_findings is not null
  and prior_tool is not null
group by user_id, seed_type, prior_tool, tool_name;

comment on view public.tool_yield_by_transition is
  'Transition ranking: findings per call for (seed_type, prior_tool -> tool). Empty until the yield-logging deploy populates tool_usage_log.extracted_findings; historical rows are excluded, never counted as zero.';
