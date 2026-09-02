import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisTab } from "@/components/panel/AnalysisTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
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
  // `evidence_log` is the only table whose ordering column was wrong; the other
  // three genuinely have `created_at`/`updated_at`, so they are pinned too and
  // this test fails if a future edit "fixes" them by mistake.
  rows: {
    artifacts: [] as unknown[],
    tool_usage_log: [] as unknown[],
    threads: [] as unknown[],
    evidence_log: [{ artifact_id: "a1" }],
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
        select: () => query,
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
  // Let the useEffect's Promise.all settle.
  await act(async () => { await Promise.resolve(); });
  return host;
}

beforeEach(() => {
  mock.orderCalls.length = 0;
});

afterEach(() => {
  act(() => { roots.splice(0).forEach((r) => r.unmount()); });
  document.body.innerHTML = "";
});

describe("AnalysisTab evidence_log ordering", () => {
  it("orders evidence_log by collected_at, descending", async () => {
    await render();

    const call = mock.orderCalls.find((c) => c.table === "evidence_log");
    expect(call, "AnalysisTab never queried evidence_log").toBeDefined();
    expect(call!.column).toBe("collected_at");
    expect(call!.options).toEqual({ ascending: false });
  });

  it("never orders evidence_log by created_at — the column does not exist", async () => {
    await render();

    const bad = mock.orderCalls.filter(
      (c) => c.table === "evidence_log" && c.column === "created_at",
    );
    expect(bad).toHaveLength(0);
  });

  it("leaves the other three queries on their real columns", async () => {
    await render();

    const columnFor = (table: string) =>
      mock.orderCalls.find((c) => c.table === table)?.column;

    expect(columnFor("artifacts")).toBe("created_at");
    expect(columnFor("tool_usage_log")).toBe("created_at");
    expect(columnFor("threads")).toBe("updated_at");
  });

  it("renders without the error state once every column is valid", async () => {
    const host = await render();

    // The shared Promise.all rethrows on any query error, so a bad column
    // surfaces as the tab-wide error banner rather than a missing tile.
    expect(host.textContent).not.toContain("Could not load");
  });
});
