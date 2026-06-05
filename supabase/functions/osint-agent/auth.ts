/**
 * auth.ts — Request setup: CORS preflight, JWT auth, thread ownership verification,
 * message persistence, and title generation.
 * Extracted from index.ts (lines 1429–1499).
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import type { UIMessage } from "npm:ai@6";
import { corsHeaders, SUPABASE_URL, SERVICE_KEY, SUPABASE_ANON_KEY } from "./env.ts";
import { checkRateLimit as checkRateLimitDistributed, MAX_REQS_PER_MIN, MAX_REQS_PER_HOUR } from "./ratelimit.ts";

export interface SetupContext {
  supabase: ReturnType<typeof createClient>;
  supabaseAdmin: ReturnType<typeof createClient>;
  user: { id: string; [key: string]: unknown };
  userId: string;
  threadId: string;
  archiveEnabled: boolean;
  detectedSeedType: string;
  messages: UIMessage[];
}

/**
 * Handle CORS preflight, authenticate the user, verify thread ownership,
 * persist the user's last message, and generate/refresh thread title.
 *
 * Throws a Response on any failure (401, 403, 400) so the caller can return
 * it directly from the Deno.serve handler.
 */
export async function setupRequest(req: Request): Promise<SetupContext> {
  // ---- CORS preflight --------------------------------------------------------
  if (req.method === "OPTIONS") {
    throw new Response("ok", { headers: corsHeaders });
  }

  // ---- Auth header validation ------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Response(
      JSON.stringify({
        error: "Unauthorized",
        code: "MISSING_AUTH",
        detail: "No Authorization header provided. Sign in to continue.",
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // SECURITY: build the *user-scoped* client with the ANON key + the user's
  // Authorization header so that RLS policies (auth.uid() = user_id) are
  // actually enforced on every .from('threads'|'messages'|'artifacts')
  // call. Previously this client was built with the SERVICE_KEY, which has
  // the Postgres service_role and bypasses RLS — meaning a single missed
  // user_id filter on any of the ~21 .insert() call sites below would
  // leak or mutate another tenant's data.
  //
  // The separate `supabaseAdmin` client (below) keeps the service key
  // for the *narrow* set of writes that intentionally bypass RLS:
  //   - tool_usage_log (telemetry — no user_id column)
  //   - agent_memory (user-scoped via app-layer filter, but uses admin
  //     for write-amplification reasons)
  // If SUPABASE_ANON_KEY is not configured, fail closed: throw a 500 so
  // the orchestrator can be fixed rather than silently running without
  // RLS.
  if (!SUPABASE_ANON_KEY) {
    throw new Response(
      JSON.stringify({
        error: "Service Misconfigured",
        code: "ANON_KEY_MISSING",
        detail:
          "SUPABASE_ANON_KEY is not set in the edge function secrets. " +
          "Set it via `supabase secrets set SUPABASE_ANON_KEY=*** --env production`. " +
          "Using the service key here would bypass RLS and is rejected on purpose.",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  // Server-side admin client (service role, no user JWT) — used for
  // telemetry inserts (tool_usage_log) that intentionally bypass RLS.
  // Without this the wrapper would inherit the user JWT and inserts would
  // fail with "row-level security policy" errors.
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Response(
      JSON.stringify({
        error: "Unauthorized",
        code: "INVALID_SESSION",
        detail: "Session is invalid or expired. Sign in again.",
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const userId = userData.user.id;

  // ---- Per-user rate limit (distributed via Upstash, falls back to
  //      in-memory if Upstash is unset/unreachable — see ratelimit.ts)
  const rl = await checkRateLimitDistributed(userId);
  if (rl.ok === false) {
    throw new Response(
      JSON.stringify({
        error: "Too Many Requests",
        code: "RATE_LIMITED",
        detail: `Slow down — exceeded per-user rate limit (max ${MAX_REQS_PER_MIN}/min, ${MAX_REQS_PER_HOUR}/hour). Retry in ${rl.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  // ---- Parse request body ----------------------------------------------------
  let body: { messages: UIMessage[]; threadId: string };
  try {
    body = (await req.json()) as { messages: UIMessage[]; threadId: string };
  } catch {
    throw new Response(
      JSON.stringify({
        error: "Bad Request",
        code: "MISSING_PARAMS",
        detail: "Request must include threadId and messages array.",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const { messages, threadId } = body;
  if (!threadId || !Array.isArray(messages)) {
    throw new Response(
      JSON.stringify({
        error: "Bad Request",
        code: "MISSING_PARAMS",
        detail: "Request must include threadId and messages array.",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ---- Verify thread ownership ------------------------------------------------
  const { data: thread } = await supabase
    .from("threads")
    .select("id,user_id,archive_attachments,seed_type,seed_value")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread || thread.user_id !== userId) {
    throw new Response(
      JSON.stringify({
        error: "Forbidden",
        code: "THREAD_ACCESS_DENIED",
        detail: "This thread does not exist or does not belong to your account.",
      }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const archiveEnabled: boolean = !!(thread as { archive_attachments?: boolean }).archive_attachments;
  const detectedSeedType: string = String(
    (thread as { seed_type?: string | null }).seed_type ?? "unknown",
  ).toLowerCase();

  // ---- Save user message (last one) ------------------------------------------
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    await supabase.from("messages").insert({
      thread_id: threadId,
      user_id: userId,
      role: "user",
      parts: lastUser.parts as unknown,
    });

    // Generate/refresh title from first user message if thread title is default
    const text = (lastUser.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (text) {
      await supabase
        .from("threads")
        .update({
          title: text.slice(0, 80),
          seed_value: text.slice(0, 200),
          updated_at: new Date().toISOString(),
        })
        .eq("id", threadId)
        .eq("title", "New investigation");
    }
  }

  return {
    supabase,
    supabaseAdmin,
    user: userData.user,
    userId,
    threadId,
    archiveEnabled,
    detectedSeedType,
    messages,
  };
}
