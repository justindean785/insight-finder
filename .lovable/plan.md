## Goal

Get the deployed `osint-agent` build to match the source stamped in `supabase/functions/osint-agent/build-info.ts` (`BUILD_MARKER = "90abd5f"`, committed 2026-07-08). Currently `?health=1` still reports `build: 51c9f0f` from 2026-07-05 — propagation from the GitHub mirror hasn't landed.

## Steps

1. Trigger a direct redeploy of the `osint-agent` edge function using the platform deploy tool (no code changes — the source already carries the correct build marker).
2. Re-hit `GET /functions/v1/osint-agent?health=1` and read back the `build` field.
3. Report the result verbatim:
   - Deploy tool output (success / error).
   - New `build` value — expected `90abd5f`; if it reads anything else, surface exactly what it says.

## Non-goals

- No code edits.
- No frontend changes.
- No changes to other edge functions or config.
