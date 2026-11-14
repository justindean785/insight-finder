# Session hygiene — full text

Moved verbatim from CLAUDE.md lines 12-51 on 2026-11-10.

## 🧭 Session hygiene — stay in this session, or start a new one? (JD, 2026-10-19)

JD asked to be told when to start a fresh session and when to stay and keep compacting.
**Claude reports one line, unprompted, at three moments:** right after a compaction, when a
PR merges, and before starting a new stage or task. The format is
`Session check: STAY — <reason>` or `Session check: START FRESH — <reason>`. When the answer
is START FRESH, the line also names where the handoff was written and gives the opening prompt.

**Start a fresh session when any of these holds:**
- A stage or PR has merged and the next one is about to begin. One session per stage or PR is
  the default boundary.
- This session has already been compacted **twice**. Each summary drops detail, so a third pass
  works from a summary of a summary. Count the summaries; do not guess. In a remote session, run
  `grep -c '"isCompactSummary":true' ~/.claude/projects/*/*.jsonl`.
- The work changes channel: frontend, edge deploy and schema each have their own recipe and traps
  (see the deploy topology below).
- The session shows drift: it re-reads files it already read, re-derives settled facts, or
  contradicts one of its own earlier measurements.
- The container was reclaimed, or the branch was reset under the session.

**Stay, compacting if needed, when any of these holds:**
- There is uncommitted or unpushed work, or a verification run is in progress.
- The session owns an open PR that is red or still waiting on CI. PR subscriptions and
  `send_later` check-ins belong to the session that created them; a new session must
  re-subscribe and re-arm them.
- The next step depends on detail that exists only in this conversation. Write that detail down
  first (PR body, plan or handoff), then decide.

**Before starting fresh, check all of these:**
- Everything is committed and pushed.
- These are written into the newest `SESSION_HANDOFF_*.md` or the open PR's body:
  - open PRs and their CI state
  - active subscriptions and pending check-ins, with their trigger ids so the old ones can be cancelled
  - JD's standing decisions made in the session
  - the exact next step
- JD has been given the opening prompt to paste into the new session.

**Rule of thumb:** staying costs little until the second compaction. After that, a fresh session
with a good handoff is more accurate than a third summary.
