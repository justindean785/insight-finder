/**
 * The open-case stale-run sweep (ChatWindow): ask osint-agent to run its
 * maintenance pass (`?health=1&maintenance=1`) AS THE SIGNED-IN USER.
 *
 * Why the token: the maintenance pass runs stale-run recovery with the service
 * role. Until the edge refuses anonymous callers it runs for every user, which
 * means anyone on the internet can trigger it. The edge lockdown scopes a
 * token-bearing call to that user's own threads and answers an anonymous one
 * with liveness only. Sending the token first is what keeps open-case recovery
 * working once the edge stops honouring anonymous maintenance; today's edge
 * ignores the header, so this is safe to ship ahead of it.
 *
 * The token travels in the Authorization header only, never in the URL (URLs
 * are logged). No session ⇒ no request: an anonymous sweep would do nothing
 * after the lockdown, and there is no stuck run of ours to reap without a user.
 *
 * The response is deliberately not read: this is a trigger, and the recovered
 * report reaches the page through the realtime subscriptions.
 */
export const MAINTENANCE_SWEEP_QUERY = "?health=1&maintenance=1";

export type SweepOutcome = "sent" | "skipped_no_session" | "skipped_no_url";

export async function sendMaintenanceSweep(
  functionsUrl: string | null | undefined,
  getAccessToken: () => Promise<string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<SweepOutcome> {
  if (!functionsUrl) return "skipped_no_url";
  let token: string | null | undefined = null;
  try {
    token = await getAccessToken();
  } catch {
    token = null;
  }
  if (!token) return "skipped_no_session";
  void fetchImpl(`${functionsUrl}${MAINTENANCE_SWEEP_QUERY}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
  return "sent";
}
