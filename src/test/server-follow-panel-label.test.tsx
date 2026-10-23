import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ServerFollowPanel } from "@/components/chat/ServerFollowPanel";
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
