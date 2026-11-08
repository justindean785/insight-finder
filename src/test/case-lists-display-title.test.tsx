import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * HomeHub's "Recent cases" and Insights' "Top cases" printed the raw stored `title`.
 * For a case started from an upload that is the first 80 characters of the composer's
 * "Attached files:" markdown, so both lists showed `Attached files: - [scan-notes.pdf](https://…`.
 * CasesPage, the sidebar and the palette already go through `threadDisplayTitle`.
 * Values are synthetic.
 */

const SEED =
  "Attached files:\n- [scan-notes.pdf](https://proj.storage.example/storage/v1/object/sign/attachments/u1/c1/scan-notes.pdf?token=SYNTHETICTOKEN123) (application/pdf, 40 KB)";
const STORED_TITLE = SEED.slice(0, 80); // what the edge/client writes: formatThreadTitle → slice(0, 80)
const NOW = "2026-11-07T00:00:00Z";

// Stable identity: HomeHub's effect depends on `user`, so a new object per render would reload forever.
const USER = { id: "u1" };
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: USER, loading: false }) }));

// HomeHub: the recent-cases read returns whatever columns the page asked for.
const threadRows = [
  { id: "t1", title: STORED_TITLE, seed_value: SEED, updated_at: NOW },
  { id: "t2", title: "Email: subject@mail.example", seed_value: "subject@mail.example", updated_at: NOW },
];
vi.mock("@/integrations/supabase/client", () => {
  type CountResult = { count: number; data: null; error: null };
  interface CountChain extends PromiseLike<CountResult> { eq(): CountChain; not(): CountChain }
  interface RecentChain { eq(): RecentChain; order(): RecentChain; limit(): Promise<{ data: typeof threadRows; error: null }> }
  const countChain: CountChain = {
    eq: () => countChain,
    not: () => countChain,
    then: (res, rej) => Promise.resolve<CountResult>({ count: 2, data: null, error: null }).then(res, rej),
  };
  const recentChain: RecentChain = {
    eq: () => recentChain,
    order: () => recentChain,
    limit: () => Promise.resolve({ data: threadRows, error: null }),
  };
  return {
    supabase: {
      from: () => ({
        select: (_cols: string, opts?: { head?: boolean }) => (opts?.head ? countChain : recentChain),
      }),
    },
  };
});

vi.mock("@/hooks/useInsightsData", () => ({
  useInsightsData: () => ({
    loading: false, error: null,
    data: {
      summary: {
        kind_counts: [], source_counts: [], day_counts: [], conf_buckets: {}, avg_confidence: 0, tool_counts: [], tool_calls_total: 0,
        top_cases: [
          { thread_id: "t1", title: STORED_TITLE, artifact_count: 3, last_at: NOW },
          { thread_id: "t2", title: "Email: subject@mail.example", artifact_count: 5, last_at: NOW },
        ],
      },
      memoryCount: 0, memoryCountError: null, caseCountExact: 2, artifactCountExact: 8, toolSummaries: [], toolCallsTotal: 0,
    },
  }),
}));

import HomeHub from "@/pages/HomeHub";
import { InsightsOverview } from "@/pages/Insights";

describe("case lists name an upload-only case by its file", () => {
  it("HomeHub recent cases", async () => {
    render(<MemoryRouter><HomeHub /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Email: subject@mail.example")).toBeTruthy()); // control rendered
    expect(screen.getByText("Attachment: scan-notes.pdf")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Attached files:");
  });

  it("Insights top cases", async () => {
    render(<MemoryRouter><InsightsOverview /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Email: subject@mail.example")).toBeTruthy());
    expect(screen.getByText("Attachment: scan-notes.pdf")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Attached files:");
  });
});
