-- CI-ONLY SHIM — never applied to the real database.
--
-- The migrations in supabase/migrations/ reference objects that the Supabase
-- platform provisions outside this repo: roles (anon / authenticated /
-- service_role), the auth schema (GoTrue), the storage schema (storage-api),
-- and the supabase_realtime publication (Realtime). The CI "migrations" job
-- applies this file once against a throwaway vanilla postgres:15 service
-- container so the real migrations can then be validated with
-- `psql --set ON_ERROR_STOP=1` in timestamp order.
--
-- Only the surface the migrations actually touch is stubbed here. If a new
-- migration references another platform object (e.g. vault, pg_cron, net),
-- add a matching stub.

-- Roles the platform pre-creates.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- auth schema (GoTrue): auth.users columns the migrations read
-- (id, email, raw_user_meta_data) plus auth.uid().
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) UNIQUE,
  raw_user_meta_data jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- storage schema (storage-api): buckets/objects tables and foldername(),
-- matching the shapes the migrations insert into and write policies against.
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  public boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now()
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- Realtime publication (Realtime service creates this on the platform;
-- migrations ALTER PUBLICATION supabase_realtime ADD TABLE ...).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- pg_cron / pg_net: CI's vanilla postgres:15 image has neither extension binary
-- available, so migrations guard `CREATE EXTENSION` on pg_available_extensions
-- and skip it here. These stubs stand in for cron.schedule/cron.unschedule/
-- net.http_get so a migration's SCHEDULING CALL is still syntax-checked by CI
-- (not merely skipped) even though no real cron job ever fires against this
-- throwaway database.
CREATE SCHEMA IF NOT EXISTS cron;

CREATE TABLE IF NOT EXISTS cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text UNIQUE,
  schedule text,
  command text,
  active boolean DEFAULT true
);

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO cron.job (jobname, schedule, command)
  VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql
AS $$
  DELETE FROM cron.job WHERE jobname = job_name;
  SELECT true;
$$;

CREATE SCHEMA IF NOT EXISTS net;

CREATE OR REPLACE FUNCTION net.http_get(
  url text,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE sql
AS $$
  SELECT 0::bigint;
$$;
