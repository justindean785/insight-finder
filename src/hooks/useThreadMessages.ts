import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type MessageSummary = {
  id: string;
  role: "user" | "assistant";
  created_at: string;
  /** Top-level summary of what this message contains */
  summary: string;
  /** Tool calls extracted from assistant message parts */
  toolCalls: Array<{
    toolName: string;
    args?: unknown;
    resultSummary?: string;
    startedAt?: string;
  }>;
};

/**
 * Fetch message summaries for a thread. Returns lightweight summaries
 * suitable for timeline enrichment — not the full AI SDK message parts.
 */
export function useThreadMessages(threadId: string): MessageSummary[] {
  const [messages, setMessages] = useState<MessageSummary[]>([]);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;

    supabase
      .from("messages")
      .select("id, role, parts, created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        const summaries: MessageSummary[] = data.map((msg: any) => {
          const parts = Array.isArray(msg.parts) ? msg.parts : [];
          const toolCalls: MessageSummary["toolCalls"] = [];

          let textSummary = "";
          for (const part of parts) {
            // Extract text content
            if (part?.type === "text" && typeof part.text === "string") {
              textSummary = part.text.slice(0, 120);
            }
            // Extract tool invocations
            if (part?.type === "tool-invocation") {
              const inv = part.toolInvocation ?? part;
              const resultPart = parts.find(
                (p: any) =>
                  p?.type === "tool-result" &&
                  p?.toolCallId === inv?.toolCallId
              );
              const resultOk =
                resultPart?.output &&
                typeof resultPart.output === "object" &&
                (resultPart.output as any)?.ok === true;
              const resultError =
                resultPart?.output &&
                typeof resultPart.output === "object" &&
                "error" in (resultPart.output as any);

              toolCalls.push({
                toolName: inv?.toolName ?? "unknown",
                args: inv?.args,
                resultSummary: resultOk
                  ? "completed"
                  : resultError
                  ? "failed"
                  : resultPart
                  ? "returned"
                  : undefined,
                startedAt: msg.created_at,
              });
            }
            // Extract tool results
            if (part?.type === "tool-result" && typeof part.output === "object") {
              const out = part.output as any;
              if (out?.data?.report_markdown || out?.data?.final_report) {
                textSummary = "Report generated";
              }
            }
          }

          // For user messages, use the text content
          if (msg.role === "user" && !textSummary) {
            textSummary = parts
              .filter((p: any) => p?.type === "text")
              .map((p: any) => p.text)
              .join(" ")
              .slice(0, 120);
          }

          return {
            id: msg.id,
            role: msg.role as "user" | "assistant",
            created_at: msg.created_at,
            summary: textSummary || `[${msg.role} message]`,
            toolCalls,
          };
        });

        setMessages(summaries);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return messages;
}
