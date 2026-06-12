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

/** Subset of an AI SDK message part — only the fields read below. */
interface MessagePart {
  type?: string;
  text?: unknown;
  toolInvocation?: { toolName?: string; args?: unknown; toolCallId?: unknown };
  toolName?: string;
  args?: unknown;
  toolCallId?: unknown;
  output?: unknown;
  [k: string]: unknown;
}

/** Row shape from the `messages` table SELECT below. */
interface RawMessageRow {
  id: string;
  role: string;
  parts: unknown;
  created_at: string;
}

function outputLooksLikeReport(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const data = (output as { data?: { report_markdown?: unknown; final_report?: unknown } }).data;
  return !!(data && (data.report_markdown || data.final_report));
}

function resultSummaryFor(output: unknown, errored: boolean): string {
  if (errored) return "failed";
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (o.ok === true) return "completed";
    if (o.ok === false || "error" in o) return "failed";
    return "returned";
  }
  return "returned";
}

/**
 * Parse a stored `messages` row into a lightweight summary. Tool calls are read
 * from AI SDK v6 UIMessage parts — typed `tool-<name>` parts and `dynamic-tool`
 * parts carry their `state`/`input`/`output` inline — with a fallback to the
 * legacy v4 `tool-invocation` + `tool-result` pair so older rows still parse.
 * Exported for unit testing without a Supabase round-trip.
 */
export function summarizeMessageRow(msg: RawMessageRow): MessageSummary {
  const parts: MessagePart[] = Array.isArray(msg.parts) ? msg.parts : [];
  const toolCalls: MessageSummary["toolCalls"] = [];
  let textSummary = "";
  let reportGenerated = false;

  for (const part of parts) {
    const type = typeof part?.type === "string" ? part.type : "";

    if (type === "text" && typeof part.text === "string") {
      textSummary = part.text.slice(0, 120);
      continue;
    }

    // AI SDK v6: dynamic tool part — toolName is explicit.
    if (type === "dynamic-tool") {
      const state = String((part as Record<string, unknown>).state ?? "");
      const hasOutput = state === "output-available";
      const errored = state === "output-error";
      if (outputLooksLikeReport(part.output)) reportGenerated = true;
      toolCalls.push({
        toolName: typeof part.toolName === "string" ? part.toolName : "unknown",
        args: (part as Record<string, unknown>).input ?? part.args,
        resultSummary: hasOutput || errored ? resultSummaryFor(part.output, errored) : undefined,
        startedAt: msg.created_at,
      });
      continue;
    }

    // AI SDK v6: typed tool part — `tool-<toolName>`, output/input inline.
    if (type.startsWith("tool-") && type !== "tool-invocation" && type !== "tool-result") {
      const state = String((part as Record<string, unknown>).state ?? "");
      const hasOutput = state === "output-available";
      const errored = state === "output-error";
      if (outputLooksLikeReport(part.output)) reportGenerated = true;
      toolCalls.push({
        toolName: type.slice("tool-".length),
        args: (part as Record<string, unknown>).input ?? part.args,
        resultSummary: hasOutput || errored ? resultSummaryFor(part.output, errored) : undefined,
        startedAt: msg.created_at,
      });
      continue;
    }

    // Legacy v4: invocation part with a separate matching result part.
    if (type === "tool-invocation") {
      const inv = part.toolInvocation ?? part;
      const resultPart = parts.find(
        (p) => p?.type === "tool-result" && p?.toolCallId === inv?.toolCallId,
      );
      const errored = !!(resultPart?.output && typeof resultPart.output === "object" &&
        "error" in (resultPart.output as Record<string, unknown>));
      toolCalls.push({
        toolName: inv?.toolName ?? "unknown",
        args: inv?.args,
        resultSummary: resultPart ? resultSummaryFor(resultPart.output, errored) : undefined,
        startedAt: msg.created_at,
      });
      continue;
    }

    if (type === "tool-result" && outputLooksLikeReport(part.output)) {
      reportGenerated = true;
    }
  }

  if (reportGenerated) textSummary = "Report generated";

  if (msg.role === "user" && !textSummary) {
    textSummary = parts
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
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
}

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
        setMessages((data as RawMessageRow[]).map(summarizeMessageRow));
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return messages;
}
