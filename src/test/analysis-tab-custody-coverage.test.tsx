import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisTab } from "@/components/panel/AnalysisTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * The chain-of-custody tile must count covered ARTIFACTS, not distinct
 * artifact_ids: every evidence_log row in production has artifact_id NULL, so the
 * old count was always 1. Built from the ordering test's harness.
 *
 * (Harness notes from the ordering test follow.)
 * Regression cover for the `evidence_log` ordering column.
 *
 * `AnalysisTab` ordered `evidence_log` by `created_at`, a column that does not
 * exist on that table (its timestamp is `collected_at`; the other ordering key
 * is `seq`). PostgREST answers an unknown ORDER BY column with 400, and because
 * all four queries share one `Promise.all` whose `failed` check RE-THROWS, the
 * single bad column took down the entire Intelligence tab — not just the
 * chain-of-custody tile it feeds.
 *
 * This test DRIVES the component and observes the real `.order()` argument.
 * Asserting instead that the generated `evidence_log` row type contains
 * `collected_at` would pass with the bug still in place, because the type has
 * always been right — it was the call site that was wrong.
 */

type OrderCall = { table: string; column: string; options: unknown };

const mock = vi.hoisted(() => ({
  orderCalls: [] as OrderCall[],
  selects: {} as Record<string, string>,
  // `evidence_log` is the only table whose ordering column was wrong; the other
  // three genuinely have `created_at`/`updated_at`, so they are pinned too and
  // this test fails if a future edit "fixes" them by mistake.
  rows: {
    artifacts: [
      { id: "a1", thread_id: "t1", kind: "email", value: "j@example.com", confidence: 70, source: "x", metadata: {} },
      { id: "a2", thread_id: "t1", kind: "domain", value: "example.com", confidence: 70, source: "x", metadata: {} },
      { id: "a3", thread_id: "t1", kind: "phone", value: "+15550100", confidence: 70, source: "x", metadata: {} },
    ] as unknown[],
    tool_usage_log: [] as unknown[],
    threads: [] as unknown[],
    // Production shape: artifact_id is NULL on every row.
    evidence_log: [
      { artifact_id: null, thread_id: "t1", kind: "email", value: "j@example.com" },
      { artifact_id: null, thread_id: "t1", kind: "domain", value: "example.com" },
    ],
  } as Record<string, unknown[]>,
}));

// The identity must be STABLE. AnalysisTab's effect depends on [user, reloadKey];
// returning a fresh object each render re-fires the effect forever and the test
// times out instead of asserting. (It did, before this was hoisted.)
const authUser = { id: "u1" };
const authValue = { user: authUser };
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => authValue,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      const query = {
        select: (cols: string) => { mock.selects[table] = cols; return query; },
        order: (column: string, options: unknown) => {
          mock.orderCalls.push({ table, column, options });
          return query;
        },
        limit: () => Promise.resolve({ data: mock.rows[table] ?? [], error: null }),
      };
      return query;
    },
  },
}));

const roots: Root[] = [];

async function render() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<AnalysisTab />);
  });
  await act(async () => { await Promise.resolve(); });
  return host;
}

afterEach(() => {
  act(() => { roots.splice(0).forEach((r) => r.unmount()); });
  document.body.innerHTML = "";
});

describe("AnalysisTab chain-of-custody coverage", () => {
  it("counts artifacts matched by thread, kind and value when artifact_id is NULL", async () => {
    const host = await render();
    expect(host.textContent).toContain("Chain-of-custody coverage");
    expect(host.textContent).toContain("2/3");
  });

  it("asks evidence_log for the columns the match needs", async () => {
    await render();
    expect(mock.selects.evidence_log).toBe("artifact_id,thread_id,kind,value");
    expect(mock.selects.artifacts).toContain("value");
  });
});
