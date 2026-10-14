/**
 * request-size.ts — how many bytes the CLIENT actually uploads per turn.
 *
 * Why this is separate from every prompt-size meter we already have. The edge
 * function's `capTotalToBudget` / `prompt-size.ts` measure what the server
 * PREPARES for the model. They say nothing about what the phone had to push over
 * the wire first: `useChat` sends the whole `messages` array on every turn, and
 * that array is unbounded — trimming happens server-side, after upload. So a
 * long case can be cheap for the model and still slow to send on mobile, and no
 * existing instrument would show it.
 *
 * Bytes are counted with TextEncoder, not `String.length`. `.length` is UTF-16
 * code units, so any non-ASCII content (an accented name, a CJK handle, an
 * emoji in a scraped bio) under-reports the real upload — the exact kind of
 * quietly-wrong number this repo keeps paying for.
 *
 * PURE and side-effect free: the emitter below is a separate function, so the
 * measurement can be unit-tested without stubbing console or the breadcrumb
 * buffer. Measurement only — it never changes what is sent.
 */

import { addBreadcrumb } from "@/lib/telemetry";

export type RequestBodyMeasurement = {
  /** True byte length of the serialized body. */
  bytes: number;
  /** Message count, or null when the body is not the expected JSON shape. */
  messages: number | null;
  /** Bytes of the single largest message, or null when unparseable. */
  largestMessageBytes: number | null;
  /** Role of that largest message, for triage (assistant text vs tool output). */
  largestMessageRole: string | null;
  /** Bytes attributable to tool-result parts across all messages. */
  toolPartBytes: number | null;
  /** True when the body parsed as `{ messages: [...] }`. */
  parsed: boolean;
};

const encoder = new TextEncoder();

/** True byte length of a string or an already-encoded body. */
export function byteLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return encoder.encode(value).length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function partsBytes(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  let n = 0;
  for (const p of parts) {
    const type = (p as { type?: unknown })?.type;
    if (typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")) {
      n += byteLength(p);
    }
  }
  return n;
}

/**
 * Measure a request body. Never throws: a body we cannot parse still reports its
 * true byte size, with the breakdown null rather than guessed.
 */
export function measureRequestBody(body: unknown): RequestBodyMeasurement {
  const bytes = byteLength(body);
  const base: RequestBodyMeasurement = {
    bytes,
    messages: null,
    largestMessageBytes: null,
    largestMessageRole: null,
    toolPartBytes: null,
    parsed: false,
  };
  if (typeof body !== "string" || !body) return base;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return base;
  }
  const msgs = (payload as { messages?: unknown })?.messages;
  if (!Array.isArray(msgs)) return base;

  let largest = 0;
  let largestRole: string | null = null;
  let toolBytes = 0;
  for (const m of msgs) {
    const size = byteLength(m);
    if (size > largest) {
      largest = size;
      const role = (m as { role?: unknown })?.role;
      largestRole = typeof role === "string" ? role : null;
    }
    toolBytes += partsBytes((m as { parts?: unknown })?.parts);
  }

  return {
    bytes,
    messages: msgs.length,
    largestMessageBytes: largest,
    largestMessageRole: largestRole,
    toolPartBytes: toolBytes,
    parsed: true,
  };
}

/**
 * Emit one measurement. A breadcrumb (so it rides along on any error report the
 * analyst hits) plus a structured console line, reusing what already exists
 * rather than adding a second telemetry channel.
 *
 * Deliberately NOT a network call: measuring an upload by making another upload
 * is its own overhead on the connection under investigation.
 */
export function reportRequestBodySize(m: RequestBodyMeasurement, threadId?: string): void {
  addBreadcrumb("request", "chat request body", {
    bytes: m.bytes,
    messages: m.messages,
    largest_message_bytes: m.largestMessageBytes,
    tool_part_bytes: m.toolPartBytes,
  });
  try {
    console.info(JSON.stringify({
      event: "chat_request_body_size",
      thread_id: threadId ?? null,
      bytes: m.bytes,
      kib: Math.round((m.bytes / 1024) * 10) / 10,
      messages: m.messages,
      largest_message_bytes: m.largestMessageBytes,
      largest_message_role: m.largestMessageRole,
      tool_part_bytes: m.toolPartBytes,
      parsed: m.parsed,
    }));
  } catch {
    // Never let a meter break a send.
  }
}
