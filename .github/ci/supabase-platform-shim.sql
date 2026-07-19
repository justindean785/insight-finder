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

-- pgcrypto schema parity (production faithfulness).
-- On Supabase, pgcrypto is installed in the `extensions` schema, NOT `public`.
-- A bare `CREATE EXTENSION IF NOT EXISTS pgcrypto` (as the migrations run) installs
-- it into `public` on a vanilla postgres:15 container — so a SECURITY DEFINER
-- function with `SET search_path = public` resolves an *unqualified* digest()
-- and CI passes while production fails. Install pgcrypto in `extensions` here so
-- the migration's later bare CREATE EXTENSION is a no-op and digest() stays out of
-- `public` — reproducing production exactly. This is what un-masks the
-- record_analyst_feedback digest() regression (fixed forward in 20260718000000).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Match production's database default search_path so table DEFAULTs and
-- non-SECURITY-DEFINER contexts resolve extension functions the way prod does.
-- Functions that pin their own SET search_path are unaffected — that is the point.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = %s', current_database(), '"$user", public, extensions');
END $$;

-- Supabase default privileges: every new table in `public` auto-GRANTs ALL to
-- anon/authenticated/service_role. Replicate that grant baseline so CI matches
-- production — and so a least-privilege REVOKE migration (20260718000001) has a
-- real over-grant to tighten, provable by grants_least_privilege_test.sql.
--
-- ⚠️ CI-ONLY SIMULATION. This entire file is the isolated CI bootstrap (see the
-- header: "never applied to the real database"). This ALTER DEFAULT PRIVILEGES
-- exists ONLY here, runs ONLY against the disposable CI postgres container, and
-- MUST NEVER appear in a production migration or run against production
-- credentials. Production already has this baseline via Supabase itself; the
-- product invariant is enforced by RLS + the D1 REVOKE, not by this simulation.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
