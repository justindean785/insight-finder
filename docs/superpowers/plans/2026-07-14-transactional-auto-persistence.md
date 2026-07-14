# Transactional Auto-Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every accepted structured finding through one normalized, transactional artifact-and-evidence write path that never creates null-linked custody rows.

**Architecture:** Explicit per-tool extractors emit database-free `ArtifactCandidate` values. A shared recorder validates provenance, performs kind-aware normalization, applies integrity metadata, and calls a single RPC that deduplicates, resolves the canonical artifact ID, and appends or reuses linked evidence atomically.

**Tech Stack:** Deno 2, TypeScript, Zod, Supabase/Postgres PL/pgSQL, pgcrypto, Deno test, SQL CI scripts.

## Global Constraints

- Preserve all confidence caps, minor-safety rules, credential masking, source independence, and evidence-chain hashing behavior.
- Do not use generic recursive extraction or infer findings from unknown response shapes.
- Do not compare phones by national digits; only canonical E.164 values deduplicate.
- Preserve original `value` for display and use `normalized_value` only for identity.
- Deduplicate by `(thread_id, kind, normalized_value, source)` so distinct sources remain separate observations.
- No finding writer may directly insert an artifact and then call `append_evidence`.
- Extraction and persistence failures remain non-fatal to the investigation stream but must be logged.
- Do not commit unless the user explicitly requests a commit.

---

## File map

- Create `supabase/functions/osint-agent/artifact-normalization.ts`: pure kind-aware canonicalization.
- Create `supabase/functions/osint-agent/artifact-normalization_test.ts`: normalization regression tests.
- Create `supabase/functions/osint-agent/artifact-candidate.ts`: candidate contract, telemetry guard, and integrity-row construction.
- Create `supabase/functions/osint-agent/artifact-candidate_test.ts`: candidate validation and metadata tests.
- Create `supabase/functions/osint-agent/artifact-recorder.ts`: sole application persistence adapter.
- Create `supabase/functions/osint-agent/artifact-recorder_test.ts`: RPC contract and failure tests.
- Create `supabase/functions/osint-agent/tool-result-extractors.ts`: explicit extractor registry.
- Create `supabase/functions/osint-agent/tool-result-extractors_test.ts`: positive/negative provider fixtures.
- Create one migration using `supabase migration new transactional_auto_persistence`; it adds `normalized_value`, consolidates legacy duplicates, replaces the unique index, and replaces `record_artifacts_with_evidence`.
- Modify `supabase/functions/osint-agent/provider-exec.ts`: optional post-success extraction callback for pre-stream providers.
- Modify `supabase/functions/osint-agent/cache.ts`: invoke extraction after successful runtime tool execution.
- Modify `supabase/functions/osint-agent/tool-registry.ts`: route LLM recording, dork, seed, contradiction, and salvage finding writes through the recorder.
- Modify `supabase/functions/osint-agent/anchor-intake.ts`: replace direct RPC usage with the recorder.
- Modify `supabase/functions/osint-agent/attachment-intake.ts`: replace direct artifact insert with the recorder.
- Modify `.github/ci/artifacts-integrity-test.sql`: normalized dedup, cross-source, linkage, and idempotency assertions.
- Modify `.github/ci/concurrent-dedup-test.sh`: simultaneous RPC calls return one canonical artifact/evidence pair.
- Modify `.github/ci/content-hash-compat-test.sql`: verify mixed legacy and transactional chain compatibility.

---

### Task 1: Kind-aware artifact normalization

**Files:**
- Create: `supabase/functions/osint-agent/artifact-normalization.ts`
- Test: `supabase/functions/osint-agent/artifact-normalization_test.ts`

**Interfaces:**
- Produces: `normalizeArtifactValue(kind: string, value: string): { displayValue: string; normalizedValue: string } | null`
- Consumes: no database or network state.

- [ ] **Step 1: Write failing normalization tests**

```ts
import { assertEquals } from "jsr:@std/assert";
import { normalizeArtifactValue } from "./artifact-normalization.ts";

Deno.test("phone normalization preserves country-code identity", () => {
  assertEquals(normalizeArtifactValue("phone", "+1 (916) 821-5143")?.normalizedValue, "+19168215143");
  assertEquals(normalizeArtifactValue("phone", "+7 (916) 821-51-43")?.normalizedValue, "+79168215143");
  assertEquals(normalizeArtifactValue("phone", "9168215143"), null);
});

Deno.test("email username and domain normalization is kind aware", () => {
  assertEquals(normalizeArtifactValue("email", " BigOakTree@GMAIL.COM ")?.normalizedValue, "biggoaktree@gmail.com");
  assertEquals(normalizeArtifactValue("username", " @BigOakTree ")?.normalizedValue, "biggoaktree");
  assertEquals(normalizeArtifactValue("domain", "BÜCHER.Example.")?.normalizedValue, "xn--bcher-kva.example");
});

Deno.test("URL normalization preserves meaningful path and query", () => {
  assertEquals(
    normalizeArtifactValue("social_profile", "HTTPS://Example.COM:443/u/Alice?tab=posts")?.normalizedValue,
    "https://example.com/u/Alice?tab=posts",
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cd supabase/functions/osint-agent
deno test --no-check artifact-normalization_test.ts
```

Expected: FAIL because `artifact-normalization.ts` does not exist.

- [ ] **Step 3: Implement the minimal normalizer**

```ts
export interface NormalizedArtifactValue {
  displayValue: string;
  normalizedValue: string;
}

export function normalizeArtifactValue(kind: string, value: string): NormalizedArtifactValue | null {
  const displayValue = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!displayValue) return null;
  const k = kind.trim().toLowerCase();
  if (k === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(displayValue)) return null;
    return { displayValue, normalizedValue: displayValue.toLowerCase() };
  }
  if (k === "username") {
    const normalizedValue = displayValue.replace(/^@/, "").toLowerCase();
    return normalizedValue ? { displayValue, normalizedValue } : null;
  }
  if (k === "phone") return normalizeE164(displayValue);
  if (k === "domain" || k === "subdomain") return normalizeDomain(displayValue);
  if (k === "ip") return normalizeIp(displayValue);
  if (k === "social_profile" || k === "url") return normalizeUrl(displayValue);
  if (k === "hash" || k === "crypto_wallet") return normalizeHashOrWallet(k, displayValue);
  return { displayValue, normalizedValue: displayValue.toLocaleLowerCase("en-US") };
}

function normalizeE164(displayValue: string): NormalizedArtifactValue | null {
  if (!displayValue.startsWith("+")) return null;
  const digits = displayValue.slice(1).replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return { displayValue, normalizedValue: `+${digits}` };
}

function normalizeDomain(displayValue: string): NormalizedArtifactValue | null {
  const raw = displayValue.replace(/\.$/, "").toLowerCase();
  try {
    const hostname = new URL(`http://${raw}`).hostname.replace(/\.$/, "");
    return hostname ? { displayValue, normalizedValue: hostname } : null;
  } catch {
    return null;
  }
}

function normalizeUrl(displayValue: string): NormalizedArtifactValue | null {
  try {
    const url = new URL(displayValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    return { displayValue, normalizedValue: url.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

function normalizeIp(displayValue: string): NormalizedArtifactValue | null {
  try {
    const bracketed = displayValue.includes(":") ? `[${displayValue}]` : displayValue;
    const hostname = new URL(`http://${bracketed}/`).hostname.replace(/^\[|\]$/g, "");
    return hostname ? { displayValue, normalizedValue: hostname.toLowerCase() } : null;
  } catch {
    return null;
  }
}

function normalizeHashOrWallet(kind: string, displayValue: string): NormalizedArtifactValue {
  const normalizedValue =
    /^0x[0-9a-f]+$/i.test(displayValue) || (kind === "hash" && /^[0-9a-f]+$/i.test(displayValue))
      ? displayValue.toLowerCase()
      : displayValue;
  return { displayValue, normalizedValue };
}
```

Keep the helpers private. Reject ambiguous phone/IP values rather than guessing.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
deno test --no-check artifact-normalization_test.ts
```

Expected: all normalization tests PASS.

---

### Task 2: Canonical candidate and shared recorder

**Files:**
- Create: `supabase/functions/osint-agent/artifact-candidate.ts`
- Create: `supabase/functions/osint-agent/artifact-candidate_test.ts`
- Create: `supabase/functions/osint-agent/artifact-recorder.ts`
- Create: `supabase/functions/osint-agent/artifact-recorder_test.ts`
- Modify: `supabase/functions/osint-agent/auto-record-integrity.ts`

**Interfaces:**
- Produces:

```ts
export interface ArtifactCandidate {
  kind: string;
  value: string;
  source: string;
  sourceUrl?: string | null;
  discoveredVia: string;
  rationale: string;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  autoRecorded: boolean;
}

export interface PersistedArtifact {
  artifactId: string;
  evidenceId: string;
  inserted: boolean;
}

export async function recordArtifactCandidates(
  db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  threadId: string,
  candidates: ArtifactCandidate[],
): Promise<{ persisted: PersistedArtifact[]; rejected: Array<{ index: number; reason: string }> }>;
```

- Consumes: `normalizeArtifactValue`, existing confidence/status helpers, `scrubArtifactRows`.

- [ ] **Step 1: Write failing candidate and recorder tests**

Test these exact behaviors:

```ts
Deno.test("candidate rejects process telemetry", () => {
  for (const kind of ["cluster_decision", "triage_summary", "tool_failure", "risk_assessment", "pivot_decision", "run_health"]) {
    assertEquals(toPersistenceRow(candidate({ kind })), null);
  }
});

Deno.test("recorder sends normalized rows to exactly one transactional RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = { rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return Promise.resolve({ data: [{ artifact_id: "a1", evidence_id: "e1", inserted: true }], error: null });
  }};
  const result = await recordArtifactCandidates(db, "t1", [candidate({ kind: "email", value: " A@EXAMPLE.COM " })]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "record_artifacts_with_evidence");
  assertEquals((calls[0].args._rows as Array<Record<string, unknown>>)[0].normalized_value, "a@example.com");
  assertEquals(result.persisted[0], { artifactId: "a1", evidenceId: "e1", inserted: true });
});
```

Also assert that provenance is repaired only to `llm_asserted_unverified` when the source is unverifiable, never replaced with an invented tool name.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
deno test --no-check artifact-candidate_test.ts artifact-recorder_test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement candidate conversion and recorder**

Use `buildAutoRecordedRow` for `autoRecorded: true`; retain the existing LLM integrity envelope for `autoRecorded: false`. Every row sent to the RPC must include:

```ts
{
  kind,
  value: normalized.displayValue,
  normalized_value: normalized.normalizedValue,
  confidence,
  source,
  metadata: {
    ...metadata,
    auto_recorded: candidate.autoRecorded,
    source_url: candidate.sourceUrl ?? metadata?.source_url ?? null,
    discovered_via: candidate.discoveredVia,
    rationale: candidate.rationale,
  },
}
```

Reject any RPC result missing either `artifact_id` or `evidence_id`; this is a contract failure, not a successful persistence result.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
deno test --no-check artifact-normalization_test.ts artifact-candidate_test.ts artifact-recorder_test.ts
```

Expected: all tests PASS.

---

### Task 3: Normalized database identity and atomic RPC

**Files:**
- Create: migration generated by `supabase migration new transactional_auto_persistence`
- Modify: `.github/ci/artifacts-integrity-test.sql`
- Modify: `.github/ci/concurrent-dedup-test.sh`
- Modify: `.github/ci/content-hash-compat-test.sql`

**Interfaces:**
- Produces SQL RPC rows:

```sql
RETURNS TABLE(artifact_id uuid, evidence_id uuid, inserted boolean)
```

- Consumes JSON rows containing `kind`, `value`, `normalized_value`, `source`, `confidence`, and `metadata`.

- [ ] **Step 1: Generate the migration file**

Run:

```bash
supabase migration new transactional_auto_persistence
```

Expected: one timestamped SQL file under `supabase/migrations/`.

- [ ] **Step 2: Extend SQL tests first**

Add assertions proving:

```sql
-- Same source + normalized email reuses one artifact and evidence row.
SELECT * FROM public.record_artifacts_with_evidence(
  _tid,
  '[{"kind":"email","value":"A@Example.com","normalized_value":"a@example.com","source":"providerA"}]'::jsonb
);
SELECT * FROM public.record_artifacts_with_evidence(
  _tid,
  '[{"kind":"email","value":"a@example.com","normalized_value":"a@example.com","source":"providerA"}]'::jsonb
);

-- Different source remains a separate observation.
SELECT * FROM public.record_artifacts_with_evidence(
  _tid,
  '[{"kind":"email","value":"a@example.com","normalized_value":"a@example.com","source":"providerB"}]'::jsonb
);
```

Assert providerA has one artifact and one linked evidence row, providerB has one separate artifact and linked evidence row, every RPC return has non-null IDs, and `verify_evidence_chain(_tid).ok` is true.

- [ ] **Step 3: Run SQL CI and verify RED**

Run:

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/supabase-platform-shim.sql
while IFS= read -r f; do
  psql --set ON_ERROR_STOP=1 --quiet -f "${f}"
done < <(printf '%s\n' supabase/migrations/*.sql | LC_ALL=C sort -t_ -k1,1)
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/content-hash-compat-test.sql
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/artifacts-integrity-test.sql
bash .github/ci/concurrent-dedup-test.sh
```

Expected: FAIL because `normalized_value` and the new RPC output contract do not exist.

- [ ] **Step 4: Implement migration and RPC**

Migration requirements:

```sql
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS normalized_value text;
```

Backfill conservatively by kind. Consolidate duplicate groups by selecting the oldest artifact ID, repointing `evidence_log.artifact_id`, and deleting only redundant artifact rows. Replace `artifacts_thread_kind_value_source_uidx` with:

```sql
CREATE UNIQUE INDEX artifacts_thread_kind_normalized_source_uidx
ON public.artifacts (thread_id, kind, normalized_value, COALESCE(source, ''));
```

Replace `record_artifacts_with_evidence` so it:

1. validates ownership and non-empty `normalized_value`;
2. locks the thread;
3. selects the canonical artifact with `FOR UPDATE`;
4. inserts only when absent;
5. finds an existing linked evidence row for a reused artifact;
6. appends linked evidence when inserting or repairing a legacy unlinked artifact;
7. returns non-null artifact/evidence IDs and `inserted`;
8. rolls back on any exception.

Preserve the current nine-field `content_hash` byte order exactly.

- [ ] **Step 5: Run SQL tests and verify GREEN**

Expected: normalized dedup, cross-source, concurrent-idempotency, and hash compatibility scripts all PASS.

---

### Task 4: Converge every existing finding writer

**Files:**
- Modify: `supabase/functions/osint-agent/tool-registry.ts`
- Modify: `supabase/functions/osint-agent/anchor-intake.ts`
- Modify: `supabase/functions/osint-agent/attachment-intake.ts`
- Modify: related existing tests and add `supabase/functions/osint-agent/writer_convergence_test.ts`

**Interfaces:**
- Consumes: `recordArtifactCandidates`.
- Produces: no direct finding inserts and no `append_evidence` call with `_artifact_id: null`.

- [ ] **Step 1: Write the failing convergence test**

Read the source files as text and assert:

```ts
for (const file of ["tool-registry.ts", "anchor-intake.ts", "attachment-intake.ts"]) {
  const source = await Deno.readTextFile(new URL(file, import.meta.url));
  assert(!source.includes('_artifact_id: null'), `${file} still appends orphan evidence`);
}
```

Add behavioral tests with fake DBs proving LLM, anchor, attachment, and dork flows each call `record_artifacts_with_evidence` exactly once per batch.

- [ ] **Step 2: Run convergence tests and verify RED**

Run:

```bash
deno test --no-check --allow-read writer_convergence_test.ts anchor_intake_test.ts attachment_intake_test.ts
```

Expected: FAIL on direct inserts and null artifact linkage.

- [ ] **Step 3: Migrate writers**

- In `tool-registry.ts`, keep all existing integrity gates and candidate construction, then replace the direct bulk/per-row insert plus serial `append_evidence` block with one `recordArtifactCandidates` call.
- Route dork, seed-derived, contradiction, salvage-finding, and analyst-added finding writes through the same recorder.
- In `anchor-intake.ts`, convert rows to `ArtifactCandidate` and call the recorder.
- In `attachment-intake.ts`, replace `.from("artifacts").insert(safeRows)` with the recorder.
- Preserve archive follow-up by updating evidence rows using returned `evidenceId`, not `(kind,value)` matching.
- Preserve `bumpArtifacts`, collision checks, memory recall, and return counts using `inserted`.

- [ ] **Step 4: Run convergence tests and verify GREEN**

Run:

```bash
deno test --no-check --allow-read writer_convergence_test.ts anchor_intake_test.ts attachment_intake_test.ts record_artifacts_test.ts
```

Expected: all tests PASS and the static guard finds no orphan append pattern.

---

### Task 5: Explicit high-value tool extractors

**Files:**
- Create: `supabase/functions/osint-agent/tool-result-extractors.ts`
- Create: `supabase/functions/osint-agent/tool-result-extractors_test.ts`
- Modify: `supabase/functions/osint-agent/cache.ts`
- Modify: `supabase/functions/osint-agent/provider-exec.ts`

**Interfaces:**
- Produces:

```ts
export type ToolResultExtractor = (result: unknown, context: {
  toolName: string;
  input: Record<string, unknown>;
}) => ArtifactCandidate[];

export function extractToolResult(
  toolName: string,
  result: unknown,
  input: Record<string, unknown>,
): ArtifactCandidate[];
```

- Consumes stable response contracts for hunter email verification, Indicia person/phone, username sweep, SocialFetch profile, Serus breach, and OathNet/broker results.

- [ ] **Step 1: Write failing fixture tests**

For each extractor, include one real positive fixture and four non-finding fixtures:

```ts
for (const result of [
  { found: 0, data: [] },
  { ok: true, data: [] },
  { ok: false, error: "timeout" },
  { ok: true, health: "healthy" },
]) {
  assertEquals(extractToolResult("indicia_phone", result, { query: "+19168215143" }), []);
}
```

Positive fixtures must assert `source`, `sourceUrl`, `discoveredVia`, `rationale`, `autoRecorded: true`, and the expected high-value kind/value.

- [ ] **Step 2: Run extractor tests and verify RED**

Run:

```bash
deno test --no-check tool-result-extractors_test.ts
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement explicit extractors**

Use Zod schemas local to each provider extractor. Return `[]` for unsupported shapes. Do not recursively scan arbitrary keys. Add registry entries only for the six tested provider families.

- [ ] **Step 4: Integrate automatic persistence**

After a successful, non-empty runtime tool result:

```ts
const candidates = extractToolResult(name, result, input);
if (candidates.length > 0) {
  await recordArtifactCandidates(db, threadId, candidates);
}
```

Apply the same hook to `executeProvider` for pre-stream calls. Cache hits may call the recorder safely because the RPC is idempotent.

- [ ] **Step 5: Run extractor and provider tests**

Run:

```bash
deno test --no-check tool-result-extractors_test.ts provider_exec_test.ts cache_test.ts
```

Expected: all tests PASS; negative fixtures create no recorder call.

---

### Task 6: End-to-end integrity verification

**Files:**
- Modify only if a verified failure requires a targeted correction.

**Interfaces:**
- Verifies all prior tasks; produces no new feature surface.

- [ ] **Step 1: Run focused edge tests**

```bash
cd supabase/functions/osint-agent
deno test --no-check --allow-net --allow-env --allow-sys --allow-read \
  artifact-normalization_test.ts \
  artifact-candidate_test.ts \
  artifact-recorder_test.ts \
  tool-result-extractors_test.ts \
  writer_convergence_test.ts \
  anchor_intake_test.ts \
  attachment_intake_test.ts \
  record_artifacts_test.ts \
  provider_exec_test.ts
```

Expected: zero failures and no leaked timer/resource warnings.

- [ ] **Step 2: Run the complete edge suite**

```bash
npm run test:edge
```

Expected: zero failures.

- [ ] **Step 3: Run frontend regression tests and type checks**

```bash
npm run test
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 4: Run migration, concurrency, and hash-chain CI scripts**

Run against a clean local Postgres 15 instance:

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/supabase-platform-shim.sql
while IFS= read -r f; do
  psql --set ON_ERROR_STOP=1 --quiet -f "${f}"
done < <(printf '%s\n' supabase/migrations/*.sql | LC_ALL=C sort -t_ -k1,1)
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/content-hash-compat-test.sql
psql --set ON_ERROR_STOP=1 --quiet -f .github/ci/artifacts-integrity-test.sql
bash .github/ci/concurrent-dedup-test.sh
```

Expected:

- formatted E.164 variants collapse;
- `+1 916...` and `+7 916...` remain distinct;
- same-source repeats return identical artifact/evidence IDs;
- distinct-source observations remain separate;
- simultaneous writes create one canonical artifact per source;
- every finding evidence row has non-null `artifact_id`;
- `verify_evidence_chain` returns `ok = true`.

- [ ] **Step 5: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only planned source, migration, test, spec, and plan files changed. Do not include `.cursor/hooks/state/continual-learning.json`.

- [ ] **Step 6: Request independent review**

Review the full diff against the design and acceptance criteria. Fix every Critical and Important issue, then rerun Steps 1–5.

---

## Deployment gate

Deployment is not part of implementation. After merge approval:

1. merge to `justindean785/insight-finder` `main`;
2. apply the normalized-value/RPC migration through the authorized project channel;
3. run `npm run stamp:build` and commit the build marker;
4. surgically sync changed edge files to the Lovable mirror;
5. explicitly invoke Lovable `supabase--deploy_edge_functions`;
6. verify `/health` reports the moved build SHA;
7. run one benign email and one benign phone scan;
8. query that every auto-recorded artifact has linked evidence and no finding evidence row has a null `artifact_id`.
