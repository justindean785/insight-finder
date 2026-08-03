-- jsonb-nul.sql -- which control characters can actually be stored in jsonb?
--
-- Run against any PostgreSQL (measured on 16.13):
--   initdb -D /tmp/pg/data -U postgres --auth=trust
--   pg_ctl -D /tmp/pg/data -o "-k /tmp/pg -h ''" -l /tmp/pg/log start
--   psql -h /tmp/pg -U postgres -f docs/reproducers/jsonb-nul.sql
--
-- WHY THIS FILE EXISTS
-- The 2026-08-02 incident (thread e66255da) lost a complete 12,736-character
-- report to "ERROR: unsupported Unicode escape sequence" when a NUL from
-- http_fingerprint reached messages.parts. The first fix stripped the entire C0
-- range plus DEL on the assumption that control bytes are broadly JSONB-unsafe.
-- That assumption was never tested against a database. It is wrong, and in an
-- evidence system deleting storable bytes is its own data loss.
--
-- RESULT (PostgreSQL 16.13):
--   U+0000  REJECTED, in values AND in keys -- ERROR: unsupported Unicode escape sequence
--   U+0001 U+0007 U+0008 U+000B U+000C U+000E U+001F U+007F
--           ACCEPTED everywhere, and round-trip byte-exact
--
-- Postgres rejects U+0000 because its `text` type cannot represent a NUL -- not
-- because JSON forbids it. So supabase/functions/osint-agent/safety.ts strips
-- exactly U+0000 and nothing else.
--
-- Do not widen that set without adding a failing case here first.

\set ON_ERROR_STOP off
DROP TABLE IF EXISTS nul_probe;
CREATE TABLE nul_probe(id serial primary key, parts jsonb);

\echo '--- U+0000 in a VALUE (expect ERROR) ---'
INSERT INTO nul_probe(parts) VALUES ('{"k":"a\u0000b"}'::jsonb);

\echo '--- U+0000 in a KEY (expect ERROR) ---'
INSERT INTO nul_probe(parts) VALUES ('{"k\u0000x":"v"}'::jsonb);

\echo '--- every other C0 control + DEL (expect all to succeed) ---'
INSERT INTO nul_probe(parts) VALUES
  ('{"k":"a\u0001b"}'::jsonb),
  ('{"k":"a\u0007b"}'::jsonb),
  ('{"k":"a\u0008b"}'::jsonb),
  ('{"k":"a\u000Bb"}'::jsonb),
  ('{"k":"a\u000Cb"}'::jsonb),
  ('{"k":"a\u000Eb"}'::jsonb),
  ('{"k":"a\u001Fb"}'::jsonb),
  ('{"k":"a\u007Fb"}'::jsonb);

\echo '--- and in KEYS too (expect all to succeed) ---'
INSERT INTO nul_probe(parts) VALUES
  ('{"k\u0007x":"v"}'::jsonb),
  ('{"k\u007Fx":"v"}'::jsonb);

\echo '--- round-trip is byte-exact: expect len 3, codepoints 7 and 127 ---'
SELECT length(parts->>'k') AS len,
       ascii(substring(parts->>'k' from 2 for 1)) AS mid_codepoint
  FROM nul_probe
 WHERE parts->>'k' IN (E'a\x07b', E'a\x7Fb')
 ORDER BY mid_codepoint;
