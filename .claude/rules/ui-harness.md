---
paths:
  - "src/**"
  - "e2e/**"
  - "vite.harness.config.ts"
---

<!-- Loads when editing frontend or e2e files. Moved verbatim from CLAUDE.md lines 122-151 on 2026-11-10. -->

## Seeing the UI before you ship it — the harness

> A Vercel **preview** deployment is not the site. Only `target: production` on `main` is.

Two failure modes have repeatedly shipped UI work that changed nothing an analyst sees:

1. **Draft PRs never merge.** A preview deploy reports `READY` with a green check and looks
   exactly like a successful deploy — but it is `target: null`. Production only moves when a
   PR merges to `main`. Check `target`, not the checkmark.
2. **Reviewing only the signed-out surfaces.** Landing and `/auth` are easy to render, so
   passes concentrate there — while the signed-in workspace, where analysts actually live,
   goes untouched and the change reads as "looks the exact same."

To render the **signed-in workspace** with no prod credentials and no network:

```bash
npx vite --config vite.harness.config.ts        # → http://127.0.0.1:5174
# open /chat/11111111-2222-4333-8444-555555555555
```

`vite.harness.config.ts` aliases `@/integrations/supabase/client` to
`src/dev/supabase-mock.ts` — a chainable PostgREST stub plus fixtures for a realistic
finished case (8 artifacts spanning verified → capped → broker-only, 9 tool calls including
2 failures, a report-shaped final message). Every tab renders: Investigate, Evidence, Tools,
Graph, Report.

Nothing under `src/` imports the stub and the production config is untouched, so it cannot
reach a real build — `npm run build && grep -r harness.local dist/` returns nothing. Screenshot
the workspace before/after any UI change and put the images in the PR.
