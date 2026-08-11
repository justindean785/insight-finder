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
    const [thread, messages, artifacts] = await Promise.all([
      sb.from("threads").select("*").eq("id", thread_id).eq("user_id", ctx.getUserId()).maybeSingle(),
      sb.from("messages").select("*").eq("thread_id", thread_id).order("created_at", { ascending: true }).limit(message_limit),
      sb.from("artifacts").select("*").eq("thread_id", thread_id).order("created_at", { ascending: false }).limit(artifact_limit),
    ]);
    if (thread.error) return { content: [{ type: "text", text: thread.error.message }], isError: true };
    if (!thread.data) return { content: [{ type: "text", text: "Investigation not found" }], isError: true };
    const payload = { thread: thread.data, messages: messages.data ?? [], artifacts: artifacts.data ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});