# Insight Finder / Swarmbot — Session Handoff (2026-06-06)

**Audience:** me tomorrow (or any collaborator picking this up cold).
**Repo:** `~/Downloads/Archives/Insight Finder` · remote `github.com/justindean785/insight-finder` (branch `main`)
**Last commit:** `80a9d1e` (pushed; `main` == `origin/main`).

---

## ⛔ READ THIS FIRST — the deploy pipeline (cost me hours today)

**The user does NOT look at `localhost:8080`. They look at the deployed Lovable preview:
`preview--seeker-sp…lovable.app`** (note the Lovable project slug is **"seeker-sp…"**, even though the GitHub repo is **"insight-finder"** — same project, different name; "Edit with Lovable" badge confirms it).

Consequences — burn these in:
1. **Local dev-server edits (`npm run dev`, :8080) are INVISIBLE to the user.** Editing files and telling them to refresh localhost does nothing for them.
2. **The only way changes reach their screen: commit → `git push origin main` → Lovable auto-rebuilds the preview → user HARD-refreshes (`Cmd+Shift+R`).** Build takes ~1–2 min.
3. So the loop is: **edit → push main → wait for Lovable build → user hard-refreshes.** Don't bother with the local dev server for "does the user see it" — only for your own quick sanity checks.
4. `main` auto-deploys on push (Lovable git-sync, per memory). There is no `supabase functions deploy` / manual build step.

**Today's "I see 0 changes" disaster was a stack of three things, now all known:** (a) user on Lovable preview not localhost; (b) a stale local dev server + a transient syntax error that wedged Vite serving last-good; (c) my changes were too subtle anyway. (a) was the real killer.

Also: the codebase got a structural refactor at some point (now a `src/components/panel/` subdir for the tab components; groups are `IDENTITY/CONTACT/SOCIAL/INFRASTRUCTURE/...` via `GROUP_LABEL` in `src/lib/intel.ts`). Local `main` == `origin/main`, so local IS the deploy source — no divergence currently.

---

## What shipped today (all on `main`, deployed)

### A. Scan-engine hardening (commits up to `6c10a89`) — DONE
Driven by two live scan exports (taciocero@icloud.com email, doxbin.net domain):
- **bosint_phone_lookup**: 60s worst-case (25s + 10s backoff + 25s retry) → **single 25s attempt**. Was stalling scans a full minute.
- **hibp_lookup**: gated out of `list_tools` catalog + planner menu when `HIBP_API_KEY` unset (was failing on every email seed). Auto-re-enables if key added.
- **No silent failures**: `cache.ts extractToolError` now always derives a reason (skip / `HTTP <status>` / "no usable result") — kills reasonless red "failed" rows.
- **Planner stops re-proposing dead tools**: filters circuit-breaker-disabled (`circuit.snapshot().disabledReason`) + `isDegraded()` tools (synapsint was firing 7× after the breaker killed it).
- **Dead-host gate** (`env.ts` `deadHosts`/`markHostDead`/`isHostDead`): a NXDOMAIN seed (e.g. seized doxbin.net) marks the host dead once (`dns_records` Status 3, or `http_fingerprint` DNS error); the 4 live-host tools (http_fingerprint, jina_reader_scrape, deepfind_ssl_inspect, deepfind_tech_stack) then skip it instead of each re-failing. Exact host match (no www-fold).

### B. UI refactor — IN PROGRESS (commits `fe79539` … `80a9d1e`)
**Direction pivoted mid-session.** Started "Palantir/Gotham austere terminal"; user course-corrected to **"premium glass investigation tool — simplistic, clean, glassy, pops, NOT austere."** Current committed direction:

- **Accent: violet** `258 89% 67%` (was cyan `191 100%`). Applied app-wide via tokens (primary/accent/ring/sidebar/brain-cyan) + a violet ambient wash (`body::before`). **One-line global swap** if they want another color (e.g. amber) — just change `--primary` et al. in `src/index.css`.
- **Font: Sora** (display + UI) replacing Cinzel serif; **JetBrains Mono** kept for data/evidence. Loaded in `index.html`, wired in `tailwind.config.ts` (`sans`/`display`/`condensed` → Sora). Two-font system.
- **Glassier**: `.glass` in `index.css` — panels more translucent (bg ~.58 vs .85), blur 18→24px, faint violet edge-highlight.
- **Token reset (Phase 1)**: `--radius` 0.75rem → **0.3rem** (sharper); `--border-subtle` 10%→15% L (dividers now actually visible); `--muted-foreground` +5pt L (WCAG-AA); softened `.text-glow`/`.terminal-glow`/`.text-confidence-glow`.
- **ChatWindow report surface**: code/data blocks wrap (not clip) + terminal "OUTPUT" panel header; markdown tables → mono data-panels; tool calls split **skipped (neutral gray + reason chip) vs failed (red)**; the row `<button>`-nesting-`<button>` DOM bug fixed (now `role=button` div).
- **ResourcesPanel evidence rows**: framed table container, zebra stripes, bordered **KIND** chip per row.
- **ThreadHeader**: rebuilt as a hairline-divided **instrument readout** (value-over-label stat cells `ART/TOOLS/BREACH/FAIL/CR/CHAIN`), glow/pulse removed.

---

## Next session — UI refactor remaining (Phase 2+)
Same language (violet glass, Sora, clean+pops). Each phase = one push the user sees deployed.

1. **Report surface → document-grade case file** (ChatWindow center). Currently markdown; make it read like a forensic case document.
2. **Evidence panel polish** (ResourcesPanel / `src/components/panel/*`) — glass data table, violet confidence system, clean group headers.
3. **Sidebar → premium case ledger** (`ThreadSidebar.tsx`) — the case list (doxbin.net, tsun2485@…, Tiki Ghosn) as a dense, scannable ledger.
4. **Showcase: entity link-analysis graph** in the Matrix/Clusters tab (`panel/EvidenceMatrixTab.tsx` / `ClustersTab.tsx`) — the single biggest "serious OSINT tool" visual.

**Before building more: get the user's read on the violet+Sora+glass direction once they see `80a9d1e` deployed.** If they dislike the color/font, re-skin globally (one push) before investing in structural work.

---

## Verify / gotchas
- **Verify a UI change reached the user**: it's on `origin/main` + Lovable build finished + user did `Cmd+Shift+R` on the **preview** URL. Local build/eslint passing ≠ user sees it.
- Standard checks still apply: `npm run build` (Vite, ~2s), `npx eslint <files>`, `npm run test:edge` (Deno, 73/73), `npx vitest run` (167/167). `deno check index.ts` baseline = 39 pre-existing (ai@6 zod→tool inference), out of scope.
- `deadHosts`/`degradedTools` are module-scoped, cleared per-request at the top of the Deno handler (`index.ts` ~line 209) — consistent with existing pattern (assumes serial-per-isolate).
- The local dev server may have stale/zombie processes — if you use it, `pkill -f vite; lsof -ti:8080 | xargs kill -9` then restart, and **hard-refresh**. But remember it's not what the user sees.

---

## Resume prompt for tomorrow
> Continue the Insight Finder UI refactor (premium glass investigation, violet `258 89% 67%` + Sora + glassy, clean+pops). Direction shipped in `80a9d1e`. REMEMBER: user views the Lovable preview `preview--seeker-sp…lovable.app`, NOT localhost — changes only land via `git push origin main` → Lovable rebuild → user hard-refreshes. First, confirm the user's read on the violet/Sora/glass direction; then Phase 2: report surface (document-grade), evidence panel, sidebar ledger, and the entity link-analysis graph. See SESSION_HANDOFF_2026-06-06.md.
