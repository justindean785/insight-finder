/**
 * DEV-ONLY harness stub for `@/lib/fetch-retry`.
 *
 * WHY THIS EXISTS. The UI harness can render every settled surface but cannot
 * render a RUNNING one. `isLoading` in ChatWindow is `useChat`'s status, the
 * transport POSTs to `osintAgentUrl(SUPABASE_URL, …)`, and the harness sets
 * SUPABASE_URL to `https://harness.local` — a host that does not resolve. So the
 * fetch fails, `useChat` goes to `error`, and the live run state has never been
 * previewable offline. That blinded the one thing CLAUDE.md asks for on every UI
 * change: a before/after screenshot of the SIGNED-IN workspace.
 *
 * This returns a canned UI-message stream for that one host so the run actually
 * streams: narration, several tool calls, one deliberately left in flight.
 *
 * ⚠️ SCOPE. Aliased ONLY by `vite.harness.config.ts`, exactly like
 * `supabase-mock.ts`. Nothing under `src/` imports it, the production config is
 * untouched, and any other URL delegates to the real `fetch` — so this cannot
 * reach a real build. `npm run build && grep -r harness.local dist/` stays empty.
 *
 * The chunk shapes and headers are taken from the installed `ai` package
 * (`UI_MESSAGE_STREAM_HEADERS`, the `UIMessageChunk` union), not from memory — a
 * wrong wire format here would fail silently as "the harness shows nothing".
 */

const HARNESS_HOST = "harness.local";

/** Matches the production headers the SDK's own stream writer sends. */
const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

type Chunk = Record<string, unknown>;

/** One scripted beat of a run: what to emit, and how long to hold before it. */
interface Beat {
  afterMs: number;
  chunks: Chunk[];
}

const call = (id: string, tool: string): Chunk[] => [
  { type: "tool-input-start", toolCallId: id, toolName: tool },
  { type: "tool-input-available", toolCallId: id, toolName: tool, input: { selector: "harness" } },
];

const done = (id: string, hits: number): Chunk[] => [
  {
    type: "tool-output-available",
    toolCallId: id,
    output: {
      ok: true,
      hits,
      // The runtime meta a real result carries, so the expanded view groups by
      // cycle exactly as it does in production rather than falling to REVIEW:-1.
      runtime: { stage: "TARGETED_PIVOT", cycle_id: 1, selector: "harness", expected_value: 72 },
    },
  },
];

/**
 * A run that keeps streaming for ~2 minutes and ENDS WITH A CALL STILL IN FLIGHT,
 * because the in-flight state is the one being reviewed — a script that finishes
 * would leave the reviewer looking at a settled transcript again.
 */
const SCRIPT: Beat[] = [
  { afterMs: 150, chunks: [{ type: "start" }, { type: "start-step" }] },
  { afterMs: 350, chunks: [{ type: "text-start", id: "t1" }] },
  { afterMs: 500, chunks: [{ type: "text-delta", id: "t1", delta: "Working the seed. " }] },
  { afterMs: 900, chunks: [{ type: "text-delta", id: "t1", delta: "Opening with search and a breach sweep." }] },
  { afterMs: 1200, chunks: [{ type: "text-end", id: "t1" }] },
  { afterMs: 1600, chunks: call("c1", "minimax_web_search") },
  { afterMs: 4000, chunks: done("c1", 9) },
  { afterMs: 4400, chunks: call("c2", "username_sweep") },
  { afterMs: 7000, chunks: done("c2", 4) },
  { afterMs: 7400, chunks: call("c3", "breach_check") },
  { afterMs: 11000, chunks: done("c3", 2) },
  { afterMs: 11500, chunks: call("c4", "serus_darkweb_scan") },
  { afterMs: 16000, chunks: done("c4", 1) },
  // Held open: the label should read "Lead Analyst · Correlating cross-source
  // data points" and the elapsed clock should keep climbing.
  { afterMs: 16500, chunks: call("c5", "minimax_correlate") },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harnessRunStream(signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // `useChat().stop()` only aborts the request's signal and waits for the
      // body read to throw AbortError, which a real fetch does. Honour it here
      // too, or a stopped run can never settle in the harness.
      if (signal) {
        const onAbort = () => {
          cancelled = true;
          try { controller.error(new DOMException("The operation was aborted.", "AbortError")); } catch { /* already closed */ }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      let elapsed = 0;
      for (const beat of SCRIPT) {
        await sleep(beat.afterMs - elapsed);
        elapsed = beat.afterMs;
        if (cancelled) return;
        for (const chunk of beat.chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      }
      // Deliberately never closed while the tab is open: closing the stream would
      // settle the run and the state under review would disappear.
    },
    cancel() {
      cancelled = true;
    },
  });
}

/**
 * Drop-in for the real `fetchWithRetry`. Same signature, and anything that is not
 * the harness edge function goes to the real `fetch` untouched.
 */
export async function fetchWithRetry(
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : String((url as Request).url ?? "");
  if (!href.includes(HARNESS_HOST)) return fetch(url, init);
  return new Response(harnessRunStream(init?.signal), { status: 200, headers: STREAM_HEADERS });
}
