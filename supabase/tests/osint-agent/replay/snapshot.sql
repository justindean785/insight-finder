-- replay/snapshot.sql — export ONE case as an L1 replay snapshot (read-only).
--
-- 1. Put the thread id in the `params` line below (one place).
-- 2. Run it in the Supabase SQL editor (or any read-only SQL client on the project).
-- 3. Save the single JSON value it returns as  src/dev/raw/replay/<name>.json
--    (src/dev/raw/ is gitignored — NEVER commit a real snapshot: the repo is public).
-- 4. npm run replay -- src/dev/raw/replay/<name>.json
--
-- It reads artifacts, analyst reviews and the tool-usage log for the thread. It
-- writes nothing.
with params as (
  select '00000000-0000-0000-0000-000000000000'::uuid as tid
)
select json_build_object(
  'version', 1,
  'case', (
    select json_build_object('label', 'case-' || left(t.id::text, 8), 'seed_kind', t.seed_type, 'seed_value', t.seed_value)
    from public.threads t, params p where t.id = p.tid
  ),
  'artifacts', coalesce((
    select json_agg(json_build_object(
      'id', a.id, 'kind', a.kind, 'value', a.value, 'source', a.source, 'confidence', a.confidence,
      'metadata', a.metadata, 'cluster_id', a.cluster_id, 'created_at', a.created_at
    ) order by a.created_at, a.id)
    from public.artifacts a, params p where a.thread_id = p.tid
  ), '[]'::json),
  'reviews', coalesce((
    select json_agg(json_build_object('artifact_id', r.artifact_id, 'state', r.state, 'created_at', coalesce(r.updated_at, r.created_at))
      order by coalesce(r.updated_at, r.created_at), r.artifact_id)
    from public.artifact_reviews r, params p
    where r.artifact_id in (select a.id from public.artifacts a where a.thread_id = p.tid)
  ), '[]'::json),
  'tool_usage', coalesce((
    select json_agg(json_build_object('tool_name', u.tool_name, 'outcome', u.outcome, 'input_json', u.input_json, 'created_at', u.created_at)
      order by u.created_at, u.id)
    from public.tool_usage_log u, params p where u.thread_id = p.tid
  ), '[]'::json)
) as snapshot;
