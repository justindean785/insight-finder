# Production run defects — measured 2026-08-26

> **Sanitised.** This run is a real investigation of a private individual. Every
> selector below — name, SSN, address, phone, the collision row's name — has been
> replaced with a synthetic stand-in (`Jordan Vale`, `917-555-0123`, `1110 Sample
> Ave`, the reserved 555-01XX range). The *shapes* are preserved exactly, because
> the shapes are the findings; the values are not real and must not be looked up.
> CLAUDE.md's rule stands: `src/dev/fixtures.json` and `src/dev/raw/` are
> gitignored — sanitise before checking anything in.

Source: two live runs pasted by JD (`insight-finder-sandy.vercel.app`), seed
`"Jordan Vale, age 31"` → pivot to `+19175550123` → `1110 Sample Ave`.
Raw artifact JSON, the exported report, the browser console and the Network tab.

> ## STATUS — updated 2026-08-28
>
> | # | Defect | Status |
> |---|---|---|
> | 1 | Phone normalisation mints a selector from an excluded row | **FIXED + DEPLOYED** — #508, live build `b234550` |
> | 2 | Raw breach fields concatenated into the value | **FIXED + DEPLOYED** — #508, live build `b234550` |
> | 3 | The same fact recorded 3–5 times | **FIXED + DEPLOYED** — #508, live build `b234550` |
> | 4 | Full SSN composed into an artifact VALUE | **OPEN** — JD explicitly declined it in this pass |
> | 5 | Dispatch boundary | **OPEN** — CLAUDE.md's standing P1; JD explicitly declined it |
> | 6 | Client-side (CSP, load-time 401, 3× health probes) | **OPEN** — all three declined |
>
> What #508 shipped for 1–3: E.164 canonicalisation at write time in **both** writers
> (`normalizeFinding` and `validateArtifact`), so one number is one artifact while a `+7`
> number sharing ten digits stays distinct; `composeAddress` instead of a raw field join; a
> `CO_TENANT_CTX` quarantine stamp on a breach row that positively disagrees with the queried
> phone (phone only, deliberately); and thread-wide dedup in `record_artifacts` and the
> singular `record_artifact` shim through one shared `artifactDedupKey`. **No migration and no
> backfill** — forward-only, so every row written before `b234550` still shows the old shapes.
> Disagreeing values (670/676/28) stay separate rows by construction: the whole unparsed value
> is in the key.
>
> Items 4–6 are unchanged and the text below still describes them accurately.

**Items 1–3 are fixed as of 2026-08-28; 4–6 are not.** The frontend consequences were fixed
in #507; the causes of 1–3 in #508. What follows is the original 2026-08-26 measurement,
kept verbatim because the shapes are the evidence.

---

## 1 · Phone normalisation mints a selector from a row already excluded

One phone became four artifacts:

    +19175550123   seed
    19175550123    clus_45d02dea
    9175550123     clus_45d02dea
    79175550123    clus_65fc6d70   ← Russian +7 prefix

`79175550123` derives from the `zoloto585.ru` breach row that the *same artifact
set* labels `"Anna Ivanova, Kazan Russia — COLLISION, unrelated"`. The
normaliser built a selector out of an explicitly excluded row and gave it its
own cluster id.

Shape to keep in mind: **exclusion at the read layer does not stop the
normaliser at the write layer.** Same family as the dispatch boundary.

## 2 · Raw breach fields concatenated into the rendered value

    1110 SAMPLE AVE3F 1110 SAMPLE AVE APT 3F ANYTOWN NY 10001

`address_street` + `address_street2` joined with no separator, then repeated.
This is the artifact's `value`, so it renders on the board and in the report.

## 3 · The same fact recorded 3–5 times with disagreeing numbers

One building, one session:

| stat | values recorded |
|---|---|
| `violations_total` | 670 / 676 / 28 |
| open violations | 34 / 30 |
| eviction filings | 117 / 118 |

`Example Holdings 1110 LLC` = 3 `organization` artifacts (55/75/75). `Sam Whitfield` = 3
`source_person` artifacts. The address = 4+. **An Evidence count of 88 is
inflated by near-duplicates differing only in phrasing** — which also means the
count is not a count of distinct facts.

## 4 · ⚠️ Full SSN in an artifact VALUE

    SSN <9-digit SSN> — AT&T breach: JORDAN VALE, 1110 Sample Ave Apt 3F,
    Anytown NY 10001, phone 9175550123

`sensitive: true` sits in metadata, but the **value string** carries SSN + full
address + phone together, and the value is what renders and exports. Related:
`REVEAL_BREACH_DATA` is deliberately ON (settled, see CLAUDE.md) — but that
decision was about *breach field display*, not about composing an SSN, address
and phone into a single display string.

## 5 · Dispatch boundary, observed live

CLAUDE.md's open P1, in production. The seed contains spaces, which
`breach_check` and `serus_darkweb_scan` structurally cannot accept — knowable
before the call. Both were called; **serus twice with the identical rejected
input** (422 each time).

Run totals: **11 of 21 tool calls failed (52%)**.

- `jina_reader_scrape` 7 calls, 4 failed
- `gemini_deep_dork` 2 calls, 2 failed
- `serus_darkweb_scan` 2 calls, 2 failed — same input
- `minimax_correlate` **failed** → no clusters → the report's contradictory
  corroboration sections (fixed in #507) → run ended INTERRUPTED

This is the same shape as the 2026-08-25 telemetry sweep (681 doomed calls, 417
at their own timeout ceiling, 48.6s dead wall-clock per thread).

## 6 · Client-side, from the console and Network tab

- **CSP blocks `vercel.live/_next-live/feedback/feedback.js`**, twice per load.
  Either allow `https://vercel.live` in `script-src` or disable the Vercel
  Toolbar for production. ⚠️ **PR #502 edits that same CSP line.**
- **401 on load**: `threads?select=id&user_id=eq.<uid>` fires before session
  hydration, self-recovers. **Matches no threads query in `src/`** — needs a
  trace, not a grep.
- **Three `?health=1` probes per page load**, 1.3–1.6s each, one on `onKeyDown`
  — every scan pays ~1.5s before it starts. Both sites are guarded and
  commented as deliberate; changing them means touching the finalize/recovery
  machinery.

---

## Method note

All of this came from JD pasting real runs. The fixture harness and the token
audit each missed every item here — the fixture because it is a clean
single-cycle case, the audit because it read code rather than output.
