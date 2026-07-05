#!/usr/bin/env node
/**
 * Live production smoke scan — signs up (or signs in), creates a thread,
 * streams osint-agent, reports success/failure + artifact count.
 *
 * Usage: node scripts/live-scan.mjs [seed]
 * Default seed: example.com
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

const SUPABASE_URL = "https://skzqwbyvmwqarfgfvyky.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrenF3Ynl2bXdxYXJmZ2Z2eWt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3ODg5MTksImV4cCI6MjA5NTM2NDkxOX0.B2k5sI10zk1nxjZdXEFxuVV3B755FxDFGkT6TfWY6TE";
const AGENT_URL = `${SUPABASE_URL}/functions/v1/osint-agent`;

const seed = (process.argv[2] ?? "example.com").trim();
const tag = randomBytes(4).toString("hex");
const email = `live_scan_${tag}@gmail.com`;
const password = `LiveScan!${tag}Aa1`;

const supabase = createClient(SUPABASE_URL, ANON_KEY);

function log(...args) {
  console.log(`[live-scan]`, ...args);
}

async function auth() {
  log("signing up", email);
  const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({ email, password });
  if (signUpErr) log("signup note:", signUpErr.message);

  if (signUpData.session) return signUpData.session;

  log("signing in…");
  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`auth failed: ${signInErr.message}`);
  if (!signInData.session) throw new Error("no session after sign-in (email confirmation may be required)");
  return signInData.session;
}

async function streamScan(session, threadId, prompt) {
  const body = {
    threadId,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ],
  };

  const res = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");

  const dec = new TextDecoder();
  let buf = "";
  let chunks = 0;
  let sawError = false;
  let errorSnippet = "";
  let sawFinish = false;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    chunks++;

    if (/Forbidden|out of credits|over quota|INSUFFICIENT_CREDITS|Provider returned error/i.test(buf)) {
      sawError = true;
      const m = buf.match(/data: (\{.*"error".*\})/);
      errorSnippet = m?.[1]?.slice(0, 300) ?? buf.slice(-400);
    }
    if (/finishReason|data: \[DONE\]|type":"finish"/i.test(buf)) sawFinish = true;
  }

  return { chunks, sawError, errorSnippet, tail: buf.slice(-800), sawFinish };
}

async function main() {
  log("seed:", seed);
  const session = await auth();
  log("authenticated as", session.user?.id);

  const { data: thread, error: threadErr } = await supabase
    .from("threads")
    .insert({ user_id: session.user.id, title: "New investigation" })
    .select("id")
    .single();
  if (threadErr) throw new Error(`thread create: ${threadErr.message}`);
  const threadId = thread.id;
  log("thread", threadId);

  const prompt = seed.includes("@")
    ? `Investigate email: ${seed}`
    : seed.includes(".") && !seed.includes(" ")
      ? `Investigate domain: ${seed}`
      : `Investigate: ${seed}`;

  log("streaming investigation… (up to 3 min)");
  const stream = await streamScan(session, threadId, prompt);
  log("stream chunks:", stream.chunks, "finish:", stream.sawFinish);

  // Give waitUntil / DB writes a moment
  await new Promise((r) => setTimeout(r, 5000));

  const { data: artifacts, error: artErr } = await supabase
    .from("artifacts")
    .select("id,kind,value,confidence,source")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(15);
  if (artErr) log("artifacts read error:", artErr.message);

  const { data: threadRow } = await supabase
    .from("threads")
    .select("title,seed_type,seed_value,status")
    .eq("id", threadId)
    .maybeSingle();

  const { data: msgs } = await supabase
    .from("messages")
    .select("role,parts")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(5);

  const failMsg = (msgs ?? []).find((m) => {
    const parts = m.parts;
    if (!Array.isArray(parts)) return false;
    return parts.some((p) => p?.type === "text" && String(p.text ?? "").includes("Investigation run failed"));
  });

  const result = {
    ok: !failMsg && !stream.sawError && (artifacts?.length ?? 0) > 0,
    seed,
    threadId,
    email,
    thread: threadRow,
    artifactCount: artifacts?.length ?? 0,
    sampleArtifacts: (artifacts ?? []).slice(0, 8).map((a) => ({ kind: a.kind, value: String(a.value).slice(0, 80), source: a.source, confidence: a.confidence })),
    streamError: stream.sawError ? stream.errorSnippet || stream.tail : null,
    failedMessage: failMsg
      ? String((failMsg.parts ?? []).find((p) => p?.type === "text")?.text ?? "").slice(0, 400)
      : null,
  };

  console.log("\n=== LIVE SCAN RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[live-scan] FATAL:", e.message ?? e);
  process.exit(2);
});
