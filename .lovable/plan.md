## Ranked by impact — do #1 and #2, defer the rest

### #1 — Frontend status taxonomy: stop rendering "skipped/expected" as red "failed" ⭐ BIGGEST WIN

**Why this dwarfs everything else:** 5 of the 8 "failing" tools in your screenshot are not actually broken:
- `jina_reader_scrape` HTTP 451 → the URL is legally blocked. Working as designed.
- `stolentax_footprint` HTTP 401 → provider rejected the key. Not a code bug, and the run correctly moved on.
- `socialfetch_lookup` / `leakcheck_lookup` HTTP 400 → provider says selector shape wrong. Deterministic dead-end, correctly stopped.
- `serus_darkweb_scan` timeout → known slow provider, run continued.

The backend **already classifies these correctly** (`isFreeCall` in `cache.ts:219`, `classifyToolOutcome`). But `ChatWindow.tsx` + Health tab collapse everything non-green into red "FAILED (8) — NEED ATTENTION."

That red banner is what makes the app *feel* broken to a beta user even when the investigation succeeded. Fixing it changes nothing about the investigation quality — it changes the entire perception of reliability.

**Change:** Add a third chip state in the frontend Health tab and Activity timeline:
- 🟢 **succeeded** — 2xx with useful payload
- ⚪ **skipped** — 401/403/451/429, deterministic 400 with "not configured"/"blocked"/"rate-limited", `{skipped:true}` — grey, collapsed under an "Expected skips (N)" accordion
- 🔴 **failed** — genuine 5xx, unhandled timeout on a Tier-A tool, `{error}` without a known reason — the only thing that stays red and prominent

Files: `src/components/panel/AuditTab.tsx` (Health tab), `src/lib/tool-run.ts` (add `deriveDisplayState`), `src/components/ChatWindow.tsx` (timeline chip color).

Backend is untouched. ~200 LOC.

---

### #2 — Ship the mirror's build to the mirror ⭐ FREE WIN

The screenshots are from `insight-finder-sandy.vercel.app`, which is a *different Vercel-hosted project* but presumably runs the same osint-agent code. Its Health tab shows `gemini_deep_dork exceeded 30000ms` — that's the pre-PR#46 30s cap. **This project (`skzqwbyvmwqarfgfvyky`) already runs the 12s-capped build after last turn's redeploy.** So the mirror is behind.

If you want the mirror app fixed, sync its build the same way (bump its `build-info.ts`, redeploy). Zero code changes; I can do it in one turn if the mirror is in the same repo — but I'd need to confirm which Supabase project ref the mirror uses. **Ask the user:** is `insight-finder-sandy` a separate Supabase project, or does it share this backend?

---

### #3 — Rotate `STOLENTAX_API_KEY` (user action, 30 seconds)

Only genuine actionable failure in the screenshots. Backend → Secrets → update. No code change.

---

### #4 — Small planner input-shape guard (nice-to-have, ~30 LOC)

The `socialfetch_lookup` / `leakcheck_lookup` HTTP 400s trace to the LLM sending an email where a username is expected (or vice versa). The tools already return `{error}`, but the planner keeps making the same mistake for the rest of the run because there's no learned suppression.

Add a per-tool-per-selector-shape suppression in `circuit.ts`: after 2 400s on `socialfetch_lookup{selector_type:email}`, suppress that combo for the run. The tool stays live for username selectors. Prevents wasted retries without touching evidence logic.

---

### What NOT to do (would look productive but wouldn't move the needle)

- **Raising timeouts** on `gemini_deep_dork` / `deepfind_reverse_email` / `minimax_extract` — these providers are genuinely slow; longer timeouts just push more runs past the 6-min wall clock. The current caps are correct.
- **Dropping tools from the planner** — the readiness gate already handles keyless/disabled tools; removing more shrinks coverage. Only cull if a tool has *never* returned useful data in `tool_usage_log`.
- **Chasing the frontend "48 artifact" count discrepancy** — that's a rendering polish item, not a beta blocker.

---

## Files (only if you approve #1)

- `src/lib/tool-run.ts` — add `deriveDisplayState()` returning `"success" | "skipped" | "failed"`, keyed off status code + error string patterns already used in `cache.ts:isFreeCall`.
- `src/components/panel/AuditTab.tsx` — split failing bucket into "Failed" and "Expected skips (collapsed)".
- `src/components/ChatWindow.tsx` — grey chip for skipped calls in timeline.
- One test file: `src/test/tool-run-display.test.ts` (already exists, extend it).

No backend, no migration, no secret changes.

## Non-goals

- No changes to evidence logic, confidence scoring, or the orchestrator.
- No changes to which tools are called or in what order.
- No raising of any timeouts.

---

**Bottom line:** #1 is the one that turns "beta looks broken" into "beta looks solid" without changing a single tool call. Everything else is polish.
