#!/usr/bin/env bash
# CI regression (finding #10): proves the artifacts_thread_kind_value_source_uidx
# unique index enforces deduplication under GENUINE concurrency — two real
# overlapping Postgres sessions, not two sequential calls in one script. Session 1
# opens a transaction and holds it for 2s before committing; Session 2 starts its
# conflicting insert mid-way through that window, so it must BLOCK on the unique
# index and then fail once Session 1 commits. A flaky/sequential test could pass
# by accident even with no real constraint; this cannot. Relies on the psql
# connection env vars the CI "migrations" job already exports (PGHOST/PGUSER/
# PGPASSWORD/PGDATABASE). Not a migration; never touches prod.
set -euo pipefail

UID_TEST="dddddddd-0000-4000-8000-000000000004"

psql --set ON_ERROR_STOP=1 -t -A -c "SELECT set_config('request.jwt.claim.sub', '${UID_TEST}', false);" >/dev/null
psql --set ON_ERROR_STOP=1 -t -A -c "INSERT INTO auth.users(id, email) VALUES ('${UID_TEST}', 'ci-concurrent@example.test') ON CONFLICT DO NOTHING;" >/dev/null
TID=$(psql --set ON_ERROR_STOP=1 -t -A -c "INSERT INTO public.threads(user_id) VALUES ('${UID_TEST}') RETURNING id;" \
  | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

if [ -z "${TID}" ]; then
  echo "FAIL: could not create test thread"
  exit 1
fi

psql -q <<SQL1 > /tmp/race1.log 2>&1 &
SELECT set_config('request.jwt.claim.sub', '${UID_TEST}', false);
BEGIN;
INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence)
VALUES ('${TID}', '${UID_TEST}', 'concurrent_test', 'race-value', 'raceProvider', 50);
SELECT pg_sleep(2);
COMMIT;
SQL1
PID1=$!

sleep 0.5

psql -q <<SQL2 > /tmp/race2.log 2>&1 &
SELECT set_config('request.jwt.claim.sub', '${UID_TEST}', false);
INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence)
VALUES ('${TID}', '${UID_TEST}', 'concurrent_test', 'race-value', 'raceProvider', 60);
SQL2
PID2=$!

wait "${PID1}"
wait "${PID2}"

N=$(psql -t -A -c "SELECT count(*) FROM public.artifacts WHERE thread_id = '${TID}' AND kind = 'concurrent_test' AND value = 'race-value';")

if [ "${N}" != "1" ]; then
  echo "FAIL: expected exactly 1 surviving row after the concurrent race, got ${N}"
  echo "--- session 1 log ---"; cat /tmp/race1.log
  echo "--- session 2 log ---"; cat /tmp/race2.log
  exit 1
fi

if ! grep -q "duplicate key value violates unique constraint \"artifacts_thread_kind_value_source_uidx\"" /tmp/race2.log; then
  echo "FAIL: the losing session did not fail with the expected unique-constraint violation — the race may not have been genuine"
  echo "--- session 2 log ---"; cat /tmp/race2.log
  exit 1
fi

echo "concurrent-dedup-test OK: two genuinely overlapping sessions raced the same duplicate insert, exactly 1 row survived, the loser failed on artifacts_thread_kind_value_source_uidx"
