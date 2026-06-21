# osint-agent — beta-readiness findings (advisory)

Companion to PR #95. PR #95 ships only the two additive test files; **this note
changes no code**. It records what a backend-lane review surfaced that is either
(a) a user/config action, (b) cross-lane and needs session-1 coordination, or
(c) evidence-integrity and therefore sign-off-gated. Source citations are against
`supabase/functions/osint-agent/` on `chore/osint-agent-beta-hardening`.

Triggered by a live investigation (`broneradrian96@yahoo.com`, 2026-06-20) whose
evidence board showed ~9 tools "failed" and an empty Identity coverage row.

---

## A. Tool "failed" flood — upstream/provider + gating, not missing keys, not a code bug

Every failing tool was traced. None can throw unhandled; all wrap fetch+parse in
try/catch and return a structured `{ error }` / `{ ok:false }` / `{ skipped:true }`.

**Status derivation** (`cache.ts:208-215`, `deriveOk`): a result is "not ok"
(→ red "failed" in the timeline) if it has a non-empty `error`, `ok:false`, **or**
`skipped:true`. `isFreeCall` (`cache.ts:219-230`) separately detects
`"not configured"` / `"disabled"` / `"degraded"` / `skipped` so these are **not
billed** — but the timeline has no third state, so a missing key looks identical
to a provider 500.

**CORRECTION (2026-06-20, after reviewing the Supabase Secrets dashboard):** an
earlier draft of this note guessed `SYNAPSINT_API_KEY` / `IPQUALITYSCORE_API_KEY` /
`INTELBASE_API_KEY` were unset. **They are all present** (along with
`STOLENTAX_API_KEY`, `DEEPFIND_API_KEY`, etc.). So the "failed" flood is **not** a
missing-key problem. With keys confirmed set, the causes are upstream/provider-side
and gating, per the table below.

| Tool(s) | Verified cause (keys confirmed SET) | Action |
| --- | --- | --- |
| `synapsint_lookup` (tool-registry.ts:671), `ipqualityscore_lookup` (1508) | Key present → guard passes → real call failed upstream (5xx/quota/timeout). synapsint marks `isDegraded()` on 5xx (681); ipqs has a tight SMTP+fetch timeout window (~1517). | Upstream/quota |
| `intelbase_email_lookup` (500-509) | `INTELBASE_API_KEY` is set but **`INTELBASE_ENABLED` is absent** from secrets → tool stays gated and returns a structured skip. Working as designed (intelbase is the known ~33%-success tool). | Config *if* you want it on: add `INTELBASE_ENABLED` |
| `stolentax_footprint` (955-996) | `STOLENTAX_API_KEY` set (and `breach_check` succeeded). 25s timeout / per-endpoint quota on `osintcat-footprint`. | Upstream/tuning |
| `deepfind_reverse_email` (1085), `deepfind_email_breach` (1373) | `DEEPFIND_API_KEY` set; `deepfind_email_breach` completed once. Rate-limit / provider-grouped circuit (`circuit.ts:43-58`): one 5xx suppresses the deepfind family. | Expected (circuit) |
| `emailrep` (2665), `gravatar_profile` (2679) | **Keyless.** Upstream/network; gravatar "fail" is often a 404 (no avatar), not an error. | Upstream / cosmetic |
| `jina_reader_scrape` (some) | Per-URL 403/422/451 (blocked/unparseable). | Expected |

**Config hygiene (from the dashboard):** `IPGEOLOCATION_API_KEY`,
`VIRUSTOTAL_API_KEY`, `LEAKCHECK_API_KEY`, `STOLENTAX_API_KEY`, `INTELBASE_API_KEY`
each appear to have **duplicate entries** (all dated May 27). Confirm and de-dup —
duplicate secret names can resolve ambiguously.

**To pin the exact per-tool error** (vs. these structured inferences), read the
redacted `error_msg` for that run from the `tool_usage_log` table (the wrapper logs
every call there — `cache.ts:637`). That is the ground truth; the table above is
inferred from code paths since the keys are now known to be set.

The Identity coverage gap on this run traces to `emailrep`/`gravatar`/`intelbase`
not returning — upstream blips + intelbase being gated — **not a logic flaw.**

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
