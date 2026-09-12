# Next

## TASK-002: Resolve the current report truth baseline
**Priority:** P0 | **Tags:** report, integrity, gate-0

Review PR #579 against the current live workspace and decide whether to merge it or explicitly supersede each overlapping change. Do not begin a second report/UI rewrite on an ambiguous baseline.

### Plan

- Run the documented authenticated workspace flow and inspect Report, Print, Evidence, Tools, and Graph against one case revision.
- Verify rejected, quarantined, and ineligible artifacts do not regain authority on any surface.
- Record which #579 changes remain correct, which are stale, and the selected disposition.
- Merge only after required review; otherwise close with a linked replacement task and retained evidence.

### Done when

- Main has one documented report/print truth contract and no untracked overlap with #579.
- A live screenshot or equivalent behavioral record supports the decision.

---

## TASK-024: Gate critical workspace e2e on pull requests
**Priority:** P0 | **Tags:** ci, e2e, stability, gate-0

Run the smallest critical workspace flow on relevant pull requests so timeline, quarantine, report, and case-revision regressions cannot pass every pre-merge gate.

### Plan

- Identify the path filters for workspace, evidence, report, and run-lifecycle changes.
- Add a pinned-browser PR job for the critical case-integrity slice.
- Preserve the full e2e suite on push or nightly execution.
- Upload failure artifacts and document local reproduction.

### Done when

- A deliberately broken case-integrity fixture fails the PR job.
- An unrelated docs-only change does not pay the full browser cost.

---

## TASK-010: Correct tool outcome taxonomy across adapters
**Priority:** P0 | **Tags:** tools, telemetry, integrity, gate-0

Separate usable, no-record, duplicate, intentional skip, block, malformed response, timeout, and upstream failure. Begin with issue #494 and audit every adapter with the same HTTP-200/malformed-body risk.

### Plan

- Define one typed outcome contract and compatibility mapping for historical rows.
- Add response-schema validation at every affected adapter boundary.
- Keep clean negatives separate from transport and parser failures.
- Update runtime health calculations and add contract fixtures for every outcome.

### Done when

- No malformed or unavailable response can be counted as a clean subject negative.
- Tool health and policy code consume the normalized outcome rather than raw `ok`.

---

## TASK-001: Establish the replay benchmark and product SLOs
**Priority:** P0 | **Tags:** benchmark, metrics, gate-0

Create a sanitized 20-case replay corpus and record the current product baseline before changing orchestration. Optimize for useful intelligence, not artifact volume.

### Plan

- Select representative email, username, person, domain, company, breach, collision, and degraded-provider cases.
- Freeze tool responses and expected authority/coverage outcomes without storing live PII.
- Measure time to first accepted finding, completion, validated precision, review burden, calls, cost, context size, duplicates, and report consistency.
- Run one controlled live person investigation under the promotion-quarantine build to validate replay assumptions.
- Publish provisional Quick, Standard, and Deep gates and the benchmark command.

### Done when

- The same corpus can compare policies and models deterministically.
- Every roadmap release gate has a baseline value or an explicit instrumentation gap.

---
