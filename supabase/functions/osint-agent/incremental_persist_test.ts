import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCheckpointContract,
  emitSafeCheckpoint,
  persistCheckpoint,
  collectStepCheckpoint,
  loadSeenCheckpoints,
  extractCheckpointKeys,
  isIncrementalMessage,
  computeCheckpointId,
  checkpointKey,
  renderCheckpointText,
  registerBackground,
  withTimeout,
  type CheckpointEmission,
} from "./incremental-persist.ts";

// ---- fakes -----------------------------------------------------------------

function fakeSupabase() {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    inserts,
    client: {
      from(_t: string) {
        return {
          insert: (row: Record<string, unknown>) => {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

function failingSupabase(mode: "error" | "throw") {
  return {
    from(_t: string) {
      return {
        insert: (_row: Record<string, unknown>) => {
          if (mode === "throw") throw new Error("connection reset");
          return Promise.resolve({ error: { message: "duplicate key" } });
        },
      };
    },
  };
}

/** A post-scrub artifact row, as record_artifacts hands to buildCheckpointContract. */
function row(over: Partial<{ kind: string; value: string; confidence: number; source: string; metadata: Record<string, unknown> }> = {}) {
  return {
    kind: over.kind ?? "name",
    value: over.value ?? "Jane Doe",
    confidence: over.confidence ?? 60,
    source: over.source ?? "court_record",
    metadata: over.metadata ?? {},
  };
}

// ---- SECURITY: allowlist / exclusions --------------------------------------

Deno.test("safe identity kinds pass the allowlist", () => {
  const emit = emitSafeCheckpoint([
    row({ kind: "name", value: "Jane Doe" }),
    row({ kind: "organization", value: "Acme Inc" }),
    row({ kind: "address", value: "1 Main St, Anytown, CA 90001" }),
    row({ kind: "legal_record", value: "CA DRE H-12345" }),
  ]);
  assertEquals(emit.map((e) => e.kind).sort(), ["address", "legal_record", "name", "organization"]);
});

Deno.test("SECURITY: credential/secret/token/cookie kinds are excluded", () => {
  for (const kind of ["credential", "password", "token", "access_token", "cookie", "api_key", "private_key", "session_token"]) {
    const emit = emitSafeCheckpoint([row({ kind, value: "hunter2-value" })]);
    assertEquals(emit.length, 0, `${kind} must be excluded`);
  }
});

Deno.test("SECURITY: raw breach payload kinds are excluded", () => {
  for (const kind of ["breach", "breach_record", "breach_payload", "stealer_log", "combolist"]) {
    const emit = emitSafeCheckpoint([row({ kind, value: "Collection#1 / p4ssw0rd" })]);
    assertEquals(emit.length, 0, `${kind} must be excluded`);
  }
});

Deno.test("SECURITY: token-shaped VALUE on an allowed kind is excluded (value-level pattern)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc";
  const emit = emitSafeCheckpoint([
    row({ kind: "other", value: jwt }),
    row({ kind: "note", value: "authorization: Bearer sk-secret" }),
    row({ kind: "other", value: "my password is abc123" }),
  ]);
  assertEquals(emit.length, 0, "secret-shaped values must be excluded regardless of kind");
});

Deno.test("SECURITY: dob / ssn kinds are excluded", () => {
  assertEquals(emitSafeCheckpoint([row({ kind: "dob", value: "1990-01-01" })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "ssn", value: "123-45-6789" })]).length, 0);
});

// ---- SAFETY: possible-minor -------------------------------------------------

Deno.test("SAFETY: possible-minor artifacts are excluded (possible_minor + minor_warning + sensitive)", () => {
  assertEquals(emitSafeCheckpoint([row({ kind: "username", value: "kid_gamer", metadata: { possible_minor: true } })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "social", value: "teen_x", metadata: { minor_warning: true } })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "name", value: "A Minor", metadata: { sensitive: true } })]).length, 0);
});

// ---- SAFETY: collision / rejected ------------------------------------------

Deno.test("SAFETY: collision-quarantined artifacts are excluded", () => {
  assertEquals(emitSafeCheckpoint([row({ kind: "excluded_collision", value: "Someone Else" })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "name", value: "Namesake", metadata: { excluded_collision: true } })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "name", value: "Namesake", metadata: { status: "excluded" } })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "phone", value: "5551234567", metadata: { different_person: true } })]).length, 0);
  assertEquals(emitSafeCheckpoint([row({ kind: "email", value: "x@y.com", metadata: { unrelated: "true" } })]).length, 0);
});

// ---- pre-scrub vs post-scrub ------------------------------------------------

Deno.test("pre-scrub vs post-scrub: the same value is included pre-flag and excluded once the scrub sets the minor flag", () => {
  // Pre-scrub row (safety.ts has not yet stamped minor metadata): included.
  const preScrub = emitSafeCheckpoint([row({ kind: "username", value: "raheem14" })]);
  assertEquals(preScrub.length, 1);
  // Post-scrub row (scrubArtifactRows stamped possible_minor): excluded. This
  // proves the checkpoint depends on the POST-scrub contract, not raw input.
  const postScrub = emitSafeCheckpoint([row({ kind: "username", value: "raheem14", metadata: { possible_minor: true, minor_signals: ["age-16"] } })]);
  assertEquals(postScrub.length, 0);
});

Deno.test("emission carries source + confidence but not raw metadata", () => {
  const emit = emitSafeCheckpoint([row({ kind: "email", value: "a@b.com", confidence: 65, source: "leakcheck", metadata: { secret_note: "should not leak" } })]);
  assertEquals(emit.length, 1);
  assertEquals(emit[0], { kind: "email", value: "a@b.com", source: "leakcheck", confidence: 65 });
});

// ---- contract classification (full form) ------------------------------------

Deno.test("buildCheckpointContract flags safety without dropping (audit form)", () => {
  const c = buildCheckpointContract([
    row({ kind: "name", value: "Real Subject" }),
    row({ kind: "credential", value: "pw" }),
    row({ kind: "name", value: "Kid", metadata: { possible_minor: true } }),
  ]);
  assertEquals(c.length, 3);
  assertEquals(c[0].display_safe, true);
  assertEquals(c[1].display_safe, false);
  assert(c[1].safety_flags.includes("denied_kind"));
  assertEquals(c[2].display_safe, false);
  assert(c[2].safety_flags.includes("possible_minor"));
});

// ---- persist: insertion + dedup --------------------------------------------

Deno.test("persistCheckpoint inserts one row for new safe findings", async () => {
  const sb = fakeSupabase();
  const seen = new Set<string>();
  const r = await persistCheckpoint({ supabase: sb.client, threadId: "t1", userId: "u1", seen }, [
    { kind: "email", value: "a@b.com", source: null, confidence: 60 },
    { kind: "name", value: "Jane Doe", source: null, confidence: 70 },
  ]);
  assertEquals(r.inserted, true);
  assertEquals(r.count, 2);
  assertEquals(sb.inserts.length, 1);
  const parts = (sb.inserts[0] as { parts: Array<{ text: string; _incremental?: boolean; _checkpoint_keys?: string[] }> }).parts;
  assert(parts[0].text.includes("a@b.com"));
  assertEquals(parts[0]._incremental, true);
  assertEquals(parts[0]._checkpoint_keys?.length, 2);
});

Deno.test("persistCheckpoint dedupes within run via the seen set (case-insensitive)", async () => {
  const sb = fakeSupabase();
  const seen = new Set<string>();
  await persistCheckpoint({ supabase: sb.client, threadId: "t1", userId: "u1", seen }, [{ kind: "email", value: "a@b.com", source: null, confidence: 60 }]);
  const r2 = await persistCheckpoint({ supabase: sb.client, threadId: "t1", userId: "u1", seen }, [{ kind: "email", value: "A@B.COM", source: null, confidence: 60 }]);
  assertEquals(r2.inserted, false);
  assertEquals(sb.inserts.length, 1);
});

Deno.test("persistCheckpoint independently drops an unsafe item even if wrongly emitted (defense in depth)", async () => {
  const sb = fakeSupabase();
  const seen = new Set<string>();
  const r = await persistCheckpoint({ supabase: sb.client, threadId: "t1", userId: "u1", seen }, [
    { kind: "password", value: "hunter2", source: null, confidence: 90 } as CheckpointEmission,
    { kind: "name", value: "Jane Doe", source: null, confidence: 70 },
  ]);
  assertEquals(r.count, 1);
  const text = (sb.inserts[0] as { parts: Array<{ text: string }> }).parts[0].text;
  assert(!text.toLowerCase().includes("hunter2"), "unsafe item must never reach chat text");
});

// ---- persist: interrupted / failed writes ----------------------------------

Deno.test("interrupted persistence: insert error returns not-inserted and never throws", async () => {
  const seen = new Set<string>();
  const r = await persistCheckpoint({ supabase: failingSupabase("error"), threadId: "t1", userId: "u1", seen }, [{ kind: "name", value: "Jane", source: null, confidence: 60 }]);
  assertEquals(r.inserted, false);
  // Not marked seen, so a later retry can still surface it.
  assertEquals(seen.size, 0);
});

Deno.test("interrupted persistence: a thrown insert is swallowed (best-effort)", async () => {
  const seen = new Set<string>();
  const r = await persistCheckpoint({ supabase: failingSupabase("throw"), threadId: "t1", userId: "u1", seen }, [{ kind: "name", value: "Jane", source: null, confidence: 60 }]);
  assertEquals(r.inserted, false);
  assertEquals(seen.size, 0);
});

// ---- recovery replay / idempotency -----------------------------------------

Deno.test("computeCheckpointId is deterministic and order-independent", () => {
  const a = computeCheckpointId("t1", ["email:a@b.com", "name:jane doe"]);
  const b = computeCheckpointId("t1", ["name:jane doe", "email:a@b.com"]);
  assertEquals(a, b);
  assert(computeCheckpointId("t2", ["email:a@b.com"]) !== a);
});

Deno.test("recovery replay: seeding seen from prior checkpoints suppresses re-announcement", async () => {
  // A prior run persisted a checkpoint; on re-run we seed `seen` from it.
  const priorParts = [{ type: "text", text: "…", _incremental: true, _checkpoint_keys: ["email:a@b.com"] }];
  const seedSupabase = {
    from(_t: string) {
      return { select: (_c: string) => ({ eq: (_col: string, _v: unknown) => Promise.resolve({ data: [{ parts: priorParts }], error: null }) }) };
    },
  };
  const seen = await loadSeenCheckpoints(seedSupabase, "t1");
  assert(seen.has("email:a@b.com"));

  const sb = fakeSupabase();
  const r = await persistCheckpoint({ supabase: sb.client, threadId: "t1", userId: "u1", seen }, [{ kind: "email", value: "a@b.com", source: null, confidence: 60 }]);
  assertEquals(r.inserted, false, "already-checkpointed finding must not be re-announced on re-run");
  assertEquals(sb.inserts.length, 0);
});

Deno.test("extractCheckpointKeys reads only _incremental parts", () => {
  assertEquals(extractCheckpointKeys([{ type: "text", text: "hi" }]), []);
  assertEquals(extractCheckpointKeys([{ type: "text", _incremental: true, _checkpoint_keys: ["a:1", "b:2"] }]), ["a:1", "b:2"]);
});

// ---- model-context exclusion (finding B) -----------------------------------

Deno.test("isIncrementalMessage identifies checkpoint messages for model-context exclusion", () => {
  assert(isIncrementalMessage({ role: "assistant", parts: [{ type: "text", text: "x", _incremental: true }] }));
  assert(!isIncrementalMessage({ role: "assistant", parts: [{ type: "text", text: "final report" }] }));
  assert(!isIncrementalMessage({ role: "user", parts: [{ type: "text", text: "hi" }] }));
});

// ---- collectStepCheckpoint --------------------------------------------------

Deno.test("collectStepCheckpoint reads only record_artifacts.checkpoint (not accepted)", () => {
  const emissions = collectStepCheckpoint([
    { toolName: "breach_check", output: { ok: true, checkpoint: [{ kind: "email", value: "leak@x.com" }] } },
    { toolName: "record_artifacts", output: { ok: true, accepted: [{ kind: "email", value: "RAW@x.com" }], checkpoint: [{ kind: "email", value: "safe@x.com", source: null, confidence: 60 }] } },
    { toolName: "record_artifacts", output: { ok: false, checkpoint: [{ kind: "name", value: "nope" }] } },
  ]);
  assertEquals(emissions.length, 1);
  assertEquals(emissions[0].value, "safe@x.com");
});

// ---- runtime keep-alive registration ---------------------------------------

Deno.test("runtime keep-alive: registerBackground uses EdgeRuntime.waitUntil when present", async () => {
  const g = globalThis as { EdgeRuntime?: unknown };
  const had = "EdgeRuntime" in g;
  const prev = g.EdgeRuntime;
  let registered: Promise<unknown> | null = null;
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { registered = p; } };
  try {
    const task = Promise.resolve(1);
    const used = registerBackground(task);
    assertEquals(used, true);
    assert(registered === task, "the exact task promise must be handed to waitUntil");
    await task;
  } finally {
    if (had) g.EdgeRuntime = prev;
    else delete g.EdgeRuntime;
  }
});

Deno.test("runtime keep-alive: registerBackground falls back to fire-and-forget when absent", async () => {
  const g = globalThis as { EdgeRuntime?: unknown };
  const had = "EdgeRuntime" in g;
  const prev = g.EdgeRuntime;
  if (had) delete g.EdgeRuntime;
  try {
    const used = registerBackground(Promise.resolve(1));
    assertEquals(used, false);
  } finally {
    if (had) g.EdgeRuntime = prev;
  }
});

Deno.test("withTimeout returns the value when fast, null when slow (run never stalls)", async () => {
  assertEquals(await withTimeout(Promise.resolve("v"), 1000), "v");
  const slow = new Promise<string>((res) => setTimeout(() => res("late"), 50));
  assertEquals(await withTimeout(slow, 1), null);
  await slow; // let the timer settle so the test leaks no ops
});

// ---- concurrent investigations remain isolated ------------------------------

Deno.test("concurrent investigations: per-run seen sets never cross-contaminate", async () => {
  const sb = fakeSupabase();
  const seenA = new Set<string>();
  const seenB = new Set<string>();
  const item: CheckpointEmission[] = [{ kind: "email", value: "shared@x.com", source: null, confidence: 60 }];
  const a = await persistCheckpoint({ supabase: sb.client, threadId: "tA", userId: "uA", seen: seenA }, item);
  const b = await persistCheckpoint({ supabase: sb.client, threadId: "tB", userId: "uB", seen: seenB }, item);
  // Same value, DIFFERENT threads → both announce (no shared dedup state).
  assertEquals(a.inserted, true);
  assertEquals(b.inserted, true);
  assertEquals(sb.inserts.length, 2);
  assertEquals((sb.inserts[0] as { thread_id: string }).thread_id, "tA");
  assertEquals((sb.inserts[1] as { thread_id: string }).thread_id, "tB");
});

// ---- render sanity ----------------------------------------------------------

Deno.test("renderCheckpointText caps the list and reports the remainder", () => {
  const many: CheckpointEmission[] = Array.from({ length: 30 }, (_, i) => ({ kind: "email", value: `u${i}@x.com`, source: null, confidence: 50 }));
  const text = renderCheckpointText(many)!;
  assert(text.includes("recorded 30 new findings"));
  assert(text.includes("…and 5 more"));
  assertEquals(renderCheckpointText([]), null);
});

Deno.test("checkpointKey normalizes kind + value", () => {
  assertEquals(checkpointKey("Email", " A@B.com "), "email:a@b.com");
});
