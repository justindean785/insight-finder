# Project Memory

## Core
OSINT app with agentic workflow, styled after "Proximity" OSINT app interface.
Stack: React, Tailwind CSS, AI Elements. Backend: Supabase (Postgres, Auth, Edge Functions).
AI: AI SDK with direct Google Gemini integration.
Dark theme aesthetic.
Never redact breach-investigation fields (passwords, hashes, salts, ssn, dob, cc, cvv, otp, mfa) from tool outputs — surfacing them is the product. Only strip our own service auth (token, secret, api_key, cookie, session, authorization).

## Memories
- [Theme and Layout](mem://style/theme) — UI layout structure and dark theme specifics (confidence tokens)
- [Database Schema](mem://data/schema) — Supabase tables and RLS for profiles, threads, messages, artifacts
- [OSINT Integrations](mem://features/integrations) — External APIs and tools used for intelligence gathering
- [Investigation Scope](mem://features/investigation-scope) — Supported OSINT seed types and UI handling for artifacts
- [No PII redaction](mem://preferences/redaction) — Do not re-add password/hash/ssn/dob/cc/cvv/otp to SENSITIVE_KEY_RE in osint-agent
- [Deno tests in web sandbox](mem://ops/deno-tests-in-web-sandbox) — edge tests DO run here; the official installer worked on 2026-08-28 (dl.deno.land 200) and the `npm i deno` + DENO_CERT route is the fallback for when it is 403 again. Pass `--no-lock`.
- [Report layer bypasses the integrity engine](mem://architecture/report-layer-bypasses-integrity-engine) — `record_finding` persists a correct independence-capped confidence, then the model retypes the Findings table in prose; a prompt rule is not enforcement
- [AI SDK positional tool pairing](mem://architecture/ai-sdk-positional-tool-pairing) — `MissingToolResultsError` comes from the SDK's `convertToLanguageModelPrompt` and its rule is POSITIONAL; a dying run can wedge a thread permanently. Two plausible causes are verified FALSE.
- [The health endpoint IS the recovery mechanism](mem://ops/health-endpoint-is-the-recovery-mechanism) — do NOT gate the `?health=1` recovery sweep behind the probe secret; pg_cron calls it with no secret on purpose. Throttle instead.
- [Sandbox traps that cost time](mem://ops/sandbox-traps) — `deno test` rewrites deno.lock and drops real deps; tsc also typechecks the Deno sources; a test that passes before AND after your fix proves nothing
- [Execution workflow 2026-08-25](mem://process/execution-workflow-2026-08-25) — JD's ordered Part A (#501/#468/#503 → #502 → triage) / Part B (B1-B7) plan, the rules every step inherits, and the do-not list; A1 DONE, A2 (#502) reviewed but STILL UNMERGED, A3 partly done, Part B not started. As of 2026-08-28 `main` = `28acddd`, live build `b234550`
- [Tool telemetry: operational patterns](mem://ops/tool-telemetry-operational-patterns) — 681 doomed calls / 48.6s dead wall-clock per thread sit unread in `tool_usage_log`; skips log with `ok=true` so naive queries miss them; the finalize window is a SYMPTOM of timeout ceilings below provider latency
- [Production run defects 2026-08-26](mem://ops/production-run-defects-2026-08-26) — six defects measured off two live runs; **1-3 (phone, address, dedup) FIXED and DEPLOYED at `b234550` via #508**; 4 (SSN in value), 5 (dispatch boundary) and 6 (client-side) remain open, each explicitly declined by JD in that pass
- [Decision log 2026-09-02: analyst decisions propagation](mem://process/decision-log-2026-09-02-analyst-decisions) — #534 merged `7cd74b5`: decisions are authority/priority/workflow state, NEVER evidence confidence (the +20/+25/−20 deltas are gone on both sides); cache stamp restored; model-dispatch rejection guard fails OPEN on a review-load error by design; `false_positive` is read-only legacy; #529 parked
- [Evidence workspace design direction](mem://style/evidence-workspace-design-direction) — theme is 99.4% tokenized but `.panel` is a hue-neutral white film so surface tokens barely paint; `--danger`/`--confidence-low`/`--authority-conflict` are the SAME value; chosen direction is "Dossier, alive" (editorial masthead on true black glass, animated)
