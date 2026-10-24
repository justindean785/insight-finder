import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainSchemaRejection } from "@/lib/tool-outcome";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, selects: [] as string[] }));
vi.mock("@/integrations/supabase/client", () => {
  const chain = {
    select: (cols: string) => { m.selects.push(cols); return chain; },
    eq: () => chain,
    order: () => {
      const cols = (m.selects[m.selects.length - 1] ?? "").split(",").map((c) => c.trim());
      const data = m.rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      return Promise.resolve({ data, error: null });
    },
  };
  const ch = { on: () => ch, subscribe: () => ch };
  return { supabase: { from: () => chain, channel: () => ch, removeChannel: () => Promise.resolve() } };
});

import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";

const RAW = "input rejected by schema: entries (invalid_type) [expected array, received undefined]";

describe("explainSchemaRejection", () => {
  it("names a missing field in plain language and keeps the raw text for Details", () => {
    const r = explainSchemaRejection("memory_save", RAW)!;
    expect(r.summary).toMatch(/memory_save was malformed — it left out “entries”/);
    expect(r.summary).toMatch(/not a provider fault/);
    expect(r.summary).not.toMatch(/invalid_type|received undefined/);
    expect(r.detail).toBe(RAW);
  });

  it("separates missing from wrong-form fields across several issues", () => {
    const r = explainSchemaRejection("memory_save", "input rejected by schema: entries.0.content (invalid_type) [expected string, received undefined], kind (invalid_enum_value)")!;
    expect(r.summary).toMatch(/left out “entries.0.content” and sent “kind” in the wrong form/);
  });

  it("leaves every other message alone", () => {
    expect(explainSchemaRejection("x", "upstream returned HTTP 403")).toBeNull();
    expect(explainSchemaRejection("x", null)).toBeNull();
  });
});

describe("Tools health: a schema rejection reads as a plain-language error with the raw text under Details", () => {
  it("renders the headline, hides the raw zod text until Details is opened", () => {
    m.rows = [{ tool_name: "memory_save", outcome: "failed", ok: false, error_msg: RAW, status_code: null, cached: false, created_at: "2026-10-24T14:22:28Z" }];
    render(<ToolHealthPanel threadId="t1" />);
    return screen.findAllByText(/left out “entries”/).then((hits) => {
      expect(hits.length).toBeGreaterThan(0);
      const details = document.querySelector("details")!;
      expect(details.querySelector("summary")!.textContent).toBe("Details");
      expect(details.querySelector("code")!.textContent).toBe(RAW);
      // The raw text is not part of the visible headline.
      const headline = hits[0].cloneNode(true) as HTMLElement;
      headline.querySelector("details")?.remove();
      expect(headline.textContent).not.toMatch(/invalid_type/);
    });
  });
});
