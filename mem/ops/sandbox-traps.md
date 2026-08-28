# Sandbox traps that cost real time (2026-08-25)

## `deno test` rewrites `deno.lock` and DROPS real dependencies

Running the edge suite in the web/remote sandbox rewrote `deno.lock`, adding the
installer's own package (`jsr:@deno/installer-shell-setup`) and **removing four
real dependency entries**: `@ai-sdk/google`, `@lovable.dev/cloud-auth-js`,
`vaul`, `vitest`.

Use `--no-lock` for local runs, and **never commit that diff** — a stop hook will
happily prompt you to. Check `git diff deno.lock` before staging.

## `tsc` also typechecks `supabase/functions/**`

The frontend `npm run typecheck` covers the Deno sources, and that project's lib
target predates ES2022. `Error.cause` broke the frontend typecheck from a Deno
file; read `cause` structurally (`(e as unknown as { cause?: unknown }).cause`)
rather than off the `Error` type.

## The first `deno check` after a new cross-directory import can lie

It reported a `TS2345` on pre-existing, untouched code that did not reproduce on
any later run — a cold-resolution artifact, in the same run that emitted the npm
peer-dependency warnings. Re-run before believing a first-time error.

## A test that passes before AND after your fix proves nothing

Two incidents in one session:

- The in-flight marker leak tests were **confirmed to FAIL against the pre-fix
  file** before being accepted (2 failed, happy-path control still passing).
- The first selector-cache invalidation test was **vacuous**: the fake Supabase
  returned no artifact rows, so `loadSelectorEvidence` early-returned without
  ever caching, and the assertion compared `0` to `0` whether or not anything was
  wired. Making it real exposed a genuine placement bug — `record_artifacts`,
  `record_artifact` and `record_evidence` are `NO_CACHE_TOOLS` and exit through a
  **different wrapper**, so a hook on the main path never ran for the three tools
  that write the most artifacts.

Always prove a new test fails without the fix. For SQL assertions, flip one
expected count and confirm a non-zero exit.

## Postgres is present but not running

`service postgresql start`, set the `postgres` password, create a throwaway DB,
apply `.github/ci/supabase-platform-shim.sql`, then the migrations in
`sort -t_ -k1,1` order. This is how migration-level behaviour should be verified
rather than by inspection.
