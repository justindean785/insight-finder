// lib/historical-label.ts — the HEAD label for earlier assistant narrative (a leaf: no imports).
// Kept separate so orchestrator-budget.ts can preserve it during elision without pulling in the
// memory modules. See lib/history-label.ts for what is labeled and why.
export const HISTORICAL_OUTPUT_LABEL =
  "[HISTORICAL MODEL OUTPUT — an earlier assistant turn in this conversation. It is not independent evidence: treat its claims as unverified unless a recorded artifact or an analyst decision backs them.]\n\n";
