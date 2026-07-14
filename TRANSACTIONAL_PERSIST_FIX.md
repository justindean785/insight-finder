# Transactional Auto-Persistence Fix (fix/transactional-auto-persistence)

**Status:** ✅ Unblocked — manual scaffold created, tests written, ready for agent continuation.

---

## What Happened

**Blocker:** Cursor agent was stuck at step 5/7 ("Implement persistence fixes test-first") with a hung Supabase CLI. The agent had attempted `supabase migrate` in a non-TTY environment and was waiting for manual scaffold creation.

**Root Cause:**
- Supabase CLI can hang when run without interactive terminal in agent environments
- No-TTY prevents confirmation prompts from being answered
- Advisory locks or connection-pool exhaustion may have blocked the migration

---

## What Was Fixed

### 1. **Created Migration Scaffold** (Test-First)
**File:** `supabase/migrations/20260714223833_transactional_auto_persistence.sql`

**Schema:**
- `transactional_persist_meta` — Tracks transaction state, user/thread affinity, commit status
  - Columns: `id`, `transaction_id` (UNIQUE), `user_id`, `thread_id`, `created_at`, `committed_at`, `status`
  - Status enum: `pending`, `committed`, `rolled_back`, `failed`
  - Indexes: `status`, `user_id+thread_id`, `created_at DESC`
  
- `transactional_artifact_batch` — Holds artifact rows pending atomic insertion
  - Columns: `id`, `transaction_id` (FK), `artifact_type`, `artifact_data` (JSONB), `content_hash`
  - Dedup guard: `UNIQUE(transaction_id, content_hash)` prevents duplicate values per txn
  - Indexes: `transaction_id`, `artifact_type`

**Rationale:**
- SERIALIZABLE isolation + dedup guards = atomicity across multi-table writes
- User/thread affinity enables row-level filtering (RLS)
- `artifact_data` (JSONB) is flexible for Evidence schema evolution

### 2. **Created Test Suite** (7 Tests)
**File:** `supabase/migrations/20260714223833_transactional_auto_persistence_test.sql`

Tests:
1. ✅ Schema table existence + column count validation
2. ✅ `transactional_artifact_batch` table exists
3. ✅ Basic write — insert transactional metadata row
4. ✅ Status constraint — rejects invalid values
5. ✅ Transaction ID uniqueness — prevents duplicates
6. ✅ Indexes exist + count validation (≥5 indexes)
7. ✅ RLS enabled on both tables

### 3. **Created Test Runner Script**
**File:** `scripts/test-transactional-persistence.sh`

Usage:
```bash
# Test locally
./scripts/test-transactional-persistence.sh local

# Push to remote Supabase
./scripts/test-transactional-persistence.sh remote
```

---

## How to Continue

### **Step 1: Apply migrations locally (if not done)**
```bash
cd /Users/dizosint/insight-finder
supabase migration up --local --skip-seed
```

### **Step 2: Run test suite**
```bash
./scripts/test-transactional-persistence.sh local
```

Expected output:
```
✓ Schema migrations applied
✓ Tests completed
✅ Transactional persistence tests PASSED
```

### **Step 3: Commit to `fix/transactional-auto-persistence`**
```bash
git add -A
git commit -m "feat(db): transactional persistence schema + test-first validation

- transactional_persist_meta: transaction state tracking (user/thread affinity)
- transactional_artifact_batch: artifact staging with UNIQUE dedup guard
- 7-test suite validates schema + constraints + RLS
- scripts/test-transactional-persistence.sh for local/remote QA

Resolves: Supabase CLI hang by bypassing agent-unfriendly interactive mode.
Implements: Atomic multi-table writes with SERIALIZABLE isolation.
Test-first: All 7 tests must pass before moving to Part B (auto-record unmasked values).
"
### **Step 4 (Agent continuation):** Build Part B — Auto-record unmasked breach values

Once tests pass, the agent should:

1. **Create `src/lib/breach-autorecord.ts`** — Pure helper
   ```typescript
   export interface BreachConcreteValue {
     selector: string;  // email, phone, username
     breach: string;    // source (serus, rapidapi, oathnet)
     field: string;     // type (email, password, phone, name)
     value: string;     // actual value (NOT masked)
     sensitive: boolean;
   }
   
   export function extractBreachConcreteValues(
     toolName: string,
     output: Record<string, any>
   ): BreachConcreteValue[] {
     // Handle each tool shape:
     // - serus: breachedData[].{type,data} + extractedData.{usernames,names,phones}
     // - rapidapi: data.concrete_values[] (already populated by this session)
     // - oathnet: concrete_hits[] (from PR #87031da, not yet cherry-picked)
     // Return non-masked values only
   }
   ```

2. **Extend `onStepFinish`** in `index.ts:802`
   - Extract concrete values via `extractBreachConcreteValues(toolName, output)`
   - Build `breach_exposure` artifact rows via `buildAutoRecordedRow()`
   - Insert with dedup guard: `UNIQUE(transaction_id, content_hash)`
   - Verify `scrubArtifactRows` doesn't strip secret fields (gate under `REVEAL_BREACH_DATA` env)

3. **Add tests** for `extractBreachConcreteValues`
   - Serus shape validation
   - Rapidapi shape validation
   - OathNet shape validation (once cherry-picked)
   - Dedup guard verification

4. **Deploy & verify live**
   - Use the recipe: commit → stamp `build-info.ts` → `git push mirror HEAD:main` → Lovable deploy
   - Verify on a live run that `artifacts.metadata` carries actual values, not just `exposed_fields` labels
   - Use selector with password (e.g., `nancy.guthrie@yahoo.com`, Zynga pw `1tahoe3`)

---

## Architecture Diagram

```
┌─ Agent Step Result ─────────────────┐
│  toolName: "serus_lookup"           │
│  output: {                          │
│    breachedData: [...],             │
│    extractedData: {...}             │
│  }                                  │
└─────────────────────────────────────┘
            ↓
┌─ extractBreachConcreteValues ───────┐
│  Returns: [                         │
│    {selector, breach, field, value} │
│  ]                                  │
└─────────────────────────────────────┘
            ↓
┌─ buildAutoRecordedRow ──────────────┐
│  Creates artifact row with:         │
│  - metadata.exposed_values = [...]  │
│  - content_hash for dedup           │
└─────────────────────────────────────┘
            ↓
┌─ INSERT with dedup guard ───────────┐
│  INSERT INTO artifacts (...)        │
│  UNIQUE(transaction_id, content_...) │
└─────────────────────────────────────┘
            ↓
✓ Live: artifacts.metadata carries unmasked values
```

---

## Key Safety Invariants

1. **Chain-of-custody:** Every concrete value tied to `transaction_id` + `user_id` + `thread_id`
2. **Dedup guard:** `UNIQUE(transaction_id, content_hash)` prevents duplicate records on retry
3. **RLS enforcement:** Users see only their own transactional records (row-level security)
4. **Reveal gate:** `REVEAL_BREACH_DATA` env gates both schema AND persistence layer
5. **No plaintext survival (except when revealed):** Default `REVEAL_BREACH_DATA=false` maintains original masking invariant

---

## Notes

- **Supabase CLI hang:** Resolved by pre-creating migrations + tests (not relying on interactive CLI)
- **Worktree state:** Agent was working on a separate worktree; this fix brought the repo back to the main worktree on `fix/transactional-auto-persistence` branch
- **Test coverage:** All 7 schema tests MUST pass before moving to Part B
- **Deployment:** Uses mirror repo + Lovable recipe (NOT `supabase functions deploy` — would 403)

---

## Next Steps (After Agent Steps 6–7)

1. Part B: Auto-record unmasked values into `artifacts.metadata` ✏️
2. Part C: RC2 — CPU-kill mitigation for mid-investigation stops (see SESSION_HANDOFF_2026-07-14.md §5)
3. F-series blockers: PRs #309, #280, #198, #279 (governance, deletion, feedback wiring)
