import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ServerFollowPanel, VISIBLE_ROWS } from "@/components/chat/ServerFollowPanel";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

/**
 * The panel lists the CURRENT run's calls (`currentRunEvents`, since
 * run_started_at); the case bar counts every run of the case. Production
 * 2026-10-21: the panel read "1 call recorded" under a case bar reading
 * "15 tools", which looked like a contradiction. The panel now says "this run".
 */

afterEach(cleanup);

const ev = (i: number): ToolEvent =>
  ({ id: `e${i}`, toolName: "dns_records", displayName: "Recon — DNS records", status: "succeeded", at: `2026-10-21T05:4${i}:00Z`, durationMs: 400 } as unknown as ToolEvent);

describe("ServerFollowPanel — the count names its scope", () => {
  it("says the calls are this run's", () => {
    render(<ServerFollowPanel active events={[ev(1), ev(2), ev(3)]} />);
    const region = screen.getByRole("region", { name: "Live from the server" });
    expect(region).toHaveTextContent("3 calls this run");
    expect(region).not.toHaveTextContent(/calls recorded/);
  });

  it("singular", () => {
    render(<ServerFollowPanel active events={[ev(1)]} />);
    expect(screen.getByRole("region", { name: "Live from the server" })).toHaveTextContent("1 call this run");
  });

  it("explains in the body that the case bar counts every run", () => {
    render(<ServerFollowPanel active events={[ev(1)]} />);
    expect(screen.getByRole("region", { name: "Live from the server" })).toHaveTextContent(/case bar counts every run/i);
  });
});

/**
 * Production 2026-10-31: a following tab showed every recorded call of the run as
 * a 21-row wall under the agent's text. The newest few stay visible; the rest open
 * on request. The header count is unchanged, so nothing is hidden from the number.
 */
describe("ServerFollowPanel — newest calls visible, the rest behind a toggle", () => {
  it(`shows only the latest ${VISIBLE_ROWS} rows by default and offers the rest`, () => {
    const events = Array.from({ length: 9 }, (_, i) => ev(i));
    render(<ServerFollowPanel active events={events} />);
    const latest = screen.getByRole("list", { name: "Latest calls" });
    expect(latest.querySelectorAll("li")).toHaveLength(VISIBLE_ROWS);
    expect(screen.getByRole("region", { name: "Live from the server" })).toHaveTextContent("9 calls this run");
    expect(screen.getByText(/Show 6 earlier calls/)).toBeInTheDocument();
    // the earlier list exists in the DOM (closed <details>) and holds exactly the remainder
    expect(screen.getByRole("list", { name: "Earlier calls", hidden: true }).querySelectorAll("li")).toHaveLength(6);
  });

  it("renders no toggle when the run has at most the visible number of calls", () => {
    render(<ServerFollowPanel active events={[ev(1), ev(2)]} />);
    expect(screen.queryByText(/earlier call/)).toBeNull();
    expect(screen.getByRole("list", { name: "Latest calls" }).querySelectorAll("li")).toHaveLength(2);
  });

  it("keeps the newest calls, not the oldest, in the visible list", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      ({ ...ev(i), displayName: `Call number ${i}` } as ToolEvent));
    render(<ServerFollowPanel active events={events} />);
    const latest = screen.getByRole("list", { name: "Latest calls" });
    expect(latest).toHaveTextContent("Call number 4");
    expect(latest).not.toHaveTextContent("Call number 0");
  });
});
