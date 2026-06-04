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
