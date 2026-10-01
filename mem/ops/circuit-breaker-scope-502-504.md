# Circuit breaker: 502/504 are TOOL-level only, not provider-level

**Measured 2026-09-12**, after a review caught this being overstated in the other
direction. Recorded because the mistake was to *claim work was already shipped* and
partly dismiss a real request on that basis.

## What `circuit.ts` actually does

- **Provider-level** suppression, for the whole investigation, on the **first**
  occurrence: `http_500` (any other 5xx), `401`/`403`, `402`, `429`, and `timeout`
  (immediately for a single-upstream provider; second timeout for oathnet; third for a
  `GENERAL_MULTI_ORIGIN_TOOLS` fan-out tool). This is **stricter** than the commonly
  proposed "circuit-break after 2 failures per run".
- **Tool-level only:** `502`/`504` set `b.disabledReason` for the thread and **never
  call `suppressProvider`**. **Sibling tools on the same provider keep being scheduled
  after a gateway error** — so for grouped providers (OathNet's five tools, DeepFind)
  that part of the work is genuinely NOT shipped.

## The larger gap that stands

The breaker is **per-thread and in-memory**, so it never carries **across runs**. A
provider 500ing for three days is retried fresh in every new investigation. Closing
that needs a **persisted** provider-health table; the in-memory per-thread breaker
cannot express it.

## The queued follow-up

Calling `suppressProvider` in the 502/504 case arm (as the 500 arm already does) is a
one-line change — but it is a real behaviour change to the breaker and belongs in its
own PR with its own test, not bolted onto unrelated work. Queued as a suggestion card;
**not started unprompted.**

## The transferable lesson

"Already shipped" is a claim that needs the same verification as a defect report. Read
the case arm, not the switch statement's general shape.
