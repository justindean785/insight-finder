-- Migration validation script for pivot loop tables
-- Run after applying both pivot_rounds and pivot_excluded_selectors migrations
-- This verifies all schema requirements are met

begin;

-- Check 1: pivot_rounds table exists
assert (
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'pivot_rounds'),
  'ERROR: pivot_rounds table does not exist'
);

-- Check 2: pivot_excluded_selectors table exists
assert (
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'pivot_excluded_selectors'),
  'ERROR: pivot_excluded_selectors table does not exist'
);

-- Check 3: pivot_rounds has required columns
assert (
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'pivot_rounds'
   and column_name in ('id', 'investigation_id', 'plan', 'execution_results', 'intelligence_delta', 'round_complete', 'created_at'))
  = 7,
  'ERROR: pivot_rounds missing required columns'
);

-- Check 4: pivot_excluded_selectors has required columns
assert (
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'pivot_excluded_selectors'
   and column_name in ('id', 'investigation_id', 'tool_name', 'selector', 'reason', 'created_at'))
  = 6,
  'ERROR: pivot_excluded_selectors missing required columns'
);

-- Check 5: Foreign key constraint exists (pivot_rounds → investigations)
assert (
  exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'pivot_rounds'
    and constraint_type = 'FOREIGN KEY' and constraint_name like '%investigation_id%'
  ),
  'ERROR: Foreign key constraint missing on pivot_rounds.investigation_id'
);

-- Check 6: Foreign key constraint exists (pivot_excluded_selectors → investigations)
assert (
  exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'pivot_excluded_selectors'
    and constraint_type = 'FOREIGN KEY' and constraint_name like '%investigation_id%'
  ),
  'ERROR: Foreign key constraint missing on pivot_excluded_selectors.investigation_id'
);

-- Check 7: Unique constraint on pivot_excluded_selectors
assert (
  exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'pivot_excluded_selectors'
    and constraint_type = 'UNIQUE'
  ),
  'ERROR: Unique constraint missing on pivot_excluded_selectors'
);

-- Check 8: Primary key on pivot_rounds
assert (
  exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'pivot_rounds'
    and constraint_type = 'PRIMARY KEY'
  ),
  'ERROR: Primary key missing on pivot_rounds'
);

-- Check 9: RLS is enabled on both tables
assert (
  (select rowsecurity from pg_class where relname = 'pivot_rounds') = true,
  'ERROR: RLS not enabled on pivot_rounds'
);

assert (
  (select rowsecurity from pg_class where relname = 'pivot_excluded_selectors') = true,
  'ERROR: RLS not enabled on pivot_excluded_selectors'
);

-- Check 10: Indexes exist
assert (
  (select count(*) from pg_indexes where tablename in ('pivot_rounds', 'pivot_excluded_selectors')) >= 4,
  'ERROR: Required indexes missing'
);

commit;

-- Summary
select 'All pivot loop migration validations passed' as status;
