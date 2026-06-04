---
name: No PII/credential redaction in OSINT tool outputs
description: Never redact breach-investigation fields (passwords, hashes, salts, SSN, DOB, CC, CVV, OTP, MFA) from tool outputs — surfacing them is the product
type: preference
---
This is an OSINT/breach-investigation app. Tool outputs MUST pass through:
passwords, passwd, pwd, hash, salt, ssn, sin, dob/date_of_birth, cc/credit_card,
cvv, cvc, otp, mfa. Redacting them defeats the purpose.

Only redact OUR OWN service auth material in `sanitizeToolOutput` SENSITIVE_KEY_RE:
token, secret, api_key, access_key, private_key, cookie, session, authorization.

**Why:** Investigator needs raw breach data. Field-level redaction here destroys
evidence value. Access control is RLS (per-user thread ownership), not field stripping.

**How to apply:** When editing `supabase/functions/osint-agent/index.ts`
SENSITIVE_KEY_RE or any mirrored copy (e.g. security-test-lab), do NOT re-add
the breach-data keys. Same rule for `extractToolError` / `redactSecrets` —
those only strip Bearer/sk-/AIza patterns, not breach fields.
