#!/usr/bin/env node
/**
 * Snapshot ONE real investigation out of Supabase into a harness fixture, so the
 * UI harness renders production data instead of invented rows.
 *
 *   SUPABASE_EMAIL=… SUPABASE_PASSWORD=… node scripts/harness-snapshot.mjs [threadId]
 *
 * Writes src/dev/fixtures.json (gitignored — it contains real case data and must
 * never be committed). Credentials are read from the environment only; nothing
 * is written to disk but the fixture, and the access token is kept in memory.
 *
 * Why this exists: the workspace cannot be reviewed without data, and inventing
 * data hides exactly the bugs that only real distributions expose (empty values,
 * absent confidence, 40-source artifacts, provider error strings).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = readFileSync(resolve(ROOT, "src/integrations/supabase/client.ts"), "utf8");
const URL_BASE = client.match(/DEFAULT_SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
const ANON = client.match(/(eyJ[A-Za-z0-9._-]+)/)?.[1];
if (!URL_BASE || !ANON) throw new Error("could not read Supabase URL/anon key from client.ts");

/**
 * Auth. Prefer an existing access token (`SUPABASE_ACCESS_TOKEN`) so a password
 * never has to appear in a shell command or process list; fall back to an
 * email/password grant when only those are available.
 */
async function authenticate() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (token) {
    const r = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`SUPABASE_ACCESS_TOKEN rejected: ${r.status}`);
    return { access_token: token, user: await r.json() };
  }
  const email = process.env.SUPABASE_EMAIL;
  const password = process.env.SUPABASE_PASSWORD;
  if (!email || !password) throw new Error("set SUPABASE_ACCESS_TOKEN, or SUPABASE_EMAIL + SUPABASE_PASSWORD");
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`auth failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const auth = await authenticate();
const H = { apikey: ANON, Authorization: `Bearer ${auth.access_token}` };

const get = async (path) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

// Default: the thread with the most artifacts — the densest real workspace, and
// the one most likely to expose layout and truncation defects.
let threadId = process.argv[2];
if (!threadId) {
  const rows = await get("artifacts?select=thread_id&limit=20000");
  const counts = new Map();
  for (const r of rows) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
  threadId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const eq = `thread_id=eq.${threadId}`;
const [threads, artifacts, messages, tools, evidence, reviews, credits] = await Promise.all([
  get(`threads?select=*&id=eq.${threadId}`),
  get(`artifacts?select=*&${eq}&order=created_at.asc&limit=2000`),
  get(`messages?select=*&${eq}&order=created_at.asc&limit=2000`),
  get(`tool_usage_log?select=*&${eq}&order=created_at.asc&limit=2000`),
  get(`evidence_log?select=*&${eq}&order=created_at.asc&limit=2000`),
  get(`artifact_reviews?select=*&${eq}&limit=2000`),
  get(`user_credits?select=*&limit=1`),
]);

// Every thread, so the sidebar/cases list renders at real length (276 today).
const allThreads = await get("threads?select=*&order=updated_at.desc&limit=500");

const snapshot = {
  capturedAt: new Date().toISOString(),
  threadId,
  tables: {
    threads: allThreads,
    thread: threads,
    artifacts,
    messages,
    tool_usage_log: tools,
    evidence_log: evidence,
    artifact_reviews: reviews,
    user_credits: credits,
    agent_memory: [],
    investigation_cache: [],
    client_errors: [],
  },
  user: { id: auth.user.id, email: auth.user.email },
};

writeFileSync(resolve(ROOT, "src/dev/fixtures.json"), JSON.stringify(snapshot, null, 1));
console.log(
  `snapshot → src/dev/fixtures.json\n` +
    `  thread        ${threadId}\n` +
    `  artifacts     ${artifacts.length}\n` +
    `  messages      ${messages.length}\n` +
    `  tool calls    ${tools.length} (${tools.filter((t) => t.ok === false).length} failed)\n` +
    `  evidence log  ${evidence.length}\n` +
    `  reviews       ${reviews.length}\n` +
    `  all threads   ${allThreads.length}`,
);
