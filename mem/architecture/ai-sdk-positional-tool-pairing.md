# The AI SDK's tool-pairing rule is POSITIONAL, not global

A run that dies mid-tool can leave a thread **permanently unrunnable**: every later
turn fails with `AI_MissingToolResultsError` at step 0 in under 200 ms, forever,
and Retry can never succeed. Diagnosed 2026-08-25 on thread `9ac01762`.

## Where the error actually comes from

Not from our classifier. `MissingToolResultsError` is thrown inside the SDK's
`convertToLanguageModelPrompt` (`node_modules/ai/dist/index.mjs`), and its rule is:

```js
// walk the messages:
//   assistant tool-calls  -> add toolCallId
//   tool-results          -> delete toolCallId
case "user": case "system":
  if (toolCallIds.size > 0) throw new MissingToolResultsError(...)
```

**A tool call must be resolved BEFORE the next user/system message.** "A result
appears somewhere later in the array" does not satisfy it. `providerExecuted`
calls are skipped.

`index.ts`'s `isMessageSchemaError` only *labels* this after the fact and turns it
into the user-facing "Investigation ended early — partial results were saved".
**That string is NOT proof of a pairing fault** — an earlier draft of this note
claimed it was, and that was wrong. `isMessageSchemaError` matches on the error
*name* family `/InvalidPrompt|MissingToolResults/i`, so a real
`MissingToolResultsError`, an empty message array (`"messages must not be empty"`,
which `sanitizeModelMessages` can produce — it has no non-empty postcondition),
and a malformed ModelMessage all render the identical sentence.

The discriminator does survive, just not on that surface: the stream-level
`onError` logs `error_name` plus the message, and `recovery_reason` on the
`threads` row carries it too. Diagnose from those — never from the user-facing
string alone.

## Two plausible diagnoses that are FALSE — verified, do not re-derive

- **"`convertToModelMessages` throws before sanitation can help."** It does not
  throw. Given a UIMessage tool part with no output it emits a dangling
  `tool-call` and returns normally. Checked on ai@6 for every part state:
  `input-streaming`, `input-available`, `output-available` with undefined/null
  output, `output-error`, no state, `dynamic-tool`.
- **"`message-sanitize.ts` runs too late."** It runs LAST in the chain
  (`convert -> trim -> capTotalToBudget -> capToolResultOutputs -> sanitize`) and
  repairs all of those shapes.

A fix aimed at either adds code for a mechanism that is not failing.

## The invariant that prevents it

**The tool executor must never throw.** A throw escapes into the live AI-SDK step
and orphans the sibling tool calls the model emitted in the same step. All three
paths in `cache.ts` should return a schema-safe `{ok:false, _tool_error:true}`
result instead. On `main` today **two** of them do — the NO_CACHE wrapper and the
live-call catch. The **pre-live guard** is the third and still rethrows; PR #502
converts it.

## ⚠️ Not yet on `main` — pending PR #502

What follows describes code that exists **only** on the #502 branch
(`claude/audit-claims-verify-oi0urm`). Do not look for it in a checkout of `main`,
and do not plan an incident response around it until #502 merges.

`enforceToolPairing()` (`message-sanitize.ts`) runs the SDK's exact positional
rule at both boundaries — the step-0 prompt and every in-stream step — and
**repairs** rather than failing closed, because failing closed leaves the thread
permanently unrunnable, which is the actual symptom. On `main` those boundaries
call `sanitizeModelMessages` alone, whose pairing rule is GLOBAL (a result
anywhere in the array counts) rather than positional.

## If it happens again

**Once #502 merges:** `enforceToolPairing` logs
`tool_pairing_repaired_at_boundary` / `tool_pairing_repaired_at_step` with the
offending tool-call ids, and that log line is the starting point — it names the
shape that still survives `sanitizeModelMessages`, which was not reproducible
locally.

**Until then that instrumentation does not exist.** Start from `error_name` in the
edge logs and `recovery_reason` on the `threads` row, and read the positional rule
above against the actual message array by hand.
