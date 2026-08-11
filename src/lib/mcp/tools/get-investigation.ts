import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function client(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_investigation",
  title: "Get investigation",
  description:
    "Fetch a single Swarmbot investigation thread with its messages and artifacts for the signed-in analyst.",
  inputSchema: {
    thread_id: z.string().uuid().describe("Investigation thread UUID."),
    message_limit: z.number().int().min(1).max(200).default(50),
    artifact_limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ thread_id, message_limit, artifact_limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const sb = client(ctx);

    // Ownership must SETTLE before any subordinate read is issued. This used to
    // be one Promise.all over all three queries, which meant messages and
    // artifacts were already in flight before the ownership result existed.
    // RLS still blocked cross-user rows, so that was not a demonstrated
    // isolation bug — but it made the application-level guard decorative, and
    // left RLS as the sole control while the code read as though it were
    // defence in depth. Serializing gives the check the semantics it implies.
    const thread = await sb
      .from("threads")
      .select("*")
      .eq("id", thread_id)
      .eq("user_id", ctx.getUserId())
      .maybeSingle();
    if (thread.error) return { content: [{ type: "text", text: thread.error.message }], isError: true };
    if (!thread.data) return { content: [{ type: "text", text: "Investigation not found" }], isError: true };

    // Both reads are subordinate to a settled ownership check, so they may
    // still run concurrently with each other.
    const [messages, artifacts] = await Promise.all([
      sb.from("messages").select("*").eq("thread_id", thread_id).order("created_at", { ascending: true }).limit(message_limit),
      sb.from("artifacts").select("*").eq("thread_id", thread_id).order("created_at", { ascending: false }).limit(artifact_limit),
    ]);
    const payload = { thread: thread.data, messages: messages.data ?? [], artifacts: artifacts.data ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});