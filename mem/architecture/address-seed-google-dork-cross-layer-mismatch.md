---
name: The address-seed google_dorks routing defect was a cross-layer type mismatch
description: catalog.ts advertised one input shape, the live google_dorks schema accepted a different one, cache.ts trusted the model-supplied kind unchecked — an address seed fell through every layer and got dispatched as kind:"domain", producing site:<postal address> queries
type: architecture
---
**The finding.** A single-seed-kind bug (`google_dorks` had no `address` case) was the
visible symptom. The root cause was a **contract that disagreed at every layer it
crossed**, and nothing enforced agreement between them:

1. `src/lib/seed.ts` had no `address` `SeedKind` at all, despite its own comment saying
   it "must mirror server detection."
2. `supabase/functions/osint-agent/validation.ts`'s server-side address regex required a
   single line and whitespace (not a comma) before the ZIP — so a pasted two-line address
   (`79 WAVERLY AVE\nCINCINNATI OH, 45215`) classified as `other`, not `address`.
3. `query-type-router.ts` and `playbooks.ts` already both understood `address` as a query
   type and required `google_dorks` for it — but the tool's own runtime schema
   (`z.enum([...])` in `tool-registry.ts`) had no `"address"` member.
4. `catalog.ts` advertised `google_dorks` as `{ target, kind? }`; the runtime actually
   required `{ seed, kind }` — a second, independent drift between what the planner was
   told and what the tool enforced.
5. `cache.ts`'s `detectSelectorType()` trusted `input.kind` verbatim with no validation —
   so a model that (forced by the above) sent `kind:"domain"` for a street address had
   that lie recorded as ground truth in telemetry (`_runtime.selector_type: "domain"`).

None of these five was individually surprising in isolation, but stacked together they
made an address-shaped seed **structurally unable to travel through the system as what
it actually was**. The model didn't misuse `google_dorks` — the address playbook forced
a call the schema couldn't represent, so the planner picked the nearest enum member
(`domain`) that would compile, and the domain family blindly interpolated the raw
address into `site:`, `site:*.`, certificate and secret-exposure templates.

**The fix pattern, for the next time this shape shows up:** don't patch the symptom (add
one enum value) without also checking (a) whether the client-side mirror agrees, (b) the
catalog description agrees with the runtime schema, and (c) whether the caller-supplied
`kind` is ever trusted downstream without being re-validated against the actual value.
`supabase/functions/osint-agent/dork-queries.ts`'s `resolveDorkKind()` — reject
`kind:"domain"` unless the seed passes `isHostname()`, else re-route to the address
family or refuse with a legible `error:"kind_mismatch"` (never a silent `ok:true` empty
result) — is the general shape: **validate the caller's claim about a value's type
against the value itself, at the point where that claim selects a template.**

**Where the shared logic lives now** (PR fixing #79-Waverly-Ave / Cincinnati-addy):
- `supabase/functions/osint-agent/address.ts` — `looksLikePostalAddress` (strict, seed-kind
  detection) / `looksLikeStreetAddress` (loose, kind-guard use) / `normalizeAddressValue`
  (cache key) / `parseUsAddress`. Client mirror duplicated in `src/lib/seed.ts` (no shared
  module between `src/` and `supabase/functions/` — same constraint as
  `formatThreadTitle`).
- `supabase/functions/osint-agent/dork-queries.ts` — `resolveDorkKind` (the untrusted-kind
  guard), `buildAddressDorks` (the address query family), `searchUrl`/`canonicalizeDorks`
  (one encoder for every dork URL, so the displayed query and the clickable URL can never
  diverge — they had, table-wide, before this).
- Regression cover: `supabase/functions/osint-agent/dork_address_test.ts` (edge, drives
  the real `buildTools()` output) and `src/test/seed-address.test.ts` (client, plus a
  parity check that `normalizeAddressValue`/`US_POSTAL_RE` stay textually identical
  between the two copies).

**Deliberately NOT touched, even though the same contract-mismatch shape recurs there:**
`gemini_deep_dork`'s kind enum also lacks `"address"` despite the address playbook
requiring it, and `jina_reader_scrape`/`oathnet_lookup` are listed as unconditional
`required` steps for a raw-address seed despite needing a derived URL/name/email first.
Fixing those is the same class of bug but a materially larger change (playbook
structure, not one tool's schema) — tracked as a follow-up, not folded into this fix.
