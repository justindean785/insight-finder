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
- [Address-seed google_dorks cross-layer mismatch](mem://architecture/address-seed-google-dork-cross-layer-mismatch) — a one-tool-kind bug was really 5 layers disagreeing (client seed detector, server seed regex, catalog description, runtime schema, cache trusting unvalidated `kind`); the durable fix pattern is validating a caller's type claim against the value itself, not just adding the missing enum member
