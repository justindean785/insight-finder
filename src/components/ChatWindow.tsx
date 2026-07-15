import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { supabase, SUPABASE_URL } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { reflowCollapsedTables } from "@/lib/markdown";
import { osintAgentUrl } from "@/lib/functionsUrl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import {
  ArrowDown, ArrowUp, Loader2, ChevronDown, ChevronRight, Wrench, RotateCcw, AlertTriangle,
  StickyNote, CheckCircle2, XCircle, Clock, CircleSlash, Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { detectSeed, formatThreadTitle } from "@/lib/seed";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { isSubmitBlocked } from "@/lib/submit-guard";
import { interpretReadinessProbe, type ReadinessBody } from "@/lib/readiness-probe";
import { dedupeCards } from "@/lib/next-step-cards";
import { computePivots } from "@/lib/pivot-engine";
import { sanitizeChatText } from "@/lib/sanitize-agent-text";
import { scrollBehavior } from "@/lib/motion";
import { deriveToolCharge, deriveToolPreview, deriveToolRuntime, deriveToolTone } from "@/lib/tool-run";
import { shouldFollowChatScroll, shouldAdoptInitialMessages, CHAT_REENGAGE_THRESHOLD_PX } from "@/lib/chat-scroll";
import {
  extractRecommendedPivots,
  pivotSkipStorageKey,
  type RecommendedPivot,
} from "@/lib/recommended-pivots";
import { Sparkles, GitBranch, Paperclip, X, FileText, Image as ImageIcon, Copy as CopyIcon, ArrowRight } from "lucide-react";
import { parseUserMessage, isImageAttachment } from "@/lib/attachments";
import { toolDisplayName, toolActionLabel, humanizeStage } from "@/lib/tool-display";

const SUPABASE_PROJECT_ID = (import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined)?.trim();
// Resolve from the client's SUPABASE_URL (which carries the baked-in default),
// NOT raw import.meta.env — otherwise a deploy without VITE_SUPABASE_URL set
// resolves this to "" and every scan dies with "function URL not configured",
// even though the supabase client itself works off the default. osintAgentUrl
// also strips a trailing /functions/v1 so a misconfigured base can't double it.
const FUNCTIONS_URL = osintAgentUrl(SUPABASE_URL, SUPABASE_PROJECT_ID);

const FAIL_PREFIX = "__STATUS__:failed:";
const CACHE_BANNER_TYPE = "data-investigation-cache";
const RETRYABLE_HTTP_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

type NextStepSuggestion = {
  title: string;
  detail?: string;
  prompt: string;
  icon: "pivot" | "spark";
  meta: string;
  priority?: RecommendedPivot["priority"];
  /** Normalized dedupe key target (e.g. name/email), if this card pivots on one. */
  target?: string;
};

// Cross-browser timeout helper. AbortSignal.timeout() is missing on
// Safari ≤ 17.3, Firefox ESR, and Node 18 (used by Vitest), where the
// very first probe would throw TypeError: AbortSignal.timeout is not
// a function and prevent scans from starting. Manual AbortController
// works everywhere.
function signalWithTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    // Native fast path.
    return { signal: AbortSignal.timeout(ms), cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("TimeoutError", "TimeoutError")), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function parseHttpStatusFromError(err: unknown): number | null {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  const m = msg.match(/\bHTTP\s*([45]\d{2})\b/i) ?? msg.match(/\bstatus\s*[:=]\s*([45]\d{2})\b/i) ?? msg.match(/\b([45]\d{2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function describeTransportError(err: unknown): string {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "").toLowerCase();
  const status = parseHttpStatusFromError(err);
  if (status === 401) return "Session expired — your login has timed out. Sign in again to continue.";
  if (status === 402 || msg.includes("insufficient_credits") || msg.includes("out of credits"))
    return "Out of beta credits — you've used your investigation allowance for now. Contact us to top up your account.";
  if (status === 403) return "Access denied — this thread doesn't belong to your account. Open your own thread or create a new one.";
  if (status === 404) return "Edge function not deployed — the OSINT agent backend wasn't found. Deploy the Supabase function and retry.";
  if (status === 429) return "Rate limited by the scan backend — too many requests. Wait ~30 seconds and try again.";
  if (status === 502 || status === 503 || status === 504) return "Scan backend temporarily unavailable — upstream provider or dependency is down. Retry in a minute.";
  if (status && status >= 500) return `Backend error (HTTP ${status}) — the OSINT agent encountered a server fault. Check Supabase function logs for details.`;
  if (/failed to fetch|networkerror|network request failed|load failed|dns/i.test(msg)) return "Network failure — cannot reach the scan backend. Verify your Supabase project is running and the function URL is correct.";
  return "Scan request failed before the stream started — check the browser console for transport details.";
}

async function fetchWithRetry(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const maxAttempts = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE_HTTP_CODES.has(res.status) || attempt === maxAttempts) return res;
      const delayMs = 250 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) throw e;
      const delayMs = 250 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error("fetch retry exhausted");
}

function copyToClipboard(text: string, label = "Copied") {
  navigator.clipboard.writeText(text).then(
    () => toast.success(label),
    () => toast.error("Copy failed"),
  );
}

type ToolPartShape = {
  type?: string;
  state?: string;
  toolCallId?: string;
  errorText?: string | null;
  input?: unknown;
  output?: unknown;
};

/**
 * Loose view of an AI SDK message part — covers the text, tool-* and custom
 * data-part fields this component reads. Only models what's accessed here;
 * unknown fields stay reachable via the index signature.
 */
type MessagePartShape = {
  type?: string;
  text?: string;
  data?: unknown;
  [k: string]: unknown;
};

/** One artifact stored in an investigation_cache.result_json blob. */
type CachedArtifact = {
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
};

/** Shape of investigation_cache.result_json (only the fields we replay). */
type CachedInvestigation = {
  assistant_parts?: unknown[];
  artifacts?: CachedArtifact[];
  [k: string]: unknown;
};

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch (e) {
    return `[unserializable: ${(e as Error)?.message ?? "error"}]`;
  }
}

function shorten(s: string, max = 32): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

const CODE_COLLAPSE_LINES = 10;

function CodePanel({
  label, content, onCopy, variant = "input",
}: {
  label: string;
  content: string;
  onCopy: () => void;
  variant?: "input" | "output" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.length ? content.split("\n") : [""];
  const lineCount = lines.length;
  const charCount = content.length;
  const isLong = lineCount > CODE_COLLAPSE_LINES || charCount > 1200;
  const shown = expanded || !isLong
    ? content
    : lines.slice(0, CODE_COLLAPSE_LINES).join("\n") + "\n…";
  const shownLines = shown.split("\n");
  const gutter = shownLines.map((_, i) => String(i + 1)).join("\n");
  const meta = `${lineCount} line${lineCount === 1 ? "" : "s"} · ${(charCount / 1024).toFixed(charCount >= 1024 ? 1 : 0)}${charCount >= 1024 ? "kb" : "b"}`;

  return (
    <div
      className={cn(
        "code-panel",
        variant === "error" && "code-panel--error",
      )}
    >
      <div
        className={cn(
          "code-panel__head",
          variant === "output" && "code-panel__head--output",
        )}
      >
        <span className="code-panel__head-label">
          {label}
          <span className="code-panel__head-meta">{meta}</span>
        </span>
        <div className="code-panel__head-actions">
          {isLong && (
            <button type="button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
          <button type="button" onClick={onCopy}>Copy</button>
        </div>
      </div>
      <div className={cn("code-panel__body", expanded && "code-panel__body--expanded")}>
        <div className="code-panel__gutter" aria-hidden>{gutter}</div>
        <pre className="code-panel__code">{shown}</pre>
      </div>
    </div>
  );
}

function ToolPart({ part: rawPart, createdAt }: { part: ToolPartShape | null | undefined; createdAt?: string }) {
  const part: ToolPartShape = (rawPart && typeof rawPart === "object" ? rawPart : {}) as ToolPartShape;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const name = part.type?.replace(/^tool-/, "") ?? "tool";
  const state: string = part.state ?? "";
  const callId: string = part.toolCallId ?? `${name}-${createdAt ?? ""}`;
  const noteKey = `proximity:note:${callId}`;

  useEffect(() => {
    const v = localStorage.getItem(noteKey) ?? "";
    setNoteSaved(v);
    setNote(v);
  }, [noteKey]);

  const tone = deriveToolTone(part);
  const failed = tone === "error";
  const done = tone === "ok";
  const ts = createdAt ? new Date(createdAt) : null;

  // Duration: measured as true wall-clock, but ONLY for parts that were still
  // pending on first render — i.e. calls that resolve live in this session. A
  // history-loaded card arrives already-resolved, so `now - messageCreatedAt`
  // would print a nonsense duration (e.g. "1440m00s" for a day-old message);
  // for those we suppress the duration entirely.
  const pendingAtMountRef = useRef(!(done || failed));
  const startRef = useRef<number>(Date.now());
  const [doneAt, setDoneAt] = useState<number | null>(null);
  useEffect(() => {
    if ((done || failed) && doneAt == null) setDoneAt(Date.now());
  }, [done, failed, doneAt]);
  const durationMs = pendingAtMountRef.current && doneAt != null
    ? Math.max(0, doneAt - startRef.current)
    : null;
  const durationLabel = durationMs == null
    ? null
    : durationMs < 1000
      ? `${durationMs}ms`
      : durationMs < 60_000
        ? `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
        : `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)
            .toString()
            .padStart(2, "0")}s`;

  // Tiny one-line arg summary so the user gets context without expanding.
  // Picks the first 1-2 string/number scalars from the input object.
  const argSummary = (() => {
    const inp = part.input;
    if (!inp) return null;
    if (typeof inp === "string") return shorten(inp, 48);
    if (typeof inp !== "object") return String(inp);
    const entries = Object.entries(inp as Record<string, unknown>)
      .filter(([, v]) => v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      .slice(0, 2);
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => `${k}=${shorten(String(v), 28)}`).join(" · ");
  })();

  // Respond to header "failed" chip clicks: the first failed card on the
  // page scrolls into view and flashes a destructive ring.
  useEffect(() => {
    if (!failed) return;
    const onShow = () => {
      const first = document.querySelector('[data-failed-tool="true"]');
      if (first === rootRef.current) {
        rootRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        setOpen(true);
        setFlash(true);
        setTimeout(() => setFlash(false), 1800);
      }
    };
    window.addEventListener("proximity:show-failed-tools", onShow);
    return () => window.removeEventListener("proximity:show-failed-tools", onShow);
  }, [failed]);

  // Cache-hit detection: the edge function marks cached outputs with `_cached: true`.
  const outputObj: Record<string, unknown> | null =
    part.output && typeof part.output === "object" ? (part.output as Record<string, unknown>) : null;
  const cached = !!outputObj?._cached;

  // Model tier — tagged by wrapToolsWithCache from the model registry.
  const tier: "fast" | "smart" | null = (() => {
    const t = outputObj ? outputObj._tier : null;
    return t === "fast" || t === "smart" ? t : null;
  })();
  const tierModel: string | null =
    outputObj && typeof outputObj._model === "string" ? outputObj._model : null;

  const charge = deriveToolCharge(part.output);
  const artifactPreview = deriveToolPreview(name, part.output);
  const displayName = toolDisplayName(name);
  const actionOnly = toolActionLabel(name);
  const hasInput = part.input != null;
  const hasOutput = part.output !== undefined;

  return (
    <div
      ref={rootRef}
      data-failed-tool={failed ? "true" : undefined}
      className={cn(
        "group relative w-full min-w-0 text-[13px] animate-fade-up overflow-hidden chat-card",
        failed && "border-destructive/30 bg-[hsl(0_40%_8%/0.85)]",
        flash && "ring-2 ring-destructive/60",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left"
      >
        <span
          className={cn(
            "inline-flex h-2 w-2 shrink-0 rounded-full",
            failed
              ? "bg-destructive shadow-[0_0_8px_hsl(var(--danger)/0.7)]"
              : tone === "skip"
              ? "bg-muted-foreground/45"
              : done
              ? "bg-[hsl(var(--confidence-high))] shadow-[0_0_8px_hsl(var(--confidence-high)/0.55)]"
              : "bg-muted-foreground/60 animate-pulse",
          )}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate text-[13px] font-medium leading-snug",
                failed ? "text-destructive" : "text-foreground/92",
              )}
              title={displayName}
            >
              {actionOnly}
            </span>
            {failed ? (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            ) : tone === "skip" ? (
              <CircleSlash className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            ) : done ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--confidence-high))]" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {artifactPreview && (
              <span className="truncate font-mono tabular-nums">{artifactPreview}</span>
            )}
            {argSummary && (
              <>
                {artifactPreview && <span className="opacity-40" aria-hidden>·</span>}
                <span className="truncate font-mono opacity-80" title={argSummary}>{argSummary}</span>
              </>
            )}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5">
          {cached && (
            <span className="hidden rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:inline">
              cached
            </span>
          )}
          {durationLabel && (
            <span
              className="hidden rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground sm:inline"
              title={`Tool runtime: ${durationMs}ms`}
            >
              {durationLabel}
            </span>
          )}
          {ts && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/75">
              {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          )}
        </span>
      </button>

      {open && (
        <div className="tool-detail">
          <div className="tool-detail__meta">
            <span>Tool</span>
            <code title={name}>{name}</code>
            {tier && (
              <span title={tierModel ? `${tier} · ${tierModel}` : tier}>
                tier · {tier}
              </span>
            )}
            {charge.label && <span title={charge.title ?? undefined}>{charge.label}</span>}
            {displayName !== actionOnly && (
              <span className="truncate opacity-80">{displayName}</span>
            )}
          </div>

          <div className="tool-io-grid">
            {hasInput && (
              <CodePanel
                label="Input"
                content={safeStringify(part.input)}
                onCopy={() => copyToClipboard(safeStringify(part.input), "Input copied")}
                variant="input"
              />
            )}
            {hasOutput && (
              <CodePanel
                label="Output"
                content={safeStringify(part.output)}
                onCopy={() => copyToClipboard(safeStringify(part.output), "Output copied")}
                variant="output"
              />
            )}
          </div>

          {part.errorText && (
            <div className="mt-2.5">
              <CodePanel
                label="Error"
                content={part.errorText}
                onCopy={() => copyToClipboard(part.errorText ?? "", "Error copied")}
                variant="error"
              />
            </div>
          )}

          <div className="mt-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StickyNote className="h-3 w-3" /> Analyst note
            </div>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note saved locally on this device…"
              rows={2}
              className="min-h-[2.5rem] text-[12px]"
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              {noteSaved && <span className="text-[11px] text-muted-foreground">saved</span>}
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[11px]"
                onClick={() => {
                  localStorage.setItem(noteKey, note);
                  setNoteSaved(note);
                  toast.success("Note saved");
                }}
              >
                Save note
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type ToolRunGroup = {
  key: string;
  stage: string;
  cycleId: number;
  parts: ToolPartShape[];
  selectors: string[];
  cached: number;
  stale: number;
  skipped: number;
  failed: number;
  useful: number;
  credits: string[];
  expectedValues: number[];
  reasons: string[];
};

// Per-message memoization: useChat replaces the messages array reference on
// every streamed token, so unchanged prior messages would otherwise re-run this
// grouping on each tick. Keyed on the (stable, for settled messages) parts array
// reference, so a message only re-groups when its own parts actually change.
const toolGroupCache = new WeakMap<MessagePartShape[], Array<ToolRunGroup | { part: ToolPartShape }>>();

function groupToolParts(parts: MessagePartShape[]): Array<ToolRunGroup | { part: ToolPartShape }> {
  const cached = toolGroupCache.get(parts);
  if (cached) return cached;
  const result = computeToolGroups(parts);
  toolGroupCache.set(parts, result);
  return result;
}

function computeToolGroups(parts: MessagePartShape[]): Array<ToolRunGroup | { part: ToolPartShape }> {
  const groups: Array<ToolRunGroup | { part: ToolPartShape }> = [];
  let current: ToolRunGroup | null = null;
  for (const candidate of parts) {
    if (typeof candidate.type !== "string" || !candidate.type.startsWith("tool-")) continue;
    const part = candidate as ToolPartShape;
    const name = part.type.replace(/^tool-/, "");
    const runtime = deriveToolRuntime(part.output);
    const stage = runtime?.stage ?? "REVIEW";
    const cycleId = typeof runtime?.cycle_id === "number" ? runtime.cycle_id : -1;
    const key = `${stage}:${cycleId}`;
    const tone = deriveToolTone(part);
    const cached = runtime?.cache_layer === "thread" || runtime?.cache_layer === "user" || !!(part.output && typeof part.output === "object" && (part.output as Record<string, unknown>)._cached);
    const stale = runtime?.stale_cache === true;
    const charge = deriveToolCharge(part.output).label;
    // A real selector value (email / domain / handle being investigated) is
    // shown verbatim; when a tool has none, fall back to a plain-language action
    // label instead of leaking the raw tool id (e.g. "memory_recall") to the UI.
    const selector = typeof runtime?.selector === "string" && runtime.selector ? runtime.selector : toolActionLabel(name);
    const useful = tone === "ok" && !cached && !stale ? 1 : 0;
    const reason = typeof runtime?.rejection_reason === "string" ? runtime.rejection_reason : "";
    if (!current || current.key !== key) {
      current = {
        key,
        stage,
        cycleId,
        parts: [],
        selectors: [],
        cached: 0,
        stale: 0,
        skipped: 0,
        failed: 0,
        useful: 0,
        credits: [],
        expectedValues: [],
        reasons: [],
      };
      groups.push(current);
    }
    current.parts.push(part);
    current.selectors.push(selector);
    if (cached) current.cached += 1;
    if (stale) current.stale += 1;
    if (tone === "skip") current.skipped += 1;
    if (tone === "error") current.failed += 1;
    current.useful += useful;
    if (charge) current.credits.push(charge);
    if (typeof runtime?.expected_value === "number") current.expectedValues.push(runtime.expected_value);
    if (reason) current.reasons.push(reason);
  }
  return groups;
}

// Beta-facing cycle badges. Failed tool calls are intentionally NOT surfaced to
// users — `group.failed` is still counted in the group data (and kept in state),
// it is only hidden from this presentation. Exported solely for a regression
// test; it is a pure helper, not a component.
// eslint-disable-next-line react-refresh/only-export-components
export function cycleSummaryBadges(group: {
  cached: number;
  stale: number;
  skipped: number;
  useful: number;
}): string[] {
  return [
    group.cached > 0 ? `${group.cached} cached` : null,
    group.stale > 0 ? `${group.stale} stale` : null,
    group.skipped > 0 ? `${group.skipped} skipped` : null,
    group.useful > 0 ? `${group.useful} completed` : null,
  ].filter((bit): bit is string => Boolean(bit));
}

// Cycle header label (Phase C2). When the runtime couldn't resolve a cycle number
// (cycleId <= 0, e.g. an older thread or a partial run), we previously rendered a
// literal "REVIEW CYCLE ?", which reads like a bug. Drop the "cycle N" suffix
// entirely in that case and show just the stage — never a bare "?".
export function cycleSummaryLabel(stage: string, cycleId: number): string {
  const base = (stage ?? "").trim();
  return cycleId > 0 ? `${base} cycle ${cycleId}` : base;
}

// A cycle that produced nothing — only skips, with no useful output, no cache
// hits, no real failures, and no stale results — is pure noise (e.g. a provider
// disabled in config surfacing as "1 skipped · unavailable: disabled"). The
// analyst gets zero actionable signal from it, so suppress it from chat.
function isNoiseToolGroup(group: ToolRunGroup): boolean {
  return (
    group.useful === 0 &&
    group.failed === 0 &&
    group.cached === 0 &&
    group.stale === 0 &&
    group.skipped > 0
  );
}

function flowToneForGroup(group: ToolRunGroup): "completed" | "partial" | "cached" | "skipped" {
  if (group.useful > 0) return "completed";
  if (group.cached > 0 || group.stale > 0) return "cached";
  if (group.skipped > 0 && group.failed === 0) return "skipped";
  return "partial";
}

function RunFlowRail({ groups }: { groups: ToolRunGroup[] }) {
  if (groups.length <= 1) return null;
  return (
    <div className="chat-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        <GitBranch className="h-3 w-3 text-muted-foreground" />
        Run flow
      </div>
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
        {groups.map((group, index) => {
          const tone = flowToneForGroup(group);
          const isLast = index === groups.length - 1;
          const icon = tone === "completed"
            ? <CheckCircle2 className="h-3.5 w-3.5" />
            : tone === "cached"
              ? <Clock className="h-3.5 w-3.5" />
              : tone === "skipped"
                ? <CircleSlash className="h-3.5 w-3.5" />
                : <Square className="h-3.5 w-3.5" />;
          const toneClass = tone === "completed"
            ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high)/0.35)] bg-[hsl(var(--confidence-high)/0.08)]"
            : tone === "cached"
              ? "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid)/0.35)] bg-[hsl(var(--confidence-mid)/0.08)]"
              : tone === "skipped"
                ? "text-muted-foreground border-white/12 bg-white/[0.03]"
                : "text-foreground border-white/15 bg-white/[0.05]";
          return (
            <div key={`flow-${group.key}-${index}`} className="flex shrink-0 items-center gap-1">
              <div className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-micro", toneClass)}>
                {icon}
                <span className="font-mono tracking-normal">{cycleSummaryLabel(humanizeStage(group.stage), group.cycleId)}</span>
                <span className="text-eyebrow opacity-80">{group.parts.length}</span>
              </div>
              {!isLast && <span className="h-px w-5 shrink-0 bg-gradient-to-r from-white/25 to-white/5" aria-hidden />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolGroupSummary({ group, createdAt }: { group: ToolRunGroup; createdAt?: string }) {
  const [expanded, setExpanded] = useState(false);
  const avgExpected = group.expectedValues.length
    ? Math.round(group.expectedValues.reduce((sum, value) => sum + value, 0) / group.expectedValues.length)
    : null;
  const time = createdAt ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const selectors = Array.from(new Set(group.selectors)).slice(0, 3);
  const extra = Math.max(0, new Set(group.selectors).size - selectors.length);
  const summaryBits = cycleSummaryBadges(group);
  // Beta-facing: failed tool parts are hidden from the expanded list too. The
  // underlying group.parts stays intact in state; only the rendered subset omits
  // errors, so a user who expands a cycle never sees a red "failed" card.
  const visibleParts = group.parts.filter((part) => deriveToolTone(part) !== "error");
  return (
    <div className="chat-card text-[13px] leading-relaxed text-muted-foreground">
      <button
        type="button"
        className="w-full px-4 py-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <span className="font-medium text-foreground/90">
            {cycleSummaryLabel(humanizeStage(group.stage), group.cycleId)}
          </span>
          <span className="tabular-nums">{group.parts.length} call{group.parts.length === 1 ? "" : "s"}</span>
          {avgExpected != null && <span className="tabular-nums">EV {avgExpected}</span>}
          {time && <span className="ml-auto tabular-nums text-muted-foreground/80">{time}</span>}
        </div>
        {(selectors.length > 0 || extra > 0) && (
          <div className="mt-1.5 break-all pl-5 text-foreground/75 sm:break-words">
            {selectors.join(" · ")}
            {extra > 0 ? ` · +${extra} more` : ""}
          </div>
        )}
        {summaryBits.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
            {summaryBits.map((bit) => (
              <span key={bit} className="rounded border border-white/8 bg-black/20 px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
                {bit}
              </span>
            ))}
          </div>
        )}
        {group.reasons[0] && (
          <div className="mt-1.5 pl-5 text-[12px] text-muted-foreground/80">
            {group.reasons[0]}
          </div>
        )}
      </button>
      {expanded && visibleParts.length > 0 && (
        <div className="space-y-2 border-t border-white/[0.06] px-4 py-3">
          {visibleParts.map((part, partIndex) => (
            <ToolPart key={`${group.key}-${partIndex}`} part={part} createdAt={createdAt} />
          ))}
        </div>
      )}
    </div>
  );
}

const LABEL_STYLES: Record<string, string> = {
  CONFIRMED: "chat-label-chip text-[hsl(var(--conf-confirmed))] border-[hsl(var(--conf-confirmed)/0.4)] bg-[hsl(var(--conf-confirmed)/0.12)]",
  CORRELATED: "chat-label-chip text-[hsl(var(--conf-likely))] border-[hsl(var(--conf-likely)/0.4)] bg-[hsl(var(--conf-likely)/0.12)]",
  INFERRED:  "chat-label-chip text-[hsl(var(--conf-possible))] border-[hsl(var(--conf-possible)/0.45)] bg-[hsl(var(--conf-possible)/0.12)]",
  VERIFY:    "chat-label-chip text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid)/0.4)] bg-[hsl(var(--confidence-mid)/0.12)]",
  FAILED:    "chat-label-chip text-destructive border-destructive/40 bg-destructive/12",
  LOW:       "chat-label-chip text-muted-foreground border-border bg-secondary/60",
  CONFLICT:  "chat-label-chip text-destructive border-destructive/40 bg-destructive/12",
};

function renderTextWithBadges(text: string): React.ReactNode {
  const re = /\[(CONFIRMED|CORRELATED|INFERRED|VERIFY|FAILED|LOW|CONFLICT)\]/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tag = m[1];
    out.push(
      <span key={`b-${m.index}`} className={LABEL_STYLES[tag] ?? "chat-label-chip border-border text-muted-foreground"}>
        {tag}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function FailedRunCard({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const raw = reason || "Unknown error";
  const isContextOverflow =
    /context window|context length|exceeds limit|invalid params.*context|\b2013\b/i.test(raw);
  // Heuristic short summary vs. technical detail
  const shortMatch = raw.match(/^([^:.\n]{0,140}?)(?:[:.\n]|$)/);
  const headline = (shortMatch?.[1] ?? raw).slice(0, 140);
  const hint = (() => {
    const r = raw.toLowerCase();
    if (r.includes("context window")) return "The thread has grown too large. Start a new investigation or summarize before continuing.";
    if (r.includes("rate") && r.includes("limit")) return "Upstream rate-limited the request. Wait a moment and retry.";
    if (r.includes("timeout")) return "An upstream tool took too long to respond. Retrying often clears this.";
    if (r.includes("402") || r.includes("credit")) return "AI gateway credits are exhausted. Add credits in workspace settings.";
    return "Retry the run, or refine the seed if the failure repeats.";
  })();
  const title = isContextOverflow ? "Investigation paused" : "Investigation run failed";
  const body = isContextOverflow
    ? "The model context grew too large during this run. Your collected artifacts were preserved, but the agent needs to continue with a smaller context or the Gemini fallback."
    : headline;
  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success("Technical details copied");
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <div className="alert-panel-danger p-5 animate-fade-up animate-red-edge">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-destructive/15 border border-destructive/30">
          <AlertTriangle className="w-4 h-4 text-destructive animate-warning-pulse" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-micro font-mono font-semibold tracking-normal text-destructive/80">
            System alert
          </div>
          <div className="text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="text-xs text-foreground/70 leading-relaxed break-words">
            {body}
          </div>
          <div className="text-data text-muted-foreground pt-1">
            <span className="text-foreground/70 font-medium">Suggested fix · </span>
            {hint}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onRetry}
          className="gap-2 bg-destructive/15 hover:bg-destructive/25 text-destructive border border-destructive/40 shadow-[0_0_24px_-10px_hsl(var(--danger)/0.6)]"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          {isContextOverflow ? "Retry with Gemini fallback" : "Retry investigation"}
        </Button>
        <button
          type="button"
          onClick={copyDetails}
          className="text-micro font-mono tracking-normal text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-white/[0.04]"
        >
          Copy technical details
        </button>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="text-micro font-mono tracking-normal text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-white/[0.04]"
        >
          {showDetails ? "Hide" : "Show"} technical details
        </button>
      </div>

      {showDetails && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-white/5 bg-black/40 p-3 text-data font-mono text-muted-foreground whitespace-pre-wrap break-words">
          {raw}
        </pre>
      )}
    </div>
  );
}

function CacheBanner({ cachedAt, onRerun, busy }: { cachedAt: string; onRerun: () => void; busy: boolean }) {
  const ageMs = Date.now() - new Date(cachedAt).getTime();
  const ageLabel = formatAge(ageMs);
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
      <Clock className="w-4 h-4 text-primary shrink-0" />
      <div className="text-sm flex-1">
        <span className="font-medium">Cached result</span>
        <span className="text-muted-foreground"> from {new Date(cachedAt).toLocaleString()} ({ageLabel} ago)</span>
      </div>
      <Button size="sm" variant="outline" onClick={onRerun} disabled={busy} className="gap-1.5">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
        Re-run
      </Button>
    </div>
  );
}

function formatAge(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// Stable ReactMarkdown component map — hoisted so it isn't re-allocated on every
// render (a fresh `components` object would force ReactMarkdown to treat itself
// as changed). Combined with <MarkdownBlock> below, unchanged prior messages no
// longer re-parse their markdown on each streamed token.
const chatMarkdownComponents: Components = {
  // Spacing/typography owned by `.chat-prose` so every block is even.
  p: ({ node, children, ...rest }) => <p {...rest}>{wrapChildren(children)}</p>,
  li: ({ node, children, ...rest }) => <li {...rest}>{wrapChildren(children)}</li>,
  strong: ({ node, children, ...rest }) => <strong {...rest}>{wrapChildren(children)}</strong>,
  pre: ({ node, children, ...rest }) => (
    <div className="chat-code-block">
      <pre {...rest} className="overflow-x-auto whitespace-pre">{children}</pre>
    </div>
  ),
  table: ({ node, children, ...rest }) => (
    <div className="chat-table-wrap">
      <table {...rest}>{children}</table>
    </div>
  ),
  th: ({ node, children, ...rest }) => <th {...rest}>{children}</th>,
  td: ({ node, children, ...rest }) => <td {...rest}>{wrapChildren(children)}</td>,
};

const CHAT_REMARK_PLUGINS = [remarkGfm];

// Memoized on the raw markdown string: a re-render of the parent (e.g. a
// streamed token landing on the LAST message) no longer re-parses the markdown
// of unchanged earlier messages.
const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} components={chatMarkdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

function MessageViewImpl({ m, createdAt, onRetry, onRerun, rerunBusy }: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean }) {
  if (m.role === "user") {
    const text = (m.parts as MessagePartShape[]).filter((p) => p.type === "text").map((p) => p.text).join("");
    // Split the human text from the "Attached files:" block the composer appends,
    // so we render image thumbnails / file chips instead of the raw Supabase
    // signed URL (token and all). See src/lib/attachments.ts.
    const { body, attachments } = parseUserMessage(text);
    const images = attachments.filter(isImageAttachment);
    const files = attachments.filter((a) => !isImageAttachment(a));
    const sizeOf = (meta: string) => meta.split(",").pop()?.trim() || "";
    return (
      <div className="flex w-full justify-end">
        <div
          className="chat-card relative min-w-0 max-w-[min(100%,36rem)] px-4 py-2.5 text-[14px] leading-[1.6] break-words text-[hsl(0_0%_93%)]"
          style={{
            overflowWrap: "break-word",
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "IBM Plex Sans", sans-serif',
          }}
        >
          {body && <div className="whitespace-pre-wrap">{body}</div>}
          {images.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${body ? "mt-2.5" : ""}`}>
              {images.map((a, i) => (
                <a
                  key={`img-${i}`}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.name}
                  className="block rounded-lg overflow-hidden border border-border-subtle bg-surface-1/50 hover:border-white/25 transition-colors"
                >
                  <img
                    src={a.url}
                    alt={a.name}
                    loading="lazy"
                    className="block max-h-44 max-w-[220px] object-cover"
                  />
                </a>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${(body || images.length) ? "mt-2.5" : ""}`}>
              {files.map((a, i) => (
                <a
                  key={`file-${i}`}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.name}
                  className="flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border border-border-subtle bg-surface-1/50 text-xs max-w-[260px] hover:border-white/25 transition-colors"
                >
                  <FileText className="w-3 h-3 text-primary shrink-0" />
                  <span className="truncate">{a.name}</span>
                  {a.meta && <span className="text-muted-foreground text-data shrink-0">{sizeOf(a.meta)}</span>}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  const parts = m.parts as MessagePartShape[];
  // Detect cached-investigation marker
  const cacheMeta = parts.find((p) => p?.type === CACHE_BANNER_TYPE)?.data as
    | { cachedAt: string }
    | undefined;
  const toolGroups = groupToolParts(parts);
  // Drop do-nothing cycles (all-skipped, no useful/cache/fail/stale) from chat —
  // single ToolParts always pass through; only noise ToolRunGroups are removed.
  const visibleToolGroups = toolGroups.filter((entry) => "part" in entry || !isNoiseToolGroup(entry));
  const groupedCycles = visibleToolGroups.filter((entry): entry is ToolRunGroup => !("part" in entry));
  // Detect failed run sentinel
  const firstText = parts.find((p) => p.type === "text");
  if (firstText?.text?.startsWith?.(FAIL_PREFIX)) {
    const reason = firstText.text.slice(FAIL_PREFIX.length);
    return (
      <div className="space-y-2">
        <RunFlowRail groups={groupedCycles} />
        {visibleToolGroups.map((entry, i) => "part" in entry ? (
          <ToolPart key={`failed-tool-${i}`} part={entry.part} createdAt={createdAt} />
        ) : (
          <ToolGroupSummary key={`failed-group-${entry.key}-${i}`} group={entry} createdAt={createdAt} />
        ))}
        {onRetry && <FailedRunCard reason={reason} onRetry={onRetry} />}
      </div>
    );
  }
  // Single joined prose block so tool cards and the reply share one width stack.
  const prose = reflowCollapsedTables(
    parts
      .filter((p) => p.type === "text")
      .map((p) => stripThinkTags(p.text ?? ""))
      .filter(Boolean)
      .join("\n\n")
      .trim(),
  );
  const timeLabel = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex w-full flex-col gap-3">
      {cacheMeta && onRerun && (
        <CacheBanner cachedAt={cacheMeta.cachedAt} onRerun={onRerun} busy={!!rerunBusy} />
      )}
      {visibleToolGroups.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          <RunFlowRail groups={groupedCycles} />
          {visibleToolGroups.map((entry, i) => "part" in entry ? (
            <ToolPart key={`tool-${i}`} part={entry.part} createdAt={createdAt} />
          ) : (
            <ToolGroupSummary key={`${entry.key}-${i}`} group={entry} createdAt={createdAt} />
          ))}
        </div>
      )}
      {prose && (
        <article className="chat-card w-full min-w-0" aria-label="Agent response">
          <div className="chat-card__header">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--intel-blue))]" aria-hidden />
            <span>Agent</span>
            {timeLabel && <span className="chat-card__header-time">{timeLabel}</span>}
          </div>
          <div className="chat-card__body">
            <div className="chat-prose">
              <MarkdownBlock content={prose} />
            </div>
          </div>
          <div className="chat-card__footer">
            <button
              type="button"
              onClick={() => copyToClipboard(prose, "Message copied")}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground transition-colors"
              aria-label="Copy message"
              title="Copy message"
            >
              <CopyIcon className="w-3 h-3" /> Copy
            </button>
          </div>
        </article>
      )}
      {parts.map((p, i) => {
        if (typeof p.type === "string" && p.type.startsWith("tool-") && visibleToolGroups.length === 0) {
          return <ToolPart key={i} part={p as ToolPartShape} createdAt={createdAt} />;
        }
        return null;
      })}
    </div>
  );
}

// useChat swaps the whole messages array (and often each message object) per
// streamed token. This comparator lets an already-rendered message skip
// re-rendering unless something it actually displays changed: its content
// (identity of the message object, which for settled messages stays stable),
// its timestamp, the rerun-busy flag, or whether its retry/rerun affordances
// are present. Callback identity is intentionally ignored — retryLastUser is
// only ever passed to the streaming last message (whose object changes anyway),
// and the rerun handler is presence-stable for a given cached-run message.
function messagePropsEqual(
  prev: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean },
  next: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean },
): boolean {
  return (
    prev.m === next.m &&
    prev.createdAt === next.createdAt &&
    prev.rerunBusy === next.rerunBusy &&
    !!prev.onRetry === !!next.onRetry &&
    !!prev.onRerun === !!next.onRerun
  );
}

const MessageView = memo(MessageViewImpl, messagePropsEqual);

function wrapChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") return renderTextWithBadges(children);
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === "string" ? <span key={i}>{renderTextWithBadges(c)}</span> : c,
    );
  }
  return children;
}

// Chat-body sanitizing is centralized in `@/lib/sanitize-agent-text`. The chat
// timeline strips BOTH reasoning blocks AND leaked tool-call markup (raw
// <invoke …>/<function_calls>/"# Not a real tool" the model wrote as text) via
// sanitizeChatText, so the rendered body and the copy-to-clipboard path stay in
// sync. Local alias kept for the existing render call sites.
const stripThinkTags = sanitizeChatText;

export function ChatWindow({ threadId }: { threadId: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "notfound" }
    | { kind: "ready"; initial: UIMessage[]; createdAtMap: Record<string, string> }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    (async () => {
      // Confirm the thread exists for this user (RLS-scoped).
      const { data: thread } = await supabase
        .from("threads")
        .select("id")
        .eq("id", threadId)
        .maybeSingle();
      if (!alive) return;
      if (!thread) {
        setState({ kind: "notfound" });
        return;
      }
      const { data } = await supabase
        .from("messages")
        .select("id,role,parts,created_at")
        .eq("thread_id", threadId)
        .order("created_at");
      if (!alive) return;
      const rows = data ?? [];
      const initial: UIMessage[] = rows.map((r) => ({
        id: r.id,
        role: r.role as "user" | "assistant",
        parts: r.parts as UIMessage["parts"],
      }));
      const createdAtMap = Object.fromEntries(rows.map((r) => [r.id, r.created_at]));
      setState({ kind: "ready", initial, createdAtMap });
    })();
    return () => { alive = false; };
  }, [threadId]);

  if (state.kind === "loading") {
    return <FullPageLoader fullScreen={false} className="flex-1 min-w-0" />;
  }
  if (state.kind === "notfound") {
    return (
      <div className="flex-1 grid place-items-center min-w-0 px-6">
        <div className="text-center space-y-3 max-w-sm">
          <div className="inline-flex w-12 h-12 rounded-2xl bg-destructive/10 border border-destructive/30 items-center justify-center mx-auto">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold">Chat not found</h2>
          <p className="text-sm text-muted-foreground">
            This investigation does not exist or you do not have access to it.
          </p>
          <a href="/" className="inline-block text-sm text-primary underline">Back to investigations</a>
        </div>
      </div>
    );
  }

  return (
    <ChatWindowInner
      key={threadId}
      threadId={threadId}
      initial={state.initial}
      initialCreatedAtMap={state.createdAtMap}
    />
  );
}

function ChatWindowInner({
  threadId, initial, initialCreatedAtMap,
}: {
  threadId: string;
  initial: UIMessage[];
  initialCreatedAtMap: Record<string, string>;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [createdAtMap, setCreatedAtMap] = useState<Record<string, string>>(initialCreatedAtMap);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  // Wall-clock of the last genuine upward user scroll. onScroll consults it so a
  // streaming pin / trackpad inertia can't re-engage follow the instant after the
  // analyst scrolls up — re-engagement waits until they SETTLE at the bottom.
  const lastUserScrollUpRef = useRef(0);
  const [input, setInput] = useState("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [stopping, setStopping] = useState(false);
  const failSavedRef = useRef(false);
  const unmountedRef = useRef(false);
  const readyProbedOnceRef = useRef(false);
  // Synchronous re-entrancy lock for scan submission. `status` (from useChat)
  // only flips to "submitted" once sendMessage() runs — which is AFTER the async
  // cache lookup + readiness probe in send(). Without this ref a rapid double/
  // triple-click fires multiple scans (each POST costs credits, and the duplicate
  // messages trigger React "duplicate key" warnings). Set synchronously before
  // any await; released in finally.
  const submitLockRef = useRef(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const { items: artifacts } = useThreadArtifacts(threadId);
  // Targets tools have already been run against — the "already investigated"
  // signal that stops the rail re-suggesting a pivot that's already been run.
  const queriedTargets = useThreadQueriedTargets(threadId);
  const [seedValue, setSeedValue] = useState<string | null>(null);
  // Skipped pivots (normalized-target keys) so a lead the analyst dismissed in
  // the Pivots tab never reappears in the chat rail. Hydrated from localStorage
  // and kept in sync via the skip-changed event other surfaces dispatch.
  const [pivotSkip, setPivotSkip] = useState<Set<string>>(new Set());
  // Which "Next steps" card is expanded into its full mini-brief (click to open).
  const [expandedPivot, setExpandedPivot] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; type: string; path: string; url: string; uploading?: boolean }>
  >([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setSeedValue((data as { seed_value: string | null } | null)?.seed_value ?? null);
      });
    return () => { alive = false; };
  }, [threadId]);

  useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem(pivotSkipStorageKey(threadId));
        setPivotSkip(new Set(raw ? (JSON.parse(raw) as string[]) : []));
      } catch {
        setPivotSkip(new Set());
      }
    };
    load();
    const onSkipChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (!detail || detail.threadId === threadId) load();
    };
    window.addEventListener("swarmbot:pivot-skip-changed", onSkipChanged as EventListener);
    return () => window.removeEventListener("swarmbot:pivot-skip-changed", onSkipChanged as EventListener);
  }, [threadId]);

  // Track unmount so we can ignore the fetch-abort error that fires when the
  // analyst navigates to another thread mid-stream. The investigation keeps
  // running server-side (see edge function: no req.signal + waitUntil).
  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  const [transport] = useState(() => new DefaultChatTransport({
    api: FUNCTIONS_URL,
    body: { threadId },
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const { data } = await supabase.auth.getSession();
      const headers = new Headers(init?.headers);
      if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
      return fetchWithRetry(url, { ...init, headers });
    },
  }));

  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    id: threadId,
    messages: initial,
    transport,
    onError: async (e) => {
      if (!user || failSavedRef.current) return;
      // Ignore aborts caused by the user navigating away — the run continues
      // in the background and onFinish will save the assistant message.
      const msg = String(e?.message ?? "");
      const isAbort =
        unmountedRef.current ||
        (e as { name?: unknown })?.name === "AbortError" ||
        /abort|aborted|cancel|user aborted|the operation was aborted/i.test(msg);
      if (isAbort) return;
      failSavedRef.current = true;
      const reason = (e?.message ?? "stream failed").slice(0, 500);
      const friendly = describeTransportError(e);
      // 401 → session expired — route to auth immediately
      if (parseHttpStatusFromError(e) === 401) {
        toast.error(friendly);
        navigate("/auth");
        return;
      }
      // Persist a failed assistant marker so reload shows the failed card
      await supabase.from("messages").insert({
        thread_id: threadId,
        user_id: user.id,
        role: "assistant",
        parts: [{ type: "text", text: `${FAIL_PREFIX}${reason}` }] as never,
      });
      toast.error(`Investigation run failed: ${friendly}`);
    },
  });

  // Reset fail guard on new turn
  useEffect(() => {
    if (status === "submitted" || status === "streaming") failSavedRef.current = false;
  }, [status]);

  // Re-seed the chat from the freshly-loaded DB state on (re)mount. useChat keys
  // its message store by `id` (threadId) and that store SURVIVES an unmount, so
  // the `messages: initial` seed above is a no-op when you navigate away during
  // a run and come back — the chat then shows the stale store (often just your
  // input, the aborted stream's partial content discarded) while the assistant
  // work the server persisted via waitUntil sits unused in the DB. Applying the
  // DB-loaded `initial` here makes the DB the source of truth on return, which
  // also covers a run that finished while you were away (the realtime recovery
  // subscription only catches INSERTs that land after you're back). We skip
  // while THIS client is actively streaming so a live run is never clobbered.
  //
  // Two guards keep this from WIPING history (the "minimize → restore lost my
  // whole chat" bug):
  //   1. Apply each freshly-loaded `initial` snapshot AT MOST ONCE. A bare
  //      `setMessages(initial)` re-fires whenever this effect re-runs against the
  //      SAME mount-time `initial` — e.g. a re-render after a run (setMessages
  //      identity churn) or a minimize→restore — resetting the store back to the
  //      mount-time snapshot and erasing everything streamed since.
  //   2. Never let a stale/shorter snapshot clobber a fuller live store. The
  //      surviving useChat store can legitimately hold more than the DB load
  //      (just-streamed reply not yet read back), so only adopt `initial` when it
  //      is at least as long — the realtime subscription fills any remaining gap.
  const seededInitialRef = useRef<UIMessage[] | null>(null);
  useEffect(() => {
    if (status === "streaming" || status === "submitted") return;
    if (seededInitialRef.current === initial) return;
    seededInitialRef.current = initial;
    setMessages((current) => (shouldAdoptInitialMessages(initial.length, current.length) ? initial : current));
  }, [initial, status, setMessages]);

  useEffect(() => {
    const channel = supabase
      .channel(`chat-message-recovery-${threadId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const row = payload.new as {
            id?: string;
            role?: "user" | "assistant";
            parts?: UIMessage["parts"];
            created_at?: string;
          };
          if (!row.id || !row.role || !Array.isArray(row.parts)) return;
          const serialized = JSON.stringify(row.parts);
          setMessages((current) => {
            const alreadyPresent = current.some((message) =>
              message.id === row.id ||
              (message.role === row.role && JSON.stringify(message.parts) === serialized)
            );
            if (alreadyPresent) return current;
            return [...current, {
              id: row.id,
              role: row.role,
              parts: row.parts,
            } as UIMessage];
          });
          if (row.created_at) {
            setCreatedAtMap((current) => ({ ...current, [row.id!]: row.created_at! }));
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [setMessages, threadId]);

  // Pin the viewport to the true bottom. Internally gated on followLatestRef so a
  // disengage (user scrolled up) STICKS: this is the single chokepoint every
  // auto-scroll path funnels through, so once follow is off NOTHING can yank the
  // analyst back down until they deliberately return to the bottom (or hit the
  // Jump-to-latest pill). The call sites stay guarded too, but this is the
  // authoritative guard.
  const pinToBottom = useCallback(() => {
    if (!followLatestRef.current) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  // New message added / message array changed → pin if following. A single
  // rAF isn't enough because streamed markdown lays out across several frames;
  // the ResizeObserver below catches that continuous growth.
  useEffect(() => {
    // Don't auto-pin an empty thread — the pre-investigation hero card is tall,
    // and scrolling to the bottom clips its header above the fold.
    if (!followLatestRef.current || messages.length === 0) return;
    const frame = requestAnimationFrame(pinToBottom);
    return () => cancelAnimationFrame(frame);
  }, [messages, pinToBottom]);

  // While streamed content grows (markdown/tables/code lay out asynchronously),
  // keep the view pinned to the bottom so the live reply stays visible instead
  // of landing "a few messages up". Observes the message content wrapper.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (followLatestRef.current && messages.length > 0) pinToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [pinToBottom, messages.length]);

  // Disengage follow on genuine user-intent scrolling (wheel up / touch drag
  // down). These events NEVER fire from a programmatic pin, so — unlike the
  // onScroll position check — they can't be swallowed by the rapid mid-stream
  // pins that previously trapped the user at the bottom while a run streamed.
  // Re-engagement is handled in onScroll (when they return to the bottom) and
  // by the Jump-to-latest button.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const disengage = () => {
      // Stamp BEFORE the early-return: a continued upward fling while already
      // disengaged must keep refreshing the cooldown so onScroll stays inert.
      lastUserScrollUpRef.current = Date.now();
      if (!followLatestRef.current) return;
      followLatestRef.current = false;
      setShowJumpToLatest(true);
    };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) disengage(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      // Finger dragging downward reveals earlier messages (scrolls up).
      if ((e.touches[0]?.clientY ?? 0) - touchY > 6) disengage();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, [threadId]);

  const beginInvestigation = useCallback(async () => {
    const { error: statusError } = await supabase
      .from("threads")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", threadId);
    if (statusError) throw statusError;
    lastUserScrollUpRef.current = 0; // a new run is an implicit "follow the latest"
    followLatestRef.current = true;
    setShowJumpToLatest(false);
  }, [threadId]);

  const stopInvestigation = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    // Abort the in-flight browser stream FIRST so the UI stops immediately,
    // regardless of whether the status write below succeeds.
    try {
      stop();
    } catch (abortErr) {
      console.error("stop() threw:", abortErr);
    }
    // Persist "stopped" — this is the status the edge worker's prepareStep polls
    // to abort the in-flight server-side run (the stream is intentionally NOT
    // bound to req.signal, so the browser stop() alone does not halt the
    // server). A failure here means the server run may keep going, so it is
    // surfaced as an error rather than a soft warning.
    try {
      const { error: statusError } = await supabase
        .from("threads")
        .update({ status: "stopped", updated_at: new Date().toISOString() })
        .eq("id", threadId);
      if (statusError) throw statusError;
      toast.info("Investigation stopped");
    } catch (statusErr) {
      console.error("stopInvestigation status update failed:", statusErr);
      // The browser stream was aborted, but without the persisted "stopped"
      // status the server-side worker can keep running — so this is a real error.
      toast.error("Could not fully stop the investigation — the server run may still be active. Retry.");
    } finally {
      setStopping(false);
    }
  }, [stop, stopping, threadId]);

  const jumpToLatest = useCallback(() => {
    lastUserScrollUpRef.current = 0; // clear the cooldown — this is a deliberate return
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: scrollBehavior() });
  }, []);

  const send = async () => {
    const text = input.trim();
    const hasFiles = attachments.length > 0;
    if ((!text && !hasFiles) || isSubmitBlocked(status, submitLockRef.current)) return;
    if (uploading) {
      toast.error("Wait for uploads to finish");
      return;
    }
    submitLockRef.current = true;
    try {
    const attachLines = attachments.map(
      (a) => `- [${a.name}](${a.url}) (${a.type || "file"}, ${formatBytes(a.size)})`,
    );
    const composed = hasFiles
      ? `${text}${text ? "\n\n" : ""}Attached files:\n${attachLines.join("\n")}`
      : text;
    // Try the investigation cache only for the FIRST user message in this thread.
    const isFirstMessage = messages.length === 0;
    if (isFirstMessage && user && !hasFiles) {
      const seed = detectSeed(text);
      if (seed) {
        const { data: hit } = await supabase
          .from("investigation_cache")
          .select("id, result_json, created_at, expires_at")
          .eq("user_id", user.id)
          .eq("seed_kind", seed.kind)
          .eq("seed_value_normalized", seed.normalized)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();
        if (hit) {
          await renderCachedResult(text, {
            ...hit,
            result_json: hit.result_json as CachedInvestigation | null,
          });
          setInput("");
          setAttachments([]);
          return;
        }
      }
    }
    if (!FUNCTIONS_URL) {
      toast.error("Supabase function URL is not configured. Set VITE_SUPABASE_URL (or VITE_SUPABASE_PROJECT_ID) in .env.");
      return;
    }
    // ── Pre-flight readiness probe (once per session) ──
    // GET (not HEAD) so we can read the JSON body and distinguish
    //   404 → function not deployed
    //   200 + ok:true  → ready to scan
    //   503 + ok:false → deployed but a required dep is missing (e.g. orchestrator key)
    if (!readyProbedOnceRef.current) {
      readyProbedOnceRef.current = true;
      const { signal, cancel } = signalWithTimeout(5000);
      try {
        const probeRes = await fetch(`${FUNCTIONS_URL}?health=1`, { method: "GET", signal });
        if (probeRes.status === 404) {
          // NB: `supabase functions deploy` 403s on this Lovable-owned project —
          // the real deploy path is the Lovable mirror sync, not a CLI command.
          toast.error("Backend edge function is not deployed. Deploy osint-agent via the Lovable mirror to continue.");
          return;
        }
        if (probeRes.status === 503 || probeRes.ok) {
          let body: ReadinessBody | null = null;
          try {
            body = (await probeRes.json()) as ReadinessBody;
          } catch {
            body = null;
          }
          const decision = interpretReadinessProbe(probeRes.status, body);
          if (decision.block) {
            toast.error(decision.message);
            return;
          }
        }
      } catch (probeErr) {
        if ((probeErr as Error)?.name === "TimeoutError" || (probeErr as Error)?.name === "AbortError") {
          toast.error("Scan backend timed out — Supabase function may be cold-starting. Retry in a few seconds.");
          readyProbedOnceRef.current = false; // allow retry
          return;
        }
        // Network error — let it through; the real sendMessage will surface it
      } finally {
        cancel(); // always clear the manual timer so we don't leak it
      }
    }
    setInput("");
    setAttachments([]);
    try {
      await beginInvestigation();
      await sendMessage({ text: composed });
    } catch (e) {
      // useChat's onError only fires for stream errors. Pre-stream failures
      // (network down, 5xx before the body starts) reject here and would
      // otherwise leave the UI silent.
      console.error("sendMessage failed:", e);
      toast.error(`Failed to send message: ${describeTransportError(e)}`);
    }
    } finally {
      submitLockRef.current = false;
    }
  };

  const onFilesPicked = async (files: FileList | null) => {
    if (!files) return;
    if (!user) {
      // Previously this returned silently, so picking a file before the session
      // loaded looked like a broken upload. Surface it instead.
      toast.error("Sign in to attach files — your session isn't ready yet.");
      return;
    }
    const list = Array.from(files);
    const MAX = 20 * 1024 * 1024; // 20MB
    const accepted = list.filter((f) => {
      if (f.size > MAX) {
        toast.error(`${f.name} exceeds 20MB`);
        return false;
      }
      return true;
    });
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      await Promise.all(
        accepted.map(async (file) => {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const safeName = file.name.replace(/[^\w.-]+/g, "_");
          const path = `${user.id}/${threadId}/${id}-${safeName}`;
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, size: file.size, type: file.type, path, url: "", uploading: true },
          ]);
          const { error: upErr } = await supabase.storage
            .from("chat-uploads")
            .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
          if (upErr) {
            toast.error(`Upload failed: ${file.name}`);
            setAttachments((prev) => prev.filter((a) => a.id !== id));
            return;
          }
          const { data: signed } = await supabase.storage
            .from("chat-uploads")
            .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, url: signed?.signedUrl ?? "", uploading: false } : a)),
          );
        }),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = async (id: string) => {
    const a = attachments.find((x) => x.id === id);
    setAttachments((prev) => prev.filter((x) => x.id !== id));
    if (a?.path) {
      await supabase.storage.from("chat-uploads").remove([a.path]).catch(() => {});
    }
  };

  // Send arbitrary text without going through the input (used by pivots + suggestions).
  const sendText = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || isSubmitBlocked(status, submitLockRef.current)) return;
    submitLockRef.current = true;
    try {
      await beginInvestigation();
      await sendMessage({ text: t });
    } catch (e) {
      console.error("sendText failed:", e);
      toast.error(`Failed to send message: ${describeTransportError(e)}`);
    } finally {
      submitLockRef.current = false;
    }
  }, [beginInvestigation, sendMessage, status]);

  // Listen for "run pivot" events dispatched from the Pivots tab.
  useEffect(() => {
    const onRunPivot = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId: string; value: string; type?: string; prompt?: string }>).detail;
      if (!detail || detail.threadId !== threadId) return;
      const prompt = detail.prompt ??
        `Pivot on ${detail.value}${detail.type ? ` (${detail.type})` : ""}. Run the next investigation step on this lead.`;
      void sendText(prompt);
    };
    window.addEventListener("proximity:run-pivot", onRunPivot as EventListener);
    return () => window.removeEventListener("proximity:run-pivot", onRunPivot as EventListener);
  }, [threadId, sendText]);

  // Render a cached investigation: insert user msg + cached artifacts + synthetic
  // assistant msg (with cache banner sentinel part) into the DB, then reload state.
  const renderCachedResult = async (
    userText: string,
    hit: { id: string; result_json: CachedInvestigation | null; created_at: string; expires_at: string },
  ) => {
    if (!user) return;
    const cached: CachedInvestigation = hit.result_json ?? {};
    const assistantParts = Array.isArray(cached.assistant_parts) ? cached.assistant_parts : [];
    const cachedArtifacts: CachedArtifact[] =
      Array.isArray(cached.artifacts) ? cached.artifacts : [];

    // Track inserts so we can roll back if any later step fails — otherwise
    // a mid-sequence DB error leaves orphaned artifacts / user message and
    // the chat renders broken.
    let userRowId: string | null = null;
    let asstRowId: string | null = null;
    let artifactsInserted = false;
    const rollback = async () => {
      try {
        if (asstRowId) await supabase.from("messages").delete().eq("id", asstRowId);
        if (artifactsInserted) {
          await supabase
            .from("artifacts")
            .delete()
            .eq("thread_id", threadId)
            .eq("metadata->>from_cache", "true");
        }
        if (userRowId) await supabase.from("messages").delete().eq("id", userRowId);
      } catch (e) {
        console.error("renderCachedResult rollback failed:", e);
      }
    };

    try {
      // 1) user message
      const userParts = [{ type: "text", text: userText }];
      const { data: userRow, error: userErr } = await supabase
        .from("messages")
        .insert({ thread_id: threadId, user_id: user.id, role: "user", parts: userParts as never })
        .select("id, created_at")
        .single();
      if (userErr || !userRow) throw userErr ?? new Error("user message insert returned no row");
      userRowId = userRow.id;

      // 2) clone artifacts into this thread, marked as cached
      if (cachedArtifacts.length > 0) {
        const { error: artErr } = await supabase.from("artifacts").insert(
          cachedArtifacts.map((a) => ({
            thread_id: threadId,
            user_id: user.id,
            kind: a.kind,
            value: a.value,
            confidence: a.confidence ?? null,
            source: a.source ?? null,
            metadata: { ...(a.metadata ?? {}), from_cache: true } as never,
          })) as never,
        );
        if (artErr) throw artErr;
        artifactsInserted = true;
      }

      // 3) synthetic assistant message with banner sentinel part
      const synthParts = [
        { type: CACHE_BANNER_TYPE, data: { cachedAt: hit.created_at, expiresAt: hit.expires_at } },
        ...assistantParts,
      ];
      const { data: asstRow, error: asstErr } = await supabase
        .from("messages")
        .insert({ thread_id: threadId, user_id: user.id, role: "assistant", parts: synthParts as never })
        .select("id, created_at")
        .single();
      if (asstErr || !asstRow) throw asstErr ?? new Error("assistant message insert returned no row");
      asstRowId = asstRow.id;

      // 4) thread bookkeeping (title from seed if still default)
      const { error: threadErr } = await supabase
        .from("threads")
        .update({
          title: formatThreadTitle(userText),
          seed_value: userText.slice(0, 200),
          updated_at: new Date().toISOString(),
        })
        .eq("id", threadId)
        .eq("title", "New investigation");
      if (threadErr) throw threadErr;

      // 5) push into local chat state
      setMessages((prev) => [
        ...prev,
        { id: userRow.id, role: "user", parts: userParts as UIMessage["parts"] },
        { id: asstRow.id, role: "assistant", parts: synthParts as UIMessage["parts"] },
      ]);
      setCreatedAtMap((prev) => ({
        ...prev,
        [userRow.id]: userRow.created_at,
        [asstRow.id]: asstRow.created_at,
      }));
      toast.success("Loaded cached investigation");
    } catch (e) {
      console.error("renderCachedResult failed, rolling back:", e);
      await rollback();
      toast.error("Failed to load cached investigation");
    }
  };

  const rerunInvestigation = async () => {
    if (!user || rerunBusy) return;
    // Block rerun while a stream is in flight — otherwise both streams race
    // and we get duplicate user/assistant inserts plus double artifact writes.
    if (status === "streaming" || status === "submitted") {
      toast.error("Wait for the current run to finish");
      return;
    }
    const firstUser = messages.find((m) => m.role === "user") as UIMessage | undefined;
    if (!firstUser) return;
    const text = (firstUser.parts as MessagePartShape[]).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
    if (!text) return;
    const seed = detectSeed(text);
    if (!seed) return;
    setRerunBusy(true);
    try {
      // Invalidate the user's cache entry for this seed.
      await supabase
        .from("investigation_cache")
        .delete()
        .eq("user_id", user.id)
        .eq("seed_kind", seed.kind)
        .eq("seed_value_normalized", seed.normalized);
      // Drop the synthetic cached assistant + its artifacts so we start clean.
      // Only delete artifacts that came from the cache replay (tagged with
      // metadata.from_cache = true) — preserve any manual or follow-up
      // artifacts the user recorded in this thread.
      await supabase
        .from("artifacts")
        .delete()
        .eq("thread_id", threadId)
        .eq("metadata->>from_cache", "true");
      const synthIds = messages
        .filter((m) => m.role === "assistant" && (m.parts as MessagePartShape[]).some((p) => p?.type === CACHE_BANNER_TYPE))
        .map((m) => m.id);
      if (synthIds.length > 0) {
        await supabase.from("messages").delete().in("id", synthIds);
      }
      setMessages((prev) => prev.filter((m) => !(m.role === "assistant" && (m.parts as MessagePartShape[]).some((p) => p?.type === CACHE_BANNER_TYPE))));
      await beginInvestigation();
      await sendMessage({ text });
    } finally {
      setRerunBusy(false);
    }
  };

  // The command palette's "Re-run Insight Finder on current seed" action lives in
  // a sibling component, so it reaches the run lifecycle through this window
  // event. A ref keeps the closure fresh without re-binding the listener on every
  // streamed-token re-render.
  const rerunRef = useRef(rerunInvestigation);
  rerunRef.current = rerunInvestigation;
  useEffect(() => {
    const onRerun = () => { void rerunRef.current(); };
    window.addEventListener("swarmbot:rerun", onRerun);
    return () => window.removeEventListener("swarmbot:rerun", onRerun);
  }, []);

  const retryLastUser = async () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user") as UIMessage | undefined;
    if (!lastUser) return toast.error("No previous message to retry");
    const text = (lastUser.parts as MessagePartShape[]).filter((p) => p.type === "text").map((p) => p.text).join("");
    if (!text) return toast.error("Last message was empty");
    // Optimistically remove the trailing failed assistant message from view
    setMessages((prev) => {
      const out = [...prev];
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.role === "assistant") {
          const t = (m.parts as MessagePartShape[])?.find?.((p) => p.type === "text");
          if (t?.text?.startsWith?.(FAIL_PREFIX)) { out.splice(i, 1); break; }
        }
      }
      return out;
    });
    await beginInvestigation();
    await sendMessage({ text });
  };

  const isLoading = status === "submitted" || status === "streaming";

  // Broadcast live run state so the case header never shows COMPLETE while
  // the chat stream is still open (tool_usage_log can lag 12s+ between calls).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("proximity:run-state", {
        detail: { threadId, running: isLoading },
      }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("proximity:run-state", {
          detail: { threadId, running: false },
        }),
      );
    };
  }, [threadId, isLoading]);

  // Run progress readout for the "Investigating…" indicator: an elapsed timer
  // (plus the current tool step) so an analyst can distinguish a working run
  // from a wedged one instead of staring at a bare pulsing dot.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  useEffect(() => {
    if (isLoading) {
      setRunStartedAt((prev) => prev ?? Date.now());
    } else {
      setRunStartedAt(null);
      setRunElapsedMs(0);
    }
  }, [isLoading]);
  useEffect(() => {
    if (!isLoading || runStartedAt == null) return;
    const tick = () => setRunElapsedMs(Date.now() - runStartedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isLoading, runStartedAt]);
  const runElapsedLabel = (() => {
    const s = Math.floor(runElapsedMs / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  })();
  const currentStep = useMemo(() => {
    if (!isLoading) return null;
    const lastAsst = [...messages].reverse().find((mm) => mm.role === "assistant");
    if (!lastAsst) return null;
    const toolParts = (lastAsst.parts as MessagePartShape[]).filter(
      (p) => typeof p.type === "string" && p.type.startsWith("tool-"),
    );
    const inFlight = [...toolParts].reverse().find(
      (p) => p.state !== "output-available" && p.state !== "output-error",
    );
    const chosen = inFlight ?? toolParts[toolParts.length - 1];
    if (!chosen || typeof chosen.type !== "string") return null;
    return toolDisplayName(chosen.type.replace(/^tool-/, ""));
  }, [isLoading, messages]);

  const reportPivots = useMemo(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!latestAssistant) return [];
    const text = (latestAssistant.parts as MessagePartShape[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return extractRecommendedPivots(text);
  }, [messages]);

  // Broadcast the LIVE report pivots for the current thread. Deliberately NOT
  // persisted and NOT gated on a non-empty array: a report-less turn dispatches
  // [] so downstream surfaces CLEAR instead of holding a stale, frozen cache
  // (the recurring "same pivots forever" bug). The Pivots tab listens for this.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", {
      detail: { threadId, pivots: reportPivots },
    }));
  }, [reportPivots, threadId]);

  // Answer a late-mounting surface (e.g. the Pivots tab opened after the last
  // turn) that asks for the current report pivots. Without this replay, that
  // surface would show only artifact-derived pivots until the next turn.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (detail?.threadId !== threadId) return;
      window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", {
        detail: { threadId, pivots: reportPivots },
      }));
    };
    window.addEventListener("swarmbot:request-report-pivots", onRequest as EventListener);
    return () => window.removeEventListener("swarmbot:request-report-pivots", onRequest as EventListener);
  }, [reportPivots, threadId]);

  // Build suggested next-step replies after the agent stops streaming.
  // Memoized — without this the IIFE re-runs on every streamed token because
  // `messages` updates dozens of times per second during streaming.
  const suggestions = useMemo(() => {
    if (isLoading || messages.length === 0) return [] as NextStepSuggestion[];
    const hasAssistant = messages.some((m) => m.role === "assistant");
    if (!hasAssistant) return [];
    const out: NextStepSuggestion[] = [];
    const seenLabels = new Set<string>();
    // ONE engine over LIVE state: report recommendations + artifact findings,
    // deduped, already-run-filtered and ranked. Chat only takes the top 3
    // still-actionable ("new") pivots; already-searched ones sink to the Pivots
    // tab. Recomputes whenever artifacts stream in or a new turn lands.
    const ranked = computePivots({ artifacts, seedValue, reportPivots, skipSet: pivotSkip, queriedSet: queriedTargets });
    for (const p of ranked.filter((candidate) => candidate.status === "new").slice(0, 3)) {
      seenLabels.add(p.actionLabel);
      out.push({
        title: p.actionLabel,
        detail: p.detail,
        prompt: p.prompt,
        icon: "pivot",
        meta: `${p.type} verification`,
        priority: p.priority,
        target: p.value,
      });
    }
    // Always include 1-2 generic next steps as fallback.
    const generic = [
      { title: "Summarize findings", detail: "Rank strongest claims and confidence", prompt: "Summarize the strongest findings so far and rate overall confidence.", meta: "report" },
      { title: "Check for breaches", detail: "Run credential exposure on strongest identifiers", prompt: "Run breach and credential-exposure checks on the strongest identifiers found so far.", meta: "verification" },
      { title: "Find more pivots", detail: "Return the next 3 highest-value leads", prompt: "Suggest the next 3 highest-value pivots based on what's been discovered.", meta: "planning" },
    ] as const;
    for (const g of generic) {
      if (out.length >= 4) break;
      if (seenLabels.has(g.title)) continue;
      seenLabels.add(g.title);
      out.push({ ...g, icon: "spark" });
    }
    // Collapse cards that point at the same normalized target + action — e.g.
    // "Review lead · Damien O Brien" and "Review lead · Damien O'Brien" surfaced
    // from the same source are one lead, not two. Keep the first (highest-ranked).
    return dedupeCards(out).slice(0, 4);
  }, [isLoading, messages, artifacts, seedValue, reportPivots, pivotSkip, queriedTargets]);

  return (
    <div className="chat-stage relative h-full min-w-0 overflow-hidden bg-background">
      {/* Soft stage wash — fills the main pane so content doesn't float in void */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -10%, hsl(220 40% 18% / 0.35), transparent 55%), radial-gradient(ellipse 70% 40% at 50% 110%, hsl(220 30% 10% / 0.4), transparent 50%)",
        }}
      />
      <div
        ref={scrollRef}
        onScroll={(event) => {
          // Re-engage follow ONLY when the analyst has SETTLED at the very bottom.
          // Disengaging is driven exclusively by the user-intent listeners
          // (wheel/touch) above, so a programmatic pin that momentarily lands
          // short while streamed content is still growing can never be misread
          // as the user scrolling away. Two extra constraints stop a streaming
          // pin or trackpad inertia from snapping a scrolled-up analyst back down:
          //   • a tight re-engage band (must be essentially at the bottom), and
          //   • a short cooldown after the last upward scroll, so the burst of
          //     onScroll events from an inertial fling can't re-engage mid-flight.
          const COOLDOWN_MS = 450;
          const viewport = event.currentTarget;
          const settled = Date.now() - lastUserScrollUpRef.current > COOLDOWN_MS;
          if (settled && shouldFollowChatScroll(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight, CHAT_REENGAGE_THRESHOLD_PX)) {
            followLatestRef.current = true;
            setShowJumpToLatest(false);
          }
        }}
        className="chat-stage__scroll relative z-10"
      >
        <div className="chat-stage__frame">
        <div ref={contentRef} className="chat-column space-y-3 min-w-0">
          {messages.length === 0 && (
            <div className="flex flex-col items-center px-4 py-6 text-center sm:py-8">
              {/* halftone signal-field hero — a dotted intel field with a slow
                  radar sweep passing over it. Distinctive + on-brand; no asset. */}
              <div className="relative mb-6 h-28 w-full max-w-[280px] select-none" aria-hidden>
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle, hsl(var(--intel-blue) / 0.7) 1px, transparent 1.5px)",
                    backgroundSize: "9px 9px",
                    WebkitMaskImage:
                      "radial-gradient(58% 78% at 50% 50%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 72%)",
                    maskImage:
                      "radial-gradient(58% 78% at 50% 50%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 72%)",
                  }}
                />
                <div
                  className="absolute left-1/2 top-1/2 h-36 w-36 -translate-x-1/2 -translate-y-1/2 animate-[spin_7s_linear_infinite] rounded-full motion-reduce:animate-none"
                  style={{
                    background:
                      "conic-gradient(from 0deg, transparent 0deg, transparent 308deg, hsl(var(--intel-blue) / 0.32) 350deg, hsl(var(--intel-blue) / 0.7) 360deg)",
                    WebkitMaskImage: "radial-gradient(circle, #000 0%, transparent 70%)",
                    maskImage: "radial-gradient(circle, #000 0%, transparent 70%)",
                  }}
                />
                <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[hsl(var(--intel-blue))] shadow-[0_0_12px_3px_hsl(var(--intel-blue)/0.7)]" />
              </div>

              <h1 className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[2rem]">
                What are we investigating?
              </h1>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                Drop an email, username, phone, IP, domain, or wallet — the agent
                routes providers, pivots across what it finds, and lands evidence
                with confidence tiers.
              </p>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                {["jordan.sample@example.com", "elonmusk", "8.8.8.8", "lovable.app"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 font-mono text-data tabular-nums text-foreground/75 transition-colors hover:border-[hsl(var(--intel-blue)/0.45)] hover:bg-[hsl(var(--intel-blue)/0.07)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--intel-blue)/0.4)]"
                  >
                    {s}
                  </button>
                ))}
              </div>

              {/* clean hairline steps (à la the references) — understated, no boxes */}
              <div className="mt-8 w-full max-w-md border-t border-white/[0.06] text-left">
                {[
                  ["01", "Seed", "Email, username, phone, IP, domain, or wallet."],
                  ["02", "Route", "The agent selects providers and pivots on what it finds."],
                  ["03", "Reveal", "Evidence lands on the board with confidence tiers."],
                ].map(([n, t, d]) => (
                  <div key={n} className="flex gap-4 border-b border-white/[0.06] py-3">
                    <span className="font-mono text-data tabular-nums text-[hsl(var(--intel-blue)/0.85)]">{n}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{t}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, idx) => {
            const isLastAssistant = m.role === "assistant" && idx === messages.length - 1;
            const hasCacheBanner = m.role === "assistant" && (m.parts as MessagePartShape[]).some((p) => p?.type === CACHE_BANNER_TYPE);
            return (
              <MessageView
                key={m.id}
                m={m}
                createdAt={createdAtMap[m.id]}
                onRetry={isLastAssistant ? retryLastUser : undefined}
                onRerun={hasCacheBanner ? rerunInvestigation : undefined}
                rerunBusy={rerunBusy}
              />
            );
          })}
          {isLoading && (
            <div
              className="flex items-center gap-2.5 text-sm"
              role="status"
              aria-live="polite"
              aria-label="Investigation in progress"
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              <span className="font-medium text-foreground/85">
                {currentStep ? `Investigating · ${currentStep}` : "Investigating…"}
              </span>
              <span className="font-mono text-data tabular-nums text-muted-foreground/70">
                {runElapsedLabel}
              </span>
            </div>
          )}
          {error && !isLoading && (
            <FailedRunCard reason={error.message} onRetry={retryLastUser} />
          )}
          {suggestions.length > 0 && (
            <div className="chat-next-steps w-full animate-fade-up">
              <div className="chat-next-steps__head">
                <Sparkles className="h-3 w-3 shrink-0 opacity-80" />
                <span>Next steps</span>
                <span className="ml-auto font-mono text-[10px] font-medium tabular-nums tracking-normal normal-case opacity-70">
                  {suggestions.length}
                </span>
              </div>
              <div className="chat-next-steps__list">
                {suggestions.map((s, i) => {
                  const cardId = `${s.title}-${i}`;
                  const expanded = expandedPivot === cardId;
                  return (
                    <div key={cardId} className="chat-next-steps__row group">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        aria-expanded={expanded}
                        onClick={() => setExpandedPivot(expanded ? null : cardId)}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {s.priority && (
                            <span className={`pivot-priority pivot-priority--${s.priority} shrink-0`}>
                              {s.priority}
                            </span>
                          )}
                          <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                            {s.title}
                          </span>
                          {s.meta && (
                            <span className="hidden truncate text-[10px] text-muted-foreground/75 sm:inline">
                              · {s.meta}
                            </span>
                          )}
                        </div>
                        {s.detail && (
                          <p
                            className={cn(
                              "mt-0.5 text-[11px] leading-snug text-muted-foreground",
                              !expanded && "line-clamp-1",
                            )}
                          >
                            {s.detail}
                          </p>
                        )}
                        {expanded && s.target && (
                          <p className="mt-1 flex items-center gap-1.5 text-[11px]">
                            <span className="text-muted-foreground/70">Target</span>
                            <span className="truncate font-mono text-foreground/85">{s.target}</span>
                          </p>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => sendText(s.prompt)}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/12 bg-white/[0.05] px-2.5 text-[11px] font-medium text-foreground/90 transition-colors hover:border-white/20 hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Run
                        <ArrowRight className="h-3 w-3 opacity-70" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        </div>
        {showJumpToLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="pointer-events-auto sticky bottom-4 z-20 ml-auto mr-4 flex h-9 items-center gap-2 rounded-full border border-white/10 bg-surface-2/95 px-3 text-data font-medium text-foreground shadow-[0_16px_40px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl hover:bg-surface-3"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}
      </div>

      <div className="relative z-10 border-t border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_22%_6%/0.92),hsl(222_24%_4%/0.96))] px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-7 sm:pt-4 sm:pb-5 backdrop-blur-xl">
        <div className="chat-column">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => {
                const isImg = a.type.startsWith("image/");
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full border border-border-subtle bg-surface-1 text-xs max-w-[260px]"
                  >
                    {a.uploading ? (
                      <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                    ) : isImg ? (
                      <ImageIcon className="w-3 h-3 text-primary" />
                    ) : (
                      <FileText className="w-3 h-3 text-primary" />
                    )}
                    <span className="truncate">{a.name}</span>
                    <span className="text-muted-foreground text-data">{formatBytes(a.size)}</span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="ml-0.5 p-0.5 rounded-full hover:bg-white/10 text-muted-foreground hover:text-foreground"
                      aria-label="Remove attachment"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="rounded-[22px] sm:rounded-[28px] border border-white/10 bg-surface-0 p-1 shadow-[0_24px_54px_-42px_rgba(0,0,0,0.95)]">
            <div className="relative rounded-[18px] sm:rounded-[24px] border border-white/10 bg-background transition-colors focus-within:border-white/20">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.csv,.json,.eml,.html,.md"
                className="hidden"
                onChange={(e) => onFilesPicked(e.target.files)}
              />
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Investigate an email, username, phone, IP, or domain…"
                aria-label="Investigation query — enter an email, username, phone, IP, or domain"
                rows={2}
                className="min-h-[72px] max-h-32 font-chat bg-transparent border-0 resize-none overflow-y-auto focus-visible:ring-0 focus-visible:ring-offset-0 pl-[3.25rem] sm:pl-14 pr-14 sm:pr-16 py-3 sm:py-4 text-body leading-6 tracking-[-0.01em] placeholder:text-muted-foreground/70"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                className="absolute bottom-3 left-2.5 rounded-full h-9 w-9 bg-surface-1 hover:bg-surface-2 border border-white/10 text-muted-foreground hover:text-foreground transition-all"
                aria-label="Attach file"
                title="Attach file"
              >
                <Paperclip className="w-4 h-4" />
              </Button>
              <Button
                onClick={isLoading ? stopInvestigation : send}
                disabled={isLoading ? stopping : ((!input.trim() && attachments.length === 0) || uploading)}
                size="icon"
                className={cn(
                  "absolute bottom-3 right-2.5 rounded-2xl h-10 w-10 border-0",
                  isLoading
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-[0_8px_24px_-10px_hsl(var(--danger)/0.65)]"
                    : "bg-gradient-to-br from-primary to-[hsl(var(--intel-violet))] hover:opacity-95 text-primary-foreground shadow-[0_8px_24px_-8px_hsl(var(--intel-blue)/0.7)]",
                )}
                aria-label={isLoading ? "Stop investigation" : "Start investigation"}
                title={isLoading ? "Stop investigation" : "Start investigation"}
              >
                {isLoading
                  ? stopping
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Square className="w-3.5 h-3.5 fill-current" />
                  : <ArrowUp className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
