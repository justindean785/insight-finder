import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION,
  LEAKCHECK_DEFAULT_QUOTA_RESERVE,
  leakcheckGuard,
  readLeakcheckQuota,
  resolveLeakcheckLimits,
} from "./leakcheck-guard.ts";

const L = { maxPerInvestigation: 3, quotaReserve: 20 };

Deno.test("leakcheck guard: under the cap with plenty of quota is allowed", () => {
  assertEquals(leakcheckGuard(0, 180, L), { allow: true });
  assertEquals(leakcheckGuard(2, 100, L), { allow: true });
});

Deno.test("leakcheck guard: the per-investigation cap blocks the next call, not the last allowed one", () => {
  assertEquals(leakcheckGuard(2, null, L).allow, true);
  const d = leakcheckGuard(3, null, L);
  assert(!d.allow && d.code === "investigation_cap");
});

Deno.test("leakcheck guard: at or under the reserve blocks, one above does not", () => {
  assertEquals(leakcheckGuard(0, 21, L).allow, true);
  const d = leakcheckGuard(0, 20, L);
  assert(!d.allow && d.code === "quota_reserve");
  assert(!leakcheckGuard(0, 0, L).allow);
});

Deno.test("leakcheck guard: the quota reserve wins when both limits are hit", () => {
  const d = leakcheckGuard(5, 3, L);
  assert(!d.allow && d.code === "quota_reserve");
});

Deno.test("leakcheck guard fails OPEN: an unreadable count and an unknown quota never block", () => {
  assertEquals(leakcheckGuard(null, null, L), { allow: true });
  assertEquals(leakcheckGuard(null, 150, L), { allow: true });
  assertEquals(leakcheckGuard(1, Number.NaN, L), { allow: true });
});

Deno.test("leakcheck limits: defaults, overrides, and malformed values fall back", () => {
  assertEquals(resolveLeakcheckLimits(), {
    maxPerInvestigation: LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION,
    quotaReserve: LEAKCHECK_DEFAULT_QUOTA_RESERVE,
  });
  assertEquals(resolveLeakcheckLimits("5", "50"), { maxPerInvestigation: 5, quotaReserve: 50 });
  // A reserve of 0 is a deliberate "spend it all"; a cap of 0 is not meaningful and falls back.
  assertEquals(resolveLeakcheckLimits("0", "0"), { maxPerInvestigation: LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION, quotaReserve: 0 });
  for (const bad of ["abc", "-2", "1.5", "", "  ", "NaN"]) {
    assertEquals(resolveLeakcheckLimits(bad, bad), {
      maxPerInvestigation: LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION,
      quotaReserve: LEAKCHECK_DEFAULT_QUOTA_RESERVE,
    });
  }
});

Deno.test("readLeakcheckQuota: only a finite non-negative number counts", () => {
  assertEquals(readLeakcheckQuota({ quota: 187, found: 1 }), 187);
  assertEquals(readLeakcheckQuota({ quota: 0 }), 0);
  for (const bad of [{ quota: "187" }, { quota: -1 }, { quota: NaN }, {}, null, undefined, "x"]) {
    assertEquals(readLeakcheckQuota(bad), null);
  }
});
