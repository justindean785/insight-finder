# Report-truth pass — harness evidence (2026-09-02)

Both exports come from the SAME synthetic harness fixture (`src/dev/supabase-mock.ts`,
thread `11111111-2222-4333-8444-555555555555`) rendered through `buildReportMarkdown`:
`harness-export-before.md` on `main` (`3b6fc44`) with the fixture patched in, and
`harness-export-after.md` on this branch. `diff` them.

Browser print of the Report tab (Chromium `page.pdf()` after dispatching `beforeprint`,
the same sequence Ctrl+P runs): **before 1 page, after 8 pages** on the same fixture.

No real-person values appear in either file.
