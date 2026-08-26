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
- [Deno tests in web sandbox](mem://ops/deno-tests-in-web-sandbox) — dl.deno.land is egress-blocked; install deno via `npm i deno` + set DENO_CERT to run edge tests locally
- [Report layer bypasses the integrity engine](mem://architecture/report-layer-bypasses-integrity-engine) — `record_finding` persists a correct independence-capped confidence, then the model retypes the Findings table in prose; a prompt rule is not enforcement
- [AI SDK positional tool pairing](mem://architecture/ai-sdk-positional-tool-pairing) — `MissingToolResultsError` comes from the SDK's `convertToLanguageModelPrompt` and its rule is POSITIONAL; a dying run can wedge a thread permanently. Two plausible causes are verified FALSE.
- [The health endpoint IS the recovery mechanism](mem://ops/health-endpoint-is-the-recovery-mechanism) — do NOT gate the `?health=1` recovery sweep behind the probe secret; pg_cron calls it with no secret on purpose. Throttle instead.
- [Sandbox traps that cost time](mem://ops/sandbox-traps) — `deno test` rewrites deno.lock and drops real deps; tsc also typechecks the Deno sources; a test that passes before AND after your fix proves nothing
- [Execution workflow 2026-08-25](mem://process/execution-workflow-2026-08-25) — JD's ordered Part A (#501/#468/#503 → #502 → triage) / Part B (B1-B7) plan, the rules every step inherits, and the do-not list; A1 DONE + A2 reviewed + edge deployed, `main` = `a38963c`, live build `865f49e`
- [Tool telemetry: operational patterns](mem://ops/tool-telemetry-operational-patterns) — 681 doomed calls / 48.6s dead wall-clock per thread sit unread in `tool_usage_log`; skips log with `ok=true` so naive queries miss them; the finalize window is a SYMPTOM of timeout ceilings below provider latency
