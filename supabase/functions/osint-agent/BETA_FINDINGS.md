# osint-agent — beta-readiness findings (advisory)

Companion to PR #95. PR #95 ships only the two additive test files; **this note
changes no code**. It records what a backend-lane review surfaced that is either
(a) a user/config action, (b) cross-lane and needs session-1 coordination, or
(c) evidence-integrity and therefore sign-off-gated. Source citations are against
`supabase/functions/osint-agent/` on `chore/osint-agent-beta-hardening`.

Triggered by a live investigation (`broneradrian96@yahoo.com`, 2026-06-20) whose
evidence board showed ~9 tools "failed" and an empty Identity coverage row.

---

## A. Tool "failed" flood — root cause is config + upstream, not a code bug

Every failing tool was traced. None can throw unhandled; all wrap fetch+parse in
try/catch and return a structured `{ error }` / `{ ok:false }` / `{ skipped:true }`.

**Status derivation** (`cache.ts:208-215`, `deriveOk`): a result is "not ok"
(→ red "failed" in the timeline) if it has a non-empty `error`, `ok:false`, **or**
`skipped:true`. `isFreeCall` (`cache.ts:219-230`) separately detects
`"not configured"` / `"disabled"` / `"degraded"` / `skipped` so these are **not
billed** — but the timeline has no third state, so a missing key looks identical
to a provider 500.

| Tool(s) | Verified cause | Action |
| --- | --- | --- |
| `synapsint_lookup` (tool-registry.ts:671), `ipqualityscore_lookup` (1508), `intelbase_email_lookup` (500-509) | Key-gated; returned `"…_API_KEY not configured"`. Keys likely **unset in deployed Supabase secrets**. | **Config**: set secrets |
| `stolentax_footprint` (955-996) | Same `STOLENTAX_API_KEY` as `breach_check` (813+), which **succeeded** → key is set. 25s timeout / per-endpoint quota on `osintcat-footprint`. | Upstream/tuning |
| `deepfind_reverse_email` (1085), `deepfind_email_breach` (1373) | Shared `DEEPFIND_API_KEY`; `deepfind_email_breach` completed once → key is set. Rate-limit / provider-grouped circuit (`circuit.ts:43-58`): one 5xx suppresses the deepfind family. | Expected (circuit) |
| `emailrep` (2665), `gravatar_profile` (2679) | **Keyless.** Upstream/network; gravatar "fail" is often a 404 (no avatar), not an error. | Upstream / cosmetic |
| `jina_reader_scrape` (some) | Per-URL 403/422/451 (blocked/unparseable). | Expected |

**User config action (cannot be verified from the repo — deployed secrets live in
Supabase function settings):** confirm/set `SYNAPSINT_API_KEY`,
`IPQUALITYSCORE_API_KEY`, `INTELBASE_API_KEY` (+ `INTELBASE_ENABLED`). The Identity
coverage gap on this run traces directly to `emailrep`/`gravatar`/`intelbase` not
returning — not a logic flaw.

**Deliberately not changed:** normalizing the ~30 `"not configured"` returns to a
structured `{skipped:true, reason}` (only HIBP at `1048` does this today) was
considered and rejected — `deriveOk` already collapses `skipped:true` to "failed",
so it is pure churn in the sensitive runtime file with zero behavior change.

---

## B. Status taxonomy — distinct "skipped/unavailable" state (CROSS-LANE)

The real fix for A's noise is a third call state so missing-key/no-result skips
stop masquerading as failures (which also buries genuine failures and makes the
board look alarming).

- **Backend (this lane):** surface a clean signal — detection is already
  centralized in `isFreeCall` (`cache.ts:219-230`). Low-risk, additive.
- **Frontend (session-1 lane — DO NOT TOUCH here):** render "skipped — no key" /
  "no result" distinctly from red "failed".

Needs coordination with the frontend session before implementing. Flagged, not done.

---

## C. Evidence-integrity observations (SIGN-OFF-GATED — flagged, not changed)

Per the integrity rules, these are surfaced for review only.

1. **Confidence vs corroboration inconsistency.** The same email appeared as a
   single-source `breach` artifact at `INFERRED / 60` and, separately, as an
   `email` artifact corroborated by 5 source classes at `CORRELATED / 50`. These
   may be distinct claims by design, but the coverage summary rated the **single**
   stolen.tax row "1 high-confidence / 0 need verification" while the **5-source**
   email was "need verification." Worth confirming `deriveStatus` /
   `applyEvidenceCaps` intent (`confidence.ts`).

2. **Same-name collision not flagged.** "Adrian Broner" (handle is
   broner+adrian+96; almost certainly the boxer *Adrien Broner* via web search)
   landed as `weak_lead / LOW / 20`, but the report's Collision section said
   "No collisions flagged." The low score came from being a weak web-search lead,
   not from collision detection — i.e. `isUnrelatedEntity` / collision-policy
   appears to have missed a textbook famous-name collision.

3. **Existence-check elevating a weak lead.** `zippyinsurance.net` arrived as a
   weak snusbase-footprint association (20) yet `whois_lookup` promoted it to
   `domain / 55`. Whois confirms the domain is *registered*, not that it is linked
   to the subject — an existence check elevating linkage confidence.

---

## What PR #95 itself contains (no overlap with the above)

- `catalog_contract_test.ts` — enforces TOOL_CATALOG ↔ buildTools() stay 1:1 (81↔81).
- `fetch_timeout_test.ts` — proves `fetchT` / `fetchRetry` abort at their timeout.
- Gates: `deno test` 205/0 (was 198); `deno check index.ts` 39 errors / 0 TS2304.
