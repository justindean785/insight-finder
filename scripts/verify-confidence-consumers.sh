#!/usr/bin/env bash
#
# verify-confidence-consumers.sh — the per-artifact display-confidence inventory.
#
# WHY A SCRIPT AND NOT ONLY A TEST. The vitest source guard
# (src/test/display-confidence-contract.test.ts) checks a LIST of files someone
# had to think of. This sweeps the tree, so it finds consumers nobody listed —
# which it did: `src/lib/audit/from-artifacts.ts` (two builders feeding
# CaseReport's audit panel in production), the six `review.set` ground-truth
# contexts that become `analyst_feedback_events.confidence_before`, and the
# low-confidence counters in PivotsTab and ThreadSidebar. All were missed by the
# first pass and by the test guard.
#
# It exits NONZERO on any violation and prints no unconditional "clean" line.
#
# THREE DOCUMENTED EXEMPTIONS, each pinned by its own assertion in the test guard:
#   * `a.confidence >= cap` — AnalysisTab's stored-vs-cap diagnostic. Effective is
#     min(stored, cap), so it can never exceed the cap; this comparison must read
#     the stored column or it measures nothing.
#   * `confidence: a.confidence ?? null,` — ChatWindow's `.from("artifacts").insert()`.
#     A WRITE. Writing the effective value would overwrite the stored column with
#     a capped one, the one thing the canonical helper must never cause.
#   * BrainGlobalPage's `patternSort === "CONFIDENCE"` comparator — `a`/`b` are
#     `agent_memory` rows, not artifacts (selected at :174 with
#     `id,kind,subject,...,confidence,hit_count`), so this is a different table's
#     column that happens to share a name.
#
# Consumer inventory for per-artifact display confidence.
# Exits NONZERO when a forbidden path exists. The exit code is the answer;
# there is no unconditional "clean" line.
set -uo pipefail
cd /home/user/insight-finder
fail=0
report() { if [ -n "$2" ]; then echo "FAIL — $1"; echo "$2"; fail=1; else echo "ok  — $1"; fi; }

echo "== 1. literal NUL bytes in any src/ TypeScript file =="
bad=""
while IFS= read -r f; do
  LC_ALL=C grep -qP '\x00' "$f" 2>/dev/null && bad="$bad$f"$'\n'
done < <(find src -name '*.ts' -o -name '*.tsx')
report "no NUL bytes" "$bad"

echo; echo "== 2. adjustedConfidence called outside intel.ts =="
report "classification score is intel.ts-only" \
  "$(grep -rn 'adjustedConfidence(' src/lib src/components src/pages --include='*.ts' --include='*.tsx' 2>/dev/null \
     | grep -v '^src/lib/intel.ts:' | grep -vE ':[0-9]+: *(//|\*)')"

echo; echo "== 3. raw per-artifact .confidence in components/pages =="
# `a`/`artifact` bound to an Artifact. Two documented exemptions, each pinned by
# its own test: the stored-vs-cap diagnostic, and the ChatWindow DB insert.
report "no raw reads" \
  "$(grep -rnE '\b(a|artifact)\.confidence\b' src/components src/pages --include='*.tsx' --include='*.ts' 2>/dev/null \
     | grep -vE ':[0-9]+: *(//|\*)' \
     | grep -vE 'a\.confidence >= cap' \
     | grep -vE 'confidence: a\.confidence \?\? null,' \
     | grep -vE 'BrainGlobalPage\.tsx:[0-9]+: *if \(patternSort === "CONFIDENCE"\)')"

echo; echo "== 4. derived-model builders in src/lib must emit effective =="
report "builders emit effective" \
  "$(grep -rnE 'confidence: a\.confidence( \?\? 0)?,' src/lib --include='*.ts' | grep -vE ':[0-9]+: *(//|\*)')"

echo; echo "== 5. files importing the canonical helper =="
grep -rl 'from "@/lib/display-confidence"' src/components src/lib src/pages 2>/dev/null | sort

echo
if [ $fail -ne 0 ]; then echo "INVENTORY: FAIL"; exit 1; fi
echo "INVENTORY: PASS"
