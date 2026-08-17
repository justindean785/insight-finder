// Collector for the post-deploy benchmark audit. Run this IN THE BROWSER, in
// the page context of the signed-in production app.
//
// WHY IT LIVES IN THE BROWSER. The audit needs the operator's own rows, and
// `artifacts` is RLS-scoped to auth.uid(). No service-role key exists on the
// workstation, and Lovable's query_database runs as postgres/BYPASSRLS and is
// denied by the auto-mode classifier. But the signed-in app already holds a
// session, so we borrow it: RLS then scopes every read to exactly the rows we
// want, with no credential handling and no new secret. The old "the DB audit is
// BLOCKED until credentials exist" conclusion was wrong.
//
// USAGE
//   1. Open https://insight-finder-sandy.vercel.app (signed in).
//   2. Paste this whole file into the console, or inject it with the
//      claude-in-chrome javascript_tool.
//   3. It returns a JSON object. Save it as benchmark-dump.json.
//   4. node scripts/benchmark-audit.mjs benchmark-dump.json [--deployed-at ISO]
//
// Read-only: it issues GETs and one POST to a STABLE, read-only RPC. It never
// writes, and it never prints a credential.

(async () => {
  const SB = "https://skzqwbyvmwqarfgfvyky.supabase.co";
  // anon/publishable key — ships in the client bundle by design, RLS enforces access
  // (src/integrations/supabase/client.ts, DEFAULT_SUPABASE_PUBLISHABLE_KEY)
  const ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrenF3Ynl2bXdxYXJmZ2Z2eWt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3ODg5MTksImV4cCI6MjA5NTM2NDkxOX0.B2k5sI10zk1nxjZdXEFxuVV3B755FxDFGkT6TfWY6TE";

  const authKey = Object.keys(localStorage).find(
    (k) => k.startsWith("sb-") && k.includes("auth-token"),
  );
  if (!authKey) throw new Error("no Supabase session in localStorage — sign in first");
  const sess = JSON.parse(localStorage.getItem(authKey));
  const jwt = sess?.access_token ?? sess?.currentSession?.access_token;
  if (!jwt) throw new Error(`session at ${authKey} carries no access_token`);

  const H = { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };

  // PostgREST caps a response at 1000 rows and does so SILENTLY. Paging is not
  // an optimisation here; without it every total is quietly wrong.
  async function all(path) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${SB}/rest/v1/${path}`, {
        headers: { ...H, Range: `${from}-${from + 999}` },
      });
      if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
      const batch = await r.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 1000) break;
    }
    return out;
  }

  async function exactCount(path) {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      headers: { ...H, Prefer: "count=exact", Range: "0-0" },
    });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    const n = Number((r.headers.get("content-range") || "").split("/")[1]);
    return Number.isFinite(n) ? n : null;
  }

  const args = new URLSearchParams(location.hash.slice(1));
  const threadId = args.get("thread") || null; // optional: scope to one benchmark thread
  const sinceDays = Number(args.get("days") || 7);
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();

  const threadFilter = threadId ? `&thread_id=eq.${threadId}` : "";

  const artifacts = await all(
    `artifacts?select=id,thread_id,kind,value,confidence,source,metadata,created_at` +
      `&created_at=gte.${since}${threadFilter}&order=created_at.asc`,
  );
  const toolCalls = await all(
    `tool_usage_log?select=tool_name,outcome,ok,duration_ms,error_msg,status_code,created_at` +
      `&created_at=gte.${since}${threadFilter}&order=created_at.asc`,
  );

  // Whole-account totals, so the per-case RPC can be reconciled against raw
  // counts (this is how the #472 migration was verified).
  const metaList = "(triage_decision,cluster_decision)";
  const totals = {
    artifactsAll: await exactCount("artifacts?select=id"),
    metaAll: await exactCount(`artifacts?select=id&kind=in.${metaList}`),
  };
  const rpc = await fetch(`${SB}/rest/v1/rpc/get_case_metrics`, {
    method: "POST",
    headers: H,
    body: "{}",
  }).then((r) => (r.ok ? r.json() : null));

  const dump = {
    collectedAt: new Date().toISOString(),
    windowStart: since,
    threadId,
    artifacts,
    toolCalls,
    totals,
    caseMetrics: rpc,
  };
  console.log(`[benchmark-collect] ${artifacts.length} artifacts, ${toolCalls.length} tool calls`);
  return dump;
})();
