# PR CI does not run the e2e suite — run it by hand

**Measured 2026-09-12.** Two things were wrong at once, and the second hid the first.

1. **CLAUDE.md claimed `npm run test:e2e` did not exist.** It does — `playwright test`,
   **54 specs** across `e2e/workspace-tabs.spec.ts` and `e2e/case-integrity.spec.ts`,
   driving the harness build. Baseline **52 passed / 2 skipped**.
2. **The `e2e` job in `ci.yml` is `if: github.event_name == 'push'`** — a deliberate
   cost call after #483 drained the Actions allowance — so it guards pushes to `main`
   **only**. The workflow header states the trade plainly: *a PR can go green and merge
   while breaking the tab-reachability contract, and the failure surfaces on main AFTER
   the merge — a revert, not a block.*

## This bit, on real work

A change that passed **vitest, typecheck, lint, build AND the full edge suite** still
broke `case-integrity.spec.ts → next steps › 9`. Every instrument PR CI runs was green.
The only thing that caught it was running e2e by hand.

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

Chromium is **pinned** in the web sandbox and must not be re-downloaded — pass the env
var above rather than letting Playwright fetch its own.

## The rule

**Run e2e by hand before merging anything that touches `src/`.** A docs-only PR does
not need it. Do not read a green PR check set as covering the workspace tab contract;
it does not.

## What it actually caught, and why that matters beyond the test

The failing change dropped malformed report lines at the producer, which reversed a
documented decision recorded in `src/lib/pivot-schema.ts`: *"An invalid suggestion is
not deleted — it stays visible as 'Suggestion needs repair'."* That is the same
**disclosure-not-deletion** rule CLAUDE.md makes inviolable for quarantined artifacts.
The e2e suite is where that product rule is pinned; the unit suites do not express it.
The change was backed out and the underlying product question written up instead
(`docs/next-steps-repair-cards.md`).
