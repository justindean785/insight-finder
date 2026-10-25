import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
  StickyNote, CheckCircle2, XCircle, Clock, CircleSlash, Square, Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { detectSeed, formatThreadTitle } from "@/lib/seed";
import { checkCachedHitSafety, useReviewStates, type ReviewState } from "@/lib/review";
import { buildDecisionSets, isManualDispatchRefused } from "@/lib/analyst-decisions";
import { KIND_TO_PIVOT } from "@/lib/intel";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { useThreadPivotAttempts } from "@/hooks/useThreadPivotAttempts";
import { isSubmitBlocked, submitRefusal, submitRefusalMessage } from "@/lib/submit-guard";
import { messageIntegrity, narrativeIsUnadjudicated } from "@/lib/message-integrity";
import { RunChips, RunMenu } from "@/components/pivots/RunControls";
import { composerPrimary } from "@/lib/composer-primary";
import { useIsMobile } from "@/hooks/use-mobile";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import {
  AUTO_RUN_MAX_CYCLES, AUTO_RUN_OVERLAP_MAX_WAIT_MS, AUTO_RUN_OVERLAP_POLL_MS, AUTO_RUN_SETTLE_MS, CONTINUE_PROMPT, REPORT_PROMPT,
  autoRunStopMessage, canShowRunControls, decideAutoContinue,
} from "@/lib/run-controls";
import { cardDedupeKey, normalizeTarget } from "@/lib/next-step-cards";
import { pivotEligibility, pivotSuggestionInput, validatePivotSuggestion, type RunnablePivot } from "@/lib/pivot-schema";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { registerPivotRunner } from "@/lib/pivot-runner";
import { DEFAULT_CONTROLS, evaluatePreflight, type PreflightControls } from "@/lib/composer-preflight";
import { TargetChip } from "@/components/composer/ComposerPreflight";
import { hasReportShape, joinAssistantTranscript, stripReasoningPerPart } from "@/lib/report-shape";
import { findLastReportIndex, isReportMessage } from "@/lib/superseded-reports";
import { dedupeCheckpoints } from "@/lib/chat-checkpoints";
import { computePivots } from "@/lib/pivot-engine";
import { buildEntityGraph } from "@/lib/entity-graph";
import { summarizeConnections } from "@/lib/connection-summary";
import { pickAutoPivot } from "@/lib/best-pivot";
import { sanitizeChatText } from "@/lib/sanitize-agent-text";
import { scrollBehavior } from "@/lib/motion";
import { fetchWithRetry } from "@/lib/fetch-retry";
import {
  deriveToolCharge, deriveToolPreview, deriveToolRuntime, deriveToolTone, describeTransportError,
  isNetworkDropError, isTransportAuthFailure, withHttpStatusInErrorBody,
} from "@/lib/tool-run";
import { isRunHeartbeatAlive } from "@/lib/stale-thread";
import { shouldFollowChatScroll, shouldAdoptInitialMessages, CHAT_REENGAGE_THRESHOLD_PX } from "@/lib/chat-scroll";
import {
  extractRecommendedPivots,
  pivotSkipStorageKey,
  type RecommendedPivot,
} from "@/lib/recommended-pivots";
import { Sparkles, GitBranch, Paperclip, X, FileText, Image as ImageIcon, Copy as CopyIcon, ArrowRight } from "lucide-react";
import { parseUserMessage, isImageAttachment } from "@/lib/attachments";
import { toolDisplayName, toolActionLabel, toolAgentRole, humanizeStage } from "@/lib/tool-display";
import { humanizeSelector } from "@/lib/humanize-selector";
import { measureRequestBody, reportRequestBodySize } from "@/lib/request-size";
import { currentRunEvents, isCurrentRunMessage, shouldFollowServer, shouldForceStreamEnd } from "@/lib/server-follow";
import { ServerFollowPanel } from "@/components/chat/ServerFollowPanel";
import { useHeldTrue } from "@/hooks/use-held-true";
import {
  isTerminalThreadUpdate,
  mergePersistedChatMessages,
  shouldAbortClientStream,
  type TerminalThreadUpdate,
  applyRealtimeInsert,
} from "@/lib/chat-terminal-reconcile";

const SUPABASE_PROJECT_ID = (import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined)?.trim();
// Resolve from the client's SUPABASE_URL (which carries the baked-in default),
// NOT raw import.meta.env — otherwise a deploy without VITE_SUPABASE_URL set
// resolves this to "" and every scan dies with "function URL not configured",
// even though the supabase client itself works off the default. osintAgentUrl
// also strips a trailing /functions/v1 so a misconfigured base can't double it.
const FUNCTIONS_URL = osintAgentUrl(SUPABASE_URL, SUPABASE_PROJECT_ID);

const FAIL_PREFIX = "__STATUS__:failed:";
const CACHE_BANNER_TYPE = "data-investigation-cache";


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

/**
 * One artifact stored in an investigation_cache.result_json blob. `id` is the
 * ORIGIN artifact's id (the row in the source thread that produced this
 * cache entry) — required to join against artifact_reviews at replay time;
 * see checkCachedHitSafety() in src/lib/review.ts.
 */
type CachedArtifact = {
  id?: string;
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Shape of investigation_cache.result_json (only the fields we replay).
 * cache_version 2+ carries origin_thread_id — the source thread whose
 * artifact_reviews must be re-checked before this row is ever replayed
 * verbatim (a review made AFTER this row was cached is otherwise invisible
 * to a client-side cache hit, since replay never calls osint-agent). A row
 * missing cache_version/origin_thread_id is a pre-fix (version-1) row and
 * MUST be treated as inadmissible — see the isFirstMessage cache-hit block.
 */
type CachedInvestigation = {
  cache_version?: number;
  origin_thread_id?: string;
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
      // Speaker rail: three different kinds of claim (the agent's reasoning, the
      // analyst's own words, the machine's tool traffic) were distinguished only
      // by card padding, so skimming a long transcript meant reading every line
      // to find out who was talking.
      data-speaker={failed ? "failed" : "tool"}
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
    const selector = typeof runtime?.selector === "string" && runtime.selector
      ? humanizeSelector(runtime.selector)
      : toolActionLabel(name);
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

// Cycle badges. Failures are shown (T10, 2026-10-21): the June beta rule that hid
// them here (#120 / 7462ba4) left chat as the one surface where a failed call was
// invisible while the case bar, Overview and Tools tab all counted it. Exported
// solely for a regression test; it is a pure helper, not a component.
// eslint-disable-next-line react-refresh/only-export-components
export function cycleSummaryBadges(group: {
  cached: number;
  stale: number;
  skipped: number;
  useful: number;
  failed: number;
}): string[] {
  return [
    group.cached > 0 ? `${group.cached} cached` : null,
    group.stale > 0 ? `${group.stale} stale` : null,
    group.skipped > 0 ? `${group.skipped} skipped` : null,
    group.useful > 0 ? `${group.useful} completed` : null,
    group.failed > 0 ? `${group.failed} failed` : null,
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
    <div className="chat-card px-4 py-3" data-speaker="system">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        <GitBranch className="h-3 w-3 text-muted-foreground" />
        Run flow
      </div>
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
        {groups.map((group, index) => {
          const tone = flowToneForGroup(group);
          const isLast = index === groups.length - 1;
          // De-stutter: when this chip shares the previous chip's stage, drop the
          // repeated stage word and show just "cycle N", so a constant-stage run
          // reads "Review cycle 1 → cycle 2 → cycle 3" instead of restating
          // "Review" on every chip.
          const humanStage = humanizeStage(group.stage);
          const prevStage = index > 0 ? humanizeStage(groups[index - 1].stage) : null;
          const railLabel = prevStage === humanStage && group.cycleId > 0
            ? `cycle ${group.cycleId}`
            : cycleSummaryLabel(humanStage, group.cycleId);
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
                <span className="font-mono tracking-normal">{railLabel}</span>
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
  // Every call is listed when a cycle is expanded, failures included (T10): a
  // failed lookup is not a negative finding, and the analyst must be able to see
  // which one failed and why rather than infer it from a count elsewhere.
  const visibleParts = group.parts;
  return (
    <div className="chat-card text-[13px] leading-relaxed text-muted-foreground" data-speaker="tool">
      {/* One row per cycle when collapsed: stage, calls, EV, what it touched,
          what came of it, when. The old three-line card spent ~200px per cycle
          on a run log the analyst mostly scans past; the reason and the calls
          themselves are one click away. */}
      <button
        type="button"
        className="w-full px-3.5 py-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="shrink-0 font-medium text-foreground/90">
            {cycleSummaryLabel(humanizeStage(group.stage), group.cycleId)}
          </span>
          <span className="shrink-0 tabular-nums">{group.parts.length} call{group.parts.length === 1 ? "" : "s"}</span>
          {avgExpected != null && <span className="hidden shrink-0 tabular-nums sm:inline">EV {avgExpected}</span>}
          {(selectors.length > 0 || extra > 0) && (
            <span className="min-w-0 flex-1 truncate text-foreground/70" title={Array.from(new Set(group.selectors)).join(" · ")}>
              {selectors.join(" · ")}{extra > 0 ? ` · +${extra}` : ""}
            </span>
          )}
          {!(selectors.length > 0 || extra > 0) && <span className="flex-1" />}
          {summaryBits.length > 0 && (
            <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">{summaryBits.join(" · ")}</span>
          )}
          {/* Failures stay visible on a phone too, where the chip line above is hidden. */}
          {group.failed > 0 && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[hsl(var(--danger))] sm:hidden" data-testid="cycle-failed">
              {group.failed} failed
            </span>
          )}
          {time && <span className="shrink-0 tabular-nums text-muted-foreground/80">{time}</span>}
        </div>
        {expanded && group.reasons[0] && (
          <div className="mt-1 pl-5 text-[12px] text-muted-foreground/80">
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

/**
 * A label the AGENT typed into its own prose. It is an ASSERTION, never a
 * measurement, and the difference is the whole point of this block.
 *
 * The engine derives and caps confidence server-side (`record_finding` ->
 * `countIndependentClasses`) and those values reach the screen through
 * `ui/confidence.tsx` / `ui/authority.tsx` as FILLED chips. What arrives here is
 * a string the model wrote with nothing behind it. Measured on a real run
 * (2026-09-22): the transcript published "Confirmed (95)" and "Confirmed (90)"
 * while the engine held zero finding rows and a maximum confidence of 65.
 *
 * Until today a stated label was painted with the same token, the same border
 * alpha and the same fill as a computed one, so the two were indistinguishable.
 * Two things changed.
 *
 * IT GIVES UP THE FILL. A filled chip is what a computed value looks like; this
 * one is hollow, and the dashed edge is the texture half of the rule
 * `authority.tsx` already states -- a state that withholds authority is never
 * carried by colour alone. Border alpha rises a little to compensate, because a
 * dashed hairline loses about half its perimeter and reads as a smudge at 10px.
 *
 * IT GIVES UP THE CONFIDENCE RAMP. The 88% -> 39% luminance ladder belongs to
 * the thing that computes confidence; a second copy of it in prose is the
 * "drifting second source of truth" this codebase warns about everywhere else.
 * Stated labels take the INK ramp instead, at three registers that say who is
 * talking rather than how sure anyone is: the agent claims strength (ink 2), the
 * agent hedges (ink 3), the agent flags trouble (the ladder's alarm hue). Every
 * one of them sits below body ink, so the sentence outranks the label on it --
 * which is the correct order, since the sentence is the evidence and the label
 * is an opinion about it.
 */
const STATED_LABEL_SOURCE = "\\[(CONFIRMED|CORRELATED|INFERRED|VERIFY|FAILED|LOW|CONFLICT)\\]";

const LABEL_STYLES: Record<string, string> = {
  // Claims of strength.
  CONFIRMED:  "chat-label-chip text-muted-foreground border-[hsl(var(--muted-foreground)/0.4)]",
  CORRELATED: "chat-label-chip text-muted-foreground border-[hsl(var(--muted-foreground)/0.4)]",
  // Hedges.
  INFERRED:   "chat-label-chip text-subtle-foreground border-[hsl(var(--subtle-foreground)/0.45)]",
  VERIFY:     "chat-label-chip text-subtle-foreground border-[hsl(var(--subtle-foreground)/0.45)]",
  LOW:        "chat-label-chip text-subtle-foreground border-[hsl(var(--subtle-foreground)/0.45)]",
  // Alarms. --destructive (48% L) measured 3.90:1 against the composited
  // transcript ground and fails AA at 10px; once the fill is gone the ink IS the
  // chip, so both take the ladder's brighter tokens, which clear it at 5.37:1.
  FAILED:     "chat-label-chip text-[hsl(var(--danger))] border-[hsl(var(--danger)/0.5)]",
  CONFLICT:   "chat-label-chip text-[hsl(var(--authority-conflict))] border-[hsl(var(--authority-conflict)/0.5)]",
};

/**
 * Hover text. Every one of these says WHO said it, because that is the fact the
 * chip cannot carry on its own, and it points at the surface that holds the
 * engine's answer instead of leaving the analyst to guess there is one.
 */
const LABEL_TITLES: Record<string, string> = {
  CONFIRMED:  "The agent wrote this. Confidence computed from the evidence is in Evidence.",
  CORRELATED: "The agent wrote this. Confidence computed from the evidence is in Evidence.",
  INFERRED:   "The agent wrote this. Confidence computed from the evidence is in Evidence.",
  VERIFY:     "The agent flagged this as needing corroboration. Evidence holds the computed state.",
  FAILED:     "The agent reported a failure here. The Tools tab holds the call that failed.",
  LOW:        "The agent flagged this as a weak lead. Evidence holds the computed state.",
  CONFLICT:   "The agent reported a contradiction here. Evidence holds the computed state.",
};

/**
 * Does this prose carry any agent-stated label? Drives the one line of footer
 * chrome that says so out loud, since a hover title reaches neither a touch
 * device nor a reader who never thinks to hover.
 */
function hasStatedLabel(text: string): boolean {
  return new RegExp(STATED_LABEL_SOURCE).test(text);
}

function renderTextWithBadges(text: string): React.ReactNode {
  // Built per call rather than shared: a module-level /g regex carries lastIndex
  // between callers, and one .test() elsewhere would silently start the next
  // scan mid-string.
  const re = new RegExp(STATED_LABEL_SOURCE, "g");
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tag = m[1];
    out.push(
      <span
        key={`b-${m.index}`}
        title={LABEL_TITLES[tag]}
        className={LABEL_STYLES[tag] ?? "chat-label-chip border-border text-muted-foreground"}
      >
        {tag}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}


/**
 * Does the transcript already carry a persisted failure message?
 *
 * Must match how MessageView detects the sentinel — the FIRST text part
 * beginning with FAIL_PREFIX — because that is the branch that renders the
 * transcript's own FailedRunCard. These are AI-SDK messages: the text lives in
 * `parts`, not in a `content` string, so checking `content` silently matches
 * nothing and the de-duplication quietly does nothing at all.
 */
function hasPersistedFailure(messages: { role?: string; parts?: unknown }[]): boolean {
  // ONLY the last message counts, and that is not a detail — it is the whole
  // predicate. A persisted failure renders its card via `onRetry`, which the
  // transcript passes only to the LAST assistant message (`isLastAssistant`),
  // so an older sentinel buried mid-thread draws nothing at all. Scanning the
  // whole thread therefore made one stale failure silence every later one: the
  // live card was suppressed, the old sentinel rendered no card, and a real
  // current failure vanished from the UI with no explanation and no retry.
  // Suppress the live card only when the durable card is actually on screen.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  const parts = Array.isArray(last.parts) ? (last.parts as MessagePartShape[]) : [];
  const firstText = parts.find((p) => p?.type === "text");
  return typeof firstText?.text === "string" && firstText.text.startsWith(FAIL_PREFIX);
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
    <div className="alert-panel-danger p-5 animate-fade-up">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-destructive/15 border border-destructive/30">
          <AlertTriangle className="w-4 h-4 text-destructive" aria-hidden />
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
    <div className="chat-table-wrap edge-fade-x">
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


/**
 * The live run, as ONE row.
 *
 * While a run streams, `MessageViewImpl` used to render every tool invocation as
 * its own card, and they cannot even be grouped: `deriveToolRuntime` reads
 * `stage`/`cycle_id` off a tool part's OUTPUT, which a pending call does not have
 * yet, so every in-flight call lands in the same `REVIEW:-1` bucket. The analyst
 * got a flat stream of cards appearing faster than they could be read — the
 * "can't keep up, can't see what's going on" complaint.
 *
 * So during a run the cards live in here, collapsed, and the summary line says
 * who is working and on what. Nothing is hidden: expanding gives the same
 * `ToolGroupSummary` / `ToolPart` hierarchy, and once the run settles
 * `MessageViewImpl` renders them normally again.
 *
 * The role/action labels come from `toolAgentRole` + `toolActionLabel`, which
 * have been exported and unit-tested in `@/lib/tool-display` with no consumer.
 *
 * A11y: `role="status"` + `aria-live` sit on the ONE-LINE summary text, never on
 * the wrapper — a live region around the expandable body would re-announce the
 * whole tool list on every streamed part. Deliberately NOT `role="region"`: the
 * case-integrity e2e asserts no run-named region exists during a run.
 */
export function LiveActivityCard({ message, elapsedLabel }: { message: UIMessage | null; elapsedLabel: string }) {
  const parts = (message?.parts ?? []) as MessagePartShape[];
  const toolParts = parts.filter((p) => typeof p.type === "string" && p.type.startsWith("tool-"));
  // Prefer the call still in flight; fall back to the most recent one so the
  // label does not blank out in the gap between a result landing and the next
  // call starting.
  const inFlight = [...toolParts].reverse().find(
    (p) => p.state !== "output-available" && p.state !== "output-error",
  );
  const chosen = inFlight ?? toolParts[toolParts.length - 1];
  const toolName = typeof chosen?.type === "string" ? chosen.type.replace(/^tool-/, "") : "";
  const role = toolName ? toolAgentRole(toolName) : "Analyst";
  const action = toolName ? toolActionLabel(toolName) : "Preparing the investigation";

  const groups = groupToolParts(parts).filter((entry) => "part" in entry || !isNoiseToolGroup(entry));
  const cycles = groups.filter((entry): entry is ToolRunGroup => !("part" in entry));

  return (
    <details className="chat-card w-full min-w-0 group/live" data-speaker="agent">
      <summary className="chat-card__header cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span
          role="status"
          aria-live="polite"
          aria-label="Investigation in progress"
          className="min-w-0 truncate font-medium text-foreground/85"
        >
          {role} · <span className="font-normal text-muted-foreground">{action}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-data text-muted-foreground/70">
          <span className="font-mono tabular-nums">{elapsedLabel}</span>
          {toolParts.length > 0 && (
            <span className="tabular-nums">
              {toolParts.length} {toolParts.length === 1 ? "tool" : "tools"}
            </span>
          )}
          <ChevronDown className="h-3 w-3 transition-transform group-open/live:rotate-180" aria-hidden />
        </span>
      </summary>
      {groups.length > 0 && (
        <div className="chat-card__body flex w-full flex-col gap-2">
          <RunFlowRail groups={cycles} />
          {groups.map((entry, i) => "part" in entry ? (
            <ToolPart key={`live-tool-${i}`} part={entry.part} />
          ) : (
            <ToolGroupSummary key={`live-${entry.key}-${i}`} group={entry} />
          ))}
        </div>
      )}
    </details>
  );
}

function MessageViewImpl({ m, createdAt, onRetry, onRerun, rerunBusy, superseded, live }: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean; superseded?: boolean; live?: boolean }) {
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
          data-speaker="analyst"
          className="chat-card relative min-w-0 max-w-[min(100%,36rem)] px-4 py-2.5 text-[14px] leading-[1.6] break-words text-[hsl(var(--foreground))]"
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
  // Render the FULL assistant transcript — every model step's narration in order,
  // ending with the closing report — not just one "closing" part. Collapsing to a
  // single part hid every earlier step, so during a live run each new step's prose
  // visually REPLACED the previous one and the chat looked erased (operator report
  // 2026-07-21). Tool cycles already render as their own blocks above this.
  const prose = reflowCollapsedTables(
    joinAssistantTranscript(
      parts
        .filter((p) => p.type === "text")
        .map((p) => stripThinkTags(p.text ?? "")),
    ),
  );
  const integrity = messageIntegrity(parts as Array<{ type?: string; text?: string; state?: string }>, Boolean(live));
  const unadjudicated = narrativeIsUnadjudicated(prose);
  const timeLabel = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex w-full flex-col gap-3">
      {integrity.interrupted && (
        <div role="status" data-message-integrity="interrupted" className="rounded-lg border border-dashed border-white/[0.14] bg-surface-1/60 px-3 py-2 text-[13px] leading-snug text-muted-foreground">
          <span className="font-medium text-foreground/85">Interrupted response.</span>{" "}
          {integrity.appendedAfterInterruption
            ? "This reply stopped mid-sentence. The report below was generated automatically from everything recorded for the whole case, not from this step alone."
            : "This reply stopped before it finished, so the text may be incomplete."}
        </div>
      )}
      {cacheMeta && onRerun && (
        <CacheBanner cachedAt={cacheMeta.cachedAt} onRerun={onRerun} busy={!!rerunBusy} />
      )}
      {/* While this message is the one streaming, LiveActivityCard owns these
          cards and shows them collapsed under a single row. Rendering them here
          too would put the same tool calls on screen twice. */}
      {!live && visibleToolGroups.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          <RunFlowRail groups={groupedCycles} />
          {visibleToolGroups.map((entry, i) => "part" in entry ? (
            <ToolPart key={`tool-${i}`} part={entry.part} createdAt={createdAt} />
          ) : (
            <ToolGroupSummary key={`${entry.key}-${i}`} group={entry} createdAt={createdAt} />
          ))}
        </div>
      )}
      {prose && superseded && (
        <details className="chat-card w-full min-w-0 group/sup" data-speaker="agent">
          <summary className="chat-card__header cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
            <span className="text-muted-foreground">Superseded report</span>
            {timeLabel && <span className="chat-card__header-time">{timeLabel}</span>}
            <span className="ml-auto flex items-center gap-1 text-eyebrow uppercase tracking-wider text-muted-foreground/70">
              a later cycle rewrote this
              <ChevronDown className="h-3 w-3 transition-transform group-open/sup:rotate-180" aria-hidden />
            </span>
          </summary>
          <div className="chat-card__body">
            <div className="chat-prose">
              <MarkdownBlock content={prose} />
            </div>
          </div>
        </details>
      )}
      {prose && !superseded && (
        <article className="chat-card w-full min-w-0" data-speaker="agent" aria-label="Agent response">
          <div className="chat-card__header">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--intel-blue))]" aria-hidden />
            <span>Agent</span>
            {timeLabel && <span className="chat-card__header-time">{timeLabel}</span>}
          </div>
          {(hasStatedLabel(prose) || unadjudicated) && (
            // Above the prose, not below it: a footer is read after the claims have already landed, and a hover
            // title never reaches a touch reader. Wording only; no figure here is computed by the engine.
            <div role="note" data-narrative-notice className="border-b border-white/[0.06] px-4 py-2 text-[12.5px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground/85">AI narrative — claims need evidence review.</span>{" "}
              {unadjudicated
                ? "No finding rows were adjudicated for this run; labels and scores in this text are the model\u2019s own writing, not computed results."
                : "Labels and scores in this text are written by the model. Computed confidence and analyst review are in Evidence."}
            </div>
          )}
          <div className="chat-card__body">
            <div className="chat-prose">
              <MarkdownBlock content={prose} />
            </div>
          </div>
          <div className="chat-card__footer">
            <button
              type="button"
              onClick={() => copyToClipboard(prose, "Message copied")}
              className="-ml-2 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground transition-colors"
              aria-label="Copy message"
              title="Copy message"
            >
              <CopyIcon className="w-3 h-3" /> Copy
            </button>
            {(hasStatedLabel(prose) || unadjudicated) && (
              <span className="ml-auto min-w-0 text-balance text-right text-[11px] leading-snug text-faint-foreground">
                {unadjudicated
                  ? "No finding rows were adjudicated for this run: labels and confidence figures in this text are the agent\u2019s wording, not computed results."
                  : "Labels are the agent\u2019s wording. Computed confidence is in Evidence."}
              </span>
            )}
          </div>
        </article>
      )}
      {/* Fallback for a message whose groups were all filtered as noise. It needs
          the SAME live check as the grouped block above: an all-skipped streaming
          cycle makes `visibleToolGroups` empty, so without this the individual
          cards render beside the summary row — the firehose returning in exactly
          the case where the noise is highest. (Codex review, PR #587.) */}
      {parts.map((p, i) => {
        if (!live && typeof p.type === "string" && p.type.startsWith("tool-") && visibleToolGroups.length === 0) {
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
  prev: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean; live?: boolean },
  next: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean; live?: boolean },
): boolean {
  return (
    prev.m === next.m &&
    prev.createdAt === next.createdAt &&
    prev.rerunBusy === next.rerunBusy &&
    // `live` decides whether this message renders its own tool cards or defers
    // to LiveActivityCard. Omitting it here would leave the settled message
    // still suppressing them after the run ends — the cards would vanish.
    !!prev.live === !!next.live &&
    !!prev.onRetry === !!next.onRetry &&
    !!prev.onRerun === !!next.onRerun
  );
}

// Exported for the regression test on the live-suppression path above.
export const MessageView = memo(MessageViewImpl, messagePropsEqual);

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
  // Preflight around the free-form request: the parsed target and the analyst's
  // correction of its type (see composer-preflight.ts).
  const [controls, setControls] = useState<PreflightControls>(DEFAULT_CONTROLS);
  const [composerFocused, setComposerFocused] = useState(false);
  // Which Next-steps row has its run preview open (see NextSteps).
  const [openStep, setOpenStep] = useState<string | null>(null);
  const composerIds = { textarea: useId(), help: useId() };
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [stopping, setStopping] = useState(false);
  // The SDK error THIS CLIENT's dropped stream produced, held BY IDENTITY while
  // we treat it as a browser-connection fault rather than a failed run.
  //
  // Identity, not a boolean, and that is the load-bearing part. A flag says
  // only "something is suppressed" and keeps saying it after `error` has moved
  // on to a different, genuine fault — silently swallowing the next real
  // failure. Holding the error object means the suppression is spent the moment
  // the error changes or clears: the gate below compares it to the live `error`,
  // so a later fault can never inherit an earlier drop's exemption.
  //
  // The ref mirrors the state because onError's async continuation reads this
  // back after an await, where the state closure is stale. `markDropSuppressed`
  // is the only writer, so the two cannot drift.
  const suppressedDropErrorRef = useRef<Error | null>(null);
  const [suppressedDropError, setSuppressedDropError] = useState<Error | null>(null);
  const markDropSuppressed = useCallback((err: Error | null) => {
    suppressedDropErrorRef.current = err;
    setSuppressedDropError(err);
  }, []);
  // useChat's own `clearError`, reachable from the onError closure below. Held
  // in a ref because `clearError` is destructured from the very call that
  // receives onError — the same pattern this file already uses for `stop` and
  // `isLoading`. Assigned every render, immediately after that destructure.
  const clearErrorRef = useRef<() => void>(() => {});
  const failSavedRef = useRef(false);
  const unmountedRef = useRef(false);
  // Synchronous re-entrancy lock for scan submission. `status` (from useChat)
  // only flips to "submitted" once sendMessage() runs — which is AFTER the async
  // cache lookup + case-start write in send(). Without this ref a rapid double/
  // triple-click fires multiple scans (each POST costs credits, and the duplicate
  // messages trigger React "duplicate key" warnings). Set synchronously before
  // any await; released in finally.
  const submitLockRef = useRef(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const { items: artifacts } = useThreadArtifacts(threadId);
  // Optional: absent in standalone renders/tests. Used only to keep the run
  // controls off a thread whose run is live in another tab (overlap guard).
  const caseSnapshot = useOptionalCaseSnapshot();
  const serverRunActive = caseSnapshot?.snapshot?.run.state === "running";
  const serverRunStartedAt = caseSnapshot?.snapshot?.run.startedAt ?? null;
  // Read at CALL time (delayed auto-continue, send guards) so a callback built
  // while a run was live does not keep refusing after it ends.
  const serverRunActiveRef = useRef(serverRunActive);
  serverRunActiveRef.current = serverRunActive;
  // Targets tools have already been run against — the "already investigated"
  // signal that stops the rail re-suggesting a pivot that's already been run.
  const queriedTargets = useThreadQueriedTargets(threadId);
  // Prior tool attempts per selector — read-only input to the adaptive ranking.
  const pivotAttempts = useThreadPivotAttempts(threadId);
  // Analyst decisions. They shape the "Next steps" rail (a rejected selector is
  // never suggested, a Key one ranks first, a Recheck one is a verification
  // task) and they GATE the pivot bus: a "Run this pivot" on a rejected
  // selector is refused here at dispatch, not merely hidden from the cards.
  const review = useReviewStates(threadId);
  const decisionSets = useMemo(
    () => buildDecisionSets(artifacts, review.map, normalizeTarget, (kind) => KIND_TO_PIVOT[kind.toLowerCase()] ?? null),
    [artifacts, review.map],
  );
  const decisionSetsRef = useRef(decisionSets);
  decisionSetsRef.current = decisionSets;
  const [seedValue, setSeedValue] = useState<string | null>(null);
  const [seedType, setSeedType] = useState<string | null>(null);
  // The Next-steps ranking depends on the seed and on analyst verdicts, both
  // loaded asynchronously. Rendering before they land reshuffled the list a
  // second after load — the row an analyst reached for could move or vanish.
  const [seedLoaded, setSeedLoaded] = useState(false);
  // Continue / Auto-run / Write report (lib/run-controls.ts). `artifactsBefore`
  // is the artifact count snapshotted when a cycle was sent, so the decision
  // after the run can ask "did that cycle record anything new?".
  const [autoRun, setAutoRun] = useState<{ enabled: boolean; cyclesRun: number; artifactsBefore: number | null }>({
    enabled: false, cyclesRun: 0, artifactsBefore: null,
  });
  // Set by stopInvestigation, cleared on the next send: Auto-run must never
  // re-fire on a thread the analyst just stopped by hand.
  const stoppedByAnalystRef = useRef(false);
  // Skipped pivots (normalized-target keys) so a lead the analyst dismissed in
  // the Pivots tab never reappears in the chat rail. Hydrated from localStorage
  // and kept in sync via the skip-changed event other surfaces dispatch.
  const [pivotSkip, setPivotSkip] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; type: string; path: string; url: string; uploading?: boolean }>
  >([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value, seed_type")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        const row = data as { seed_value: string | null; seed_type?: string | null } | null;
        setSeedValue(row?.seed_value ?? null);
        setSeedType(row?.seed_type ?? null);
        setSeedLoaded(true);
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
      // Measure what the PHONE uploads, before anything server-side trims it.
      // `useChat` sends the whole messages array every turn and that array is
      // unbounded — the edge function's budget applies after upload, so no
      // existing meter can see this. Measurement only; never alters the request.
      reportRequestBodySize(measureRequestBody(init?.body), threadId);
      const { data } = await supabase.auth.getSession();
      const headers = new Headers(init?.headers);
      if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
      // The SDK keeps only a failed response's BODY; this puts the status in it.
      return withHttpStatusInErrorBody(await fetchWithRetry(url, { ...init, headers }));
    },
  }));

  const { messages, sendMessage, status, error, setMessages, stop, clearError } = useChat({
    id: threadId,
    // Coalesce streamed updates into ONE render per 80ms. `useChat` swaps the
    // streaming message object on every token delta. `messagePropsEqual` compares
    // `prev.m === next.m`, so settled messages are already skipped — but the LIVE
    // message re-renders every delta, and `MarkdownBlock` is memoized on `content`,
    // which changes every token too. So the growing message re-parses its whole
    // body through ReactMarkdown + remarkGfm once per token: O(n^2) over the
    // message, on the phone's main thread. That is what makes text stop mid-word
    // and then arrive in a burst.
    //
    // Measured 2026-09-19 over 663 production steps (orchestrator_step_metrics):
    // generation runs at ~13ms/output token (~77 tok/s), so an unthrottled run
    // asks mobile Safari for ~77 full re-parses per second. At 80ms that is ~12
    // renders/sec — still below the ~100ms gap a reader perceives as a pause.
    //
    // Presentation-only: the SDK applies every delta to its own store regardless,
    // no token is dropped, and the settled message is byte-identical. Do not
    // "simplify" this to a debounce — a debounce can starve a fast stream of
    // updates entirely; a throttle guarantees a render every 80ms.
    experimental_throttle: 80,
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
      // The backend's OWN 401 (pre-stream, `HTTP 401 …`) → session expired → route to auth.
      // A provider's 401 surfaced mid-stream ("…rejected the API key (401)…") is NOT the
      // analyst's session and must never sign them out (lib/tool-run.ts isTransportAuthFailure).
      if (isTransportAuthFailure(e)) {
        toast.error(friendly);
        navigate("/auth");
        return;
      }
      // ── The stream dropped, but is the RUN dead? ───────────────────────────
      // A dropped client connection is not a failed investigation. The run is
      // deliberately not bound to req.signal and persists under waitUntil, so a
      // backgrounded Safari tab or a phone switching networks yields "Load
      // failed" here while the server finishes the report. Persisting the
      // FAIL_PREFIX marker for that writes a permanent lie into the thread and
      // invites a Retry that starts a SECOND concurrent run on the same thread.
      //
      // Liveness is decided by the HEARTBEAT ALONE. `status === "active"` is not
      // evidence: it is the column default a blank thread is born with and the
      // state a CPU-killed isolate leaves behind, so trusting it would report a
      // dead run as "still running" — the precise failure this guard exists to
      // avoid. Fails closed: on a read error, a missing heartbeat, or a stale
      // one, we fall through and record the failure exactly as before, and the
      // server's own stale-run recovery labels it Interrupted (invariant I-2).
      if (isNetworkDropError(e)) {
        // Claim the suppression SYNCHRONOUSLY, before the heartbeat read.
        //
        // The SDK calls onError WITHOUT awaiting it and writes
        // `setStatus({ status: "error", error: e })` on the very next line, so
        // a suppression set only after the await lands a whole network
        // round-trip late — and for that entire window the analyst is shown a
        // red "Investigation run failed" card with a Retry button over a run
        // that is still working. Clicking it starts a SECOND concurrent run.
        // Claimed here, this update and the SDK's error write batch into one
        // render and the card never paints at all.
        //
        // Safe to claim before the answer is known because `isNetworkDropError`
        // is the narrow half of the decision: any parsed HTTP status and every
        // server-originated stream wording are already excluded, so nothing
        // that reached the backend can get this far. The heartbeat is the
        // second half, and if it does not prove the run alive the claim is
        // released below and the failure is recorded exactly as before.
        markDropSuppressed(e);
        const { data: liveness } = await supabase
          .from("threads")
          .select("last_heartbeat_at")
          .eq("id", threadId)
          .maybeSingle();
        if (isRunHeartbeatAlive(liveness?.last_heartbeat_at)) {
          // Nothing was written, so a later genuine failure must still be able
          // to record one.
          failSavedRef.current = false;
          // Don't merely HIDE the SDK's error — remove it from useChat's own
          // store. Hiding it leaves a live error that outlives whatever
          // component state is doing the hiding, so the card returns the moment
          // those lifetimes diverge. Clearing makes the suppression exactly as
          // durable as the store it clears, whatever that store's lifetime.
          //
          // Guarded on identity: if a NEW run started during the await, the
          // reset effect has already released our claim and `error` belongs to
          // that run — clearing it would swallow a fault we never adjudicated.
          // (`clearError` is itself a no-op unless status is still "error",
          // so a run merely in flight is never disturbed.)
          if (suppressedDropErrorRef.current === e) clearErrorRef.current();
          toast.warning(
            "Connection dropped — the investigation is still running on the server. The report will appear here when it finishes.",
          );
          return;
        }
        // Not proven alive — a missing, unreadable or stale heartbeat is a
        // genuine failure. Release the claim so the card renders and fall
        // through to persist the marker, exactly as before this branch existed.
        if (suppressedDropErrorRef.current === e) markDropSuppressed(null);
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

  // `messages` is not guaranteed to be in the project's Realtime publication.
  // Reconcile explicitly when the durable thread reaches a terminal state so a
  // report inserted by normal completion, salvage, or stale-run recovery appears
  // without requiring a hard reload.
  const reconcilePersistedMessages = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("messages")
      .select("id,role,parts,created_at")
      .eq("thread_id", threadId)
      .order("created_at");
    if (loadError) {
      console.warn("terminal message reconciliation failed:", loadError.message);
      return;
    }
    const rows = data ?? [];
    const persisted: UIMessage[] = rows.map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      parts: row.parts as UIMessage["parts"],
    }));
    setMessages((current) => mergePersistedChatMessages(current, persisted));
    setCreatedAtMap((current) => ({
      ...current,
      ...Object.fromEntries(rows.map((row) => [row.id, row.created_at])),
    }));
  }, [setMessages, threadId]);

  clearErrorRef.current = clearError;

  // Read by the realtime INSERT handler, which subscribes once per thread and so
  // cannot close over the current `status`.
  const statusRef = useRef(status);
  statusRef.current = status;

  // True only while the error ON SCREEN is still the one we adjudicated as a
  // harmless client drop over a live run. Derived rather than stored, so the
  // suppression expires by construction: if `error` becomes a different fault,
  // or clears, this is false again on that very render with nothing to reset.
  const networkDropWhileAlive =
    suppressedDropError !== null && suppressedDropError === error;

  // Reset fail guard on new turn
  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      failSavedRef.current = false;
      // A new turn gets a fresh verdict: the previous turn's dropped connection
      // must not keep suppressing a real failure card on this one.
      markDropSuppressed(null);
    }
  }, [status, markDropSuppressed]);

  // Re-seed the chat from the freshly-loaded DB state on (re)mount.
  //
  // ⚠️ CORRECTION, MEASURED 2026-09-07 on `@ai-sdk/react@3.0.199`. This comment
  // used to say the useChat store "SURVIVES an unmount", keyed by `id`. It does
  // NOT, in this version: `useChat` builds its `Chat` inside a `useRef`, so
  // messages, status AND error are per-mount and die with the component. There
  // is no module-level store. The claim dates from an older SDK, and acting on
  // it sends you looking for leaks across remounts that cannot happen here —
  // verify before relying on it again (`network-drop-suppression.test.tsx`
  // measures the lifetime, so an SDK upgrade that reintroduces a shared store
  // fails loudly rather than silently).
  //
  // The effect is still needed, for a different reason: `initial` is loaded
  // ASYNCHRONOUSLY, so the Chat constructed on first render was seeded with the
  // pre-load value. Applying the DB-loaded `initial` here makes the DB the
  // source of truth on return, which also covers a run that finished while you
  // were away (the realtime recovery
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
          // The same identity as the terminal reconcile: a plain JSON compare
          // missed the server's post-stream Evidence Record append and added the
          // stored row as a second copy of the run (2026-10-01).
          const streaming = statusRef.current === "streaming" || statusRef.current === "submitted";
          setMessages((current) => applyRealtimeInsert(
            current,
            { id: row.id!, role: row.role, parts: row.parts } as UIMessage,
            streaming,
          ));
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
    // The client writes NOTHING to `threads` here. It used to stamp status:"active" and
    // a fresh last_heartbeat_at before each send so the stale-run sweep would not reap a
    // just-started run (the "starts, then stops" bug). Since #730 the server's admission
    // lease stamps status, run_started_at and last_heartbeat_at itself, atomically, before
    // the user message is stored — and it reads a heartbeat younger than 75 s as a LIVE
    // run. The client stamp therefore made every send refuse itself with 409
    // RUN_IN_PROGRESS (production, 2026-10-10 09:36Z, threads cfe70631 and 6d55b8da).
    // Liveness is the server's signal; the client must never write it.
    lastUserScrollUpRef.current = 0; // a new run is an implicit "follow the latest"
    followLatestRef.current = true;
    setShowJumpToLatest(false);
  }, []);

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
      stoppedByAnalystRef.current = true;
      setAutoRun((prev) => (prev.enabled ? { ...prev, enabled: false } : prev));
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
    // An empty box stays silent — the button is disabled and nothing was asked
    // for. A refused submission does not: the analyst pressed a live control.
    if (!text && !hasFiles) return;
    const sendRefusal = submitRefusal(status, submitLockRef.current, serverRunActiveRef.current);
    if (sendRefusal) {
      toast.info(submitRefusalMessage(sendRefusal));
      return;
    }
    // The preflight decides what is sent: the request exactly as typed, plus one
    // Target line only when the analyst corrected the detected type.
    if (!preflight.canSubmit) return;
    const outgoing = preflight.message.trim();
    const customizedRun = preflight.customized;
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
      ? `${outgoing}${outgoing ? "\n\n" : ""}Attached files:\n${attachLines.join("\n")}`
      : outgoing;
    // Try the investigation cache only for the FIRST user message in this
    // thread — and never for a run with custom controls, which a cached result
    // could not have honoured.
    const isFirstMessage = messages.length === 0;
    if (isFirstMessage && user && !hasFiles && !customizedRun) {
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
          const cached = (hit.result_json as CachedInvestigation | null) ?? {};
          // cache_version 2+ required: an older/unversioned row predates the
          // origin_thread_id lineage this safety check depends on, so it can
          // never be proven analyst-clean — treat it as a miss, not a replay.
          const isVersioned = (cached.cache_version ?? 0) >= 2 && !!cached.origin_thread_id;
          const safety = isVersioned
            ? await checkCachedHitSafety(
                cached.origin_thread_id as string,
                user.id,
                // Pass the cached artifact ids so verdicts recorded against a
                // CLONE of this entry (in another thread) are consulted too —
                // eviction is best-effort, so this read-time check is the authority.
                (cached.artifacts ?? []).map((a) => a.id).filter((id): id is string => !!id),
              )
            : { safe: false, reviewMap: new Map<string, ReviewState>(), reason: "unversioned cache row" };
          if (!safety.safe) {
            // Poisoned or stale-format row — evict it so the next lookup
            // doesn't repeat this check, then fall through to a live run.
            await supabase
              .from("investigation_cache")
              .delete()
              .eq("user_id", user.id)
              .eq("seed_kind", seed.kind)
              .eq("seed_value_normalized", seed.normalized);
          } else {
            // Safe to replay: checkCachedHitSafety found NO verdict that blocks it —
            // neither dismissed/wrong nor recheck, in the origin thread or on any
            // clone of this entry. A `recheck` no longer replays downweighted: the
            // cached assistant narrative is frozen prose that would keep asserting
            // the flagged finding, and text cannot be downweighted — so a recheck
            // now bypasses the cache and regenerates live (handled by the !safe
            // branch above).
            await renderCachedResult(text, {
              ...hit,
              result_json: cached,
            });
            setInput("");
            setAttachments([]);
            return;
          }
        }
      }
    }
    if (!FUNCTIONS_URL) {
      toast.error("Supabase function URL is not configured. Set VITE_SUPABASE_URL (or VITE_SUPABASE_PROJECT_ID) in .env.");
      return;
    }
    // No pre-send `?health=1` probe. It awaited a health check that makes paid
    // LLM pings (6.7 s TTFB measured 2026-09-30) under a 5 s timeout, so a
    // HEALTHY backend could refuse the first Send as "cold-starting". The POST
    // now explains its own failure: the transport puts the HTTP status into the
    // error (`withHttpStatusInErrorBody`), so a 404 still reads "not deployed".
    setInput("");
    setAttachments([]);
    setControls(DEFAULT_CONTROLS);
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
    if (!t || isSubmitBlocked(status, submitLockRef.current, serverRunActiveRef.current)) return;
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

  // --- Run controls -------------------------------------------------------
  // Continue = one more cycle. Auto-run = keep cycling while each cycle still
  // records new evidence, up to AUTO_RUN_MAX_CYCLES. Write report = the closing
  // dossier, on demand, instead of after every turn.
  const artifactsCountRef = useRef(artifacts.length);
  artifactsCountRef.current = artifacts.length;
  // Auto-run follows the ranking: each cycle runs the best next pivot (see the
  // refs' assignment after `suggestions`) and falls back to the generic
  // continue prompt when none is safe to start unattended.
  const autoPivotRef = useRef<RunnablePivot | null>(null);
  const autoPivotKeyRef = useRef<string | null>(null);
  const autoSentRef = useRef<Set<string>>(new Set());
  const nextAutoPrompt = () => {
    const pivot = autoPivotRef.current;
    const key = autoPivotKeyRef.current;
    if (!pivot || !key) return CONTINUE_PROMPT;
    autoSentRef.current.add(key);
    return pivot.prompt;
  };
  const sendCycle = useCallback(async (prompt: string, countAsAutoCycle: boolean) => {
    // Continue / Write report / arming Auto-run all land here, and all three are
    // buttons the analyst just pressed. A bare `return` is what made Continue
    // look broken — see submit-guard.ts for the operator report this comes from.
    const refusal = submitRefusal(status, submitLockRef.current, serverRunActiveRef.current);
    if (refusal) {
      toast.info(submitRefusalMessage(refusal));
      return;
    }
    stoppedByAnalystRef.current = false;
    setAutoRun((prev) => ({
      ...prev,
      cyclesRun: countAsAutoCycle ? prev.cyclesRun + 1 : prev.cyclesRun,
      artifactsBefore: artifactsCountRef.current,
    }));
    await sendText(prompt);
  }, [sendText, status]);
  const runContinue = useCallback(() => { void sendCycle(CONTINUE_PROMPT, false); }, [sendCycle]);
  const runWriteReport = useCallback(() => {
    // A report request is the natural end of Auto-run.
    setAutoRun((prev) => ({ ...prev, enabled: false }));
    void sendCycle(REPORT_PROMPT, false);
  }, [sendCycle]);
  const toggleAutoRun = useCallback((enabled: boolean) => {
    if (!enabled) {
      setAutoRun((prev) => ({ ...prev, enabled: false }));
      toast.info("Auto-run off — the current cycle will finish, then wait for you.");
      return;
    }
    setAutoRun({ enabled: true, cyclesRun: 0, artifactsBefore: null });
    // Arm and start immediately when idle; when a run is already going, the
    // completion effect below picks it up.
    if (!isSubmitBlocked(status, submitLockRef.current)) void sendCycle(nextAutoPrompt(), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendCycle, status]);

  // Listen for "run pivot" events dispatched from the Pivots tab.
  useEffect(() => {
    const onRunPivot = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId: string; value: string; type?: string; prompt?: string }>).detail;
      if (!detail || detail.threadId !== threadId) return;
      // MANUAL DISPATCH GUARD. Every surface that runs a pivot — the Pivots
      // tab, "queue all", the command palette, a Recheck launch — rides this
      // bus, so this is the one place a rejected selector can be refused
      // before it starts a run. Keyed by pivot type + normalized value, the
      // same identity the engine and the backend guard use.
      if (isManualDispatchRefused(
        decisionSetsRef.current, detail.type, detail.value, normalizeTarget,
        (kind) => KIND_TO_PIVOT[kind.toLowerCase()] ?? null,
      )) {
        console.warn("[review] refused manual dispatch of an analyst-rejected selector", { value: detail.value, type: detail.type });
        toast.error(`"${detail.value}" was dismissed by the analyst — not dispatched. Reset its review to run it.`);
        return;
      }
      // A run already in flight holds the submit lock, and sendText would drop
      // this pivot without a word. Say so instead.
      if (isSubmitBlocked(status, submitLockRef.current)) {
        toast.info("A run is in progress on this case. Start the pivot when it finishes.");
        return;
      }
      const prompt = detail.prompt ??
        `Pivot on ${detail.value}${detail.type ? ` (${detail.type})` : ""}. Run the next investigation step on this lead.`;
      toast.success(`Pivot on ${detail.value} sent to the agent`);
      void sendText(prompt);
    };
    window.addEventListener("proximity:run-pivot", onRunPivot as EventListener);
    // Tell the Pivots surface that something on this page can actually run a
    // pivot (the read-only case view has no chat, so nothing listens there).
    const unregister = registerPivotRunner(threadId);
    return () => {
      window.removeEventListener("proximity:run-pivot", onRunPivot as EventListener);
      unregister();
    };
  }, [threadId, sendText, status]);

  // The rail's Run rides the SAME bus as the Pivots tab, so the manual dispatch
  // guard above (analyst-rejected selectors) applies to it too. It used to call
  // sendText directly and skip that refusal.
  const runPivotFromRail = useCallback((p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt },
    }));
  }, [threadId]);

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

      // 2) clone artifacts into this thread, marked as cached. Lineage
      // (origin_thread_id/origin_artifact_id) is preserved so this clone can
      // still be traced back to the analyst review that governed it — a
      // review made against the origin artifact after this point won't
      // retroactively apply to the clone (it's a new row), but the lineage
      // at least makes that traceable rather than silently severed.
      if (cachedArtifacts.length > 0) {
        const { error: artErr } = await supabase.from("artifacts").insert(
          cachedArtifacts.map((a) => ({
            thread_id: threadId,
            user_id: user.id,
            kind: a.kind,
            value: a.value,
            confidence: a.confidence ?? null,
            source: a.source ?? null,
            metadata: {
              ...(a.metadata ?? {}),
              from_cache: true,
              origin_thread_id: cached.origin_thread_id ?? null,
              origin_artifact_id: a.id ?? null,
            } as never,
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
    // This tab is idle but the SERVER still reports a live run (second tab,
    // dropped stream). Re-running here deletes the cache replay and starts a
    // second billed run on top of it; the server rejects no overlaps.
    if (serverRunActiveRef.current) {
      toast.info(submitRefusalMessage("server_running"));
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
    // The same synchronous lock the composer and the pivot rail hold. Retry used
    // to skip it, so a double-click on "Retry investigation" started two billed
    // runs: the server has no idempotency key and does not reject overlaps. The
    // server-run check matters for the same reason: a stale failure card in this
    // tab must not start a run on top of one that is still live on the server.
    const retryRefusal = submitRefusal(status, submitLockRef.current, serverRunActiveRef.current);
    if (retryRefusal) {
      toast.info(submitRefusalMessage(retryRefusal));
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user") as UIMessage | undefined;
    if (!lastUser) return toast.error("No previous message to retry");
    const text = (lastUser.parts as MessagePartShape[]).filter((p) => p.type === "text").map((p) => p.text).join("");
    if (!text) return toast.error("Last message was empty");
    submitLockRef.current = true;
    try {
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
    } catch (e) {
      console.error("retry failed:", e);
      toast.error(`Failed to retry: ${describeTransportError(e)}`);
    } finally {
      submitLockRef.current = false;
    }
  };

  const isLoading = status === "submitted" || status === "streaming";
  // The server is running this case's investigation and this page is not
  // receiving it live: the stream dropped (phone slept, network changed) or the
  // page was opened mid-run. Settled for 3s, because a normal run ends with the
  // stream closing a moment before the thread is marked finished.
  const followingServer = useHeldTrue(shouldFollowServer({ clientStreaming: isLoading, serverRunActive }), 3_000);
  // When a run this page was not streaming ends, load what it saved. The
  // watchdog below only hears the realtime UPDATE, which a phone asleep at the
  // moment the run finished never receives and nothing replays; the case
  // snapshot does notice (it re-reads on return to the tab and polls while a
  // run is live), so its run state leaving "running" is the reliable signal.
  const serverWasRunningRef = useRef(serverRunActive);
  useEffect(() => {
    const was = serverWasRunningRef.current;
    serverWasRunningRef.current = serverRunActive;
    if (was && !serverRunActive && !isLoading) void reconcilePersistedMessages();
  }, [serverRunActive, isLoading, reconcilePersistedMessages]);
  // A follow-up inherits the case's target; only a first request needs one.
  const isFollowUp = useMemo(() => messages.some((m) => m.role === "user"), [messages]);
  const preflight = useMemo(
    () => evaluatePreflight({ text: input, attachments: attachments.length, isFollowUp, controls }),
    [input, attachments.length, isFollowUp, controls],
  );
  // Placeholder length only — layout is CSS-responsive and never remounts.
  const isPhone = useIsMobile();
  const runControlsVisible = canShowRunControls({
    isLoading,
    hasAssistantTurn: messages.some((m) => m.role === "assistant"),
    seedLoaded,
    hasLiveError: Boolean(error) && !networkDropWhileAlive && !hasPersistedFailure(messages),
    autoRunEnabled: autoRun.enabled,
    serverRunActive,
  });
  const primary = composerPrimary({
    isLoading,
    stopping,
    isFollowUp,
    canContinue: runControlsVisible && !isLoading,
    empty: preflight.empty,
    canSubmit: preflight.canSubmit,
    uploading,
  });
  // Auto-grow the request box: one calm line when idle and empty, up to ~8
  // lines while writing. Height is set on the element so it never reflows the
  // transcript above more than the text itself needs.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // A phone composer is one line until the text needs a second one.
    const min = (composerFocused || input) && !isPhone ? 64 : 44;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), 208)}px`;
  }, [input, composerFocused, isPhone]);
  // Watchdog-only ref: the terminal-status realtime handler below is set up in
  // an effect with a stable dependency array (see stopRef further down), so its
  // closure would otherwise see a stale `isLoading` from whenever the effect
  // last ran. Updated every render, read only inside the fallback timer.
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  // Auto-run: when a run ends, wait for the artifact subscription to settle,
  // then either send the next cycle or say why it stopped. The decision is a
  // pure function (decideAutoContinue) so the stop reasons are unit-tested.
  const wasLoadingRef = useRef(false);
  const autoRunRef = useRef(autoRun);
  autoRunRef.current = autoRun;
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    const ended = wasLoadingRef.current && !isLoading;
    wasLoadingRef.current = isLoading;
    if (!ended || !autoRunRef.current.enabled) return;
    let timer = 0;
    let waitedMs = 0;
    const attempt = () => {
      if (unmountedRef.current || isLoadingRef.current) return;
      const state = autoRunRef.current;
      if (!state.enabled) return;
      const decision = decideAutoContinue({
        enabled: state.enabled,
        cyclesRun: state.cyclesRun,
        maxCycles: AUTO_RUN_MAX_CYCLES,
        artifactsBefore: state.artifactsBefore,
        artifactsNow: artifactsCountRef.current,
        runFailed: Boolean(errorRef.current),
        threadFinished: !stoppedByAnalystRef.current,
        serverRunActive: serverRunActiveRef.current,
      });
      if (decision.action === "continue") {
        void sendCycle(nextAutoPrompt(), true);
        return;
      }
      if (decision.action === "wait") {
        // The stream ended but the server run did not. Poll its own state
        // instead of overlapping it, and give up (visibly) after a bound.
        if (waitedMs >= AUTO_RUN_OVERLAP_MAX_WAIT_MS) {
          setAutoRun((prev) => ({ ...prev, enabled: false }));
          toast.info(autoRunStopMessage("run_overlap", AUTO_RUN_MAX_CYCLES));
          return;
        }
        waitedMs += AUTO_RUN_OVERLAP_POLL_MS;
        timer = window.setTimeout(attempt, AUTO_RUN_OVERLAP_POLL_MS);
        return;
      }
      setAutoRun((prev) => ({ ...prev, enabled: false }));
      if (decision.reason !== "disabled") toast.info(autoRunStopMessage(decision.reason, AUTO_RUN_MAX_CYCLES));
    };
    timer = window.setTimeout(attempt, AUTO_RUN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isLoading, sendCycle]);

  // Has this thread ever carried a run or a message? A brand-new thread is created
  // with `status='active'` (the DB column default) and no heartbeat, so the health
  // sweep below used to reap it as a 90s-dead investigation and post a "recovered
  // run" report into a chat the analyst had not typed a single word into. The server
  // now refuses to recover a thread with no run marker (see hasRunMarker in
  // recovery.ts) — this is the belt-and-braces half: an untouched thread never asks
  // for a sweep in the first place. Read at CALL time via a ref so the delayed
  // sweeps re-evaluate instead of capturing a stale mount-time value.
  const threadHasActivityRef = useRef(false);
  if (isLoading || messages.length > 0) threadHasActivityRef.current = true;

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

  // ---- Auto-sweep stuck runs (client-side stale-run recovery trigger) --------
  // A live investigation whose backend isolate is CPU-killed leaves the thread
  // "active" with no final report; nothing server-side finalizes it until the
  // osint-agent function is next hit (a new request / run start / health probe).
  // While THIS tab has a run in flight (or has just opened a thread), poll the
  // function's health endpoint — it runs the server-side stale-run recovery
  // (recoverStaleActiveThreads), which finalizes any run whose heartbeat has
  // gone stale (>75s) with a deterministic report from persisted artifacts. So a
  // killed run self-heals within ~30–75s instead of hanging on "RUNNING"
  // forever. The recovered report + terminal status then arrive via the realtime
  // subscriptions. SAFE: recovery only ever touches heartbeat-stale threads — a
  // healthy run pulses every 15s, so an in-progress investigation is never reaped.
  useEffect(() => {
    if (!FUNCTIONS_URL) return;
    const sweep = () => {
      // Nothing has ever run here — there is no stuck run of ours to reap, and a
      // sweep from a blank thread is exactly what produced the ghost recoveries.
      if (!threadHasActivityRef.current) return;
      // `maintenance=1` is what makes this a SWEEP. Since 2026-10-19 a plain
      // `?health=1` is a liveness probe that runs no database maintenance (it was a
      // 5,000-row scan plus two sweeps every 30s per open case); the stale-run
      // recovery this effect exists for only runs when asked. Older edge builds
      // ignore the extra parameter, so this is safe to ship ahead of the edge deploy.
      void fetch(`${FUNCTIONS_URL}?health=1&maintenance=1`, { method: "GET" }).catch(() => {});
    };
    sweep(); // once on open: reap a run already stuck when this thread is loaded
    if (!isLoading) {
      // TRAILING sweeps after the stream ends. The immediate sweep above usually
      // fires too EARLY to help: when an isolate dies mid-run the client stream
      // ends within a few seconds, at which point the thread's heartbeat is only
      // ~15-30s stale — under recovery's 75s staleness bar — so the sweep runs
      // and correctly declines to reap a run that might still be alive. Without
      // a retry nothing re-probes (the 30s interval below only runs while
      // loading), so a genuinely dead run sat `active` with artifacts and NO
      // report until the 15-minute scheduled cron happened by. Observed on
      // thread 1e74893c: died 15:35:43, stream ended ~15:36, still `active` and
      // unrecovered 8+ minutes later. These two delayed probes cross the 75s
      // bar and close that window to ~90s. Harmless when the run ended normally
      // — recovery only ever touches heartbeat-stale threads.
      const t1 = window.setTimeout(sweep, 30_000);
      const t2 = window.setTimeout(sweep, 90_000);
      return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    }
    const id = window.setInterval(sweep, 30_000); // while running: reap a mid-flight death
    return () => window.clearInterval(id);
  }, [threadId, isLoading]);

  // ---- Stuck-"RUNNING" watchdog ---------------------------------------------
  // A CPU-killed isolate leaves a half-open SSE that never sends EOF, so useChat
  // stays "streaming" (isLoading true → header stuck on RUNNING) with no client
  // watchdog. When the backend marks this thread terminal (the sweeper above, or
  // any server-side recovery, flips status to finished/stopped), reconcile the
  // durable assistant message. Abort only a stale-recovered or analyst-stopped
  // stream: normal `finished` and `stream_error` updates can arrive while their
  // trailing report/error chunk is still flushing, and aborting here drops it.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const channel = supabase
      .channel(`chat-run-watchdog-${threadId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` },
        (payload) => {
          const next = (payload.new as TerminalThreadUpdate | null) ?? {};
          if (!isTerminalThreadUpdate(next)) return;
          if (shouldAbortClientStream(next)) {
            try { stopRef.current?.(); } catch { /* stream already closed */ }
          }
          // Give a healthy browser branch one render turn to receive its trailing
          // report before merging the same durable row. Stale-recovery/stop paths
          // have no live tail to flush and reconcile immediately.
          if (shouldAbortClientStream(next)) {
            void reconcilePersistedMessages();
          } else {
            window.setTimeout(() => void reconcilePersistedMessages(), 500);
            // Fallback for a normal `finished` update: the 500ms reconcile above
            // assumes the browser's OWN stream connection will independently
            // deliver its own completion frame shortly after, flipping useChat's
            // `status` out of "streaming"/"submitted" on its own. If that
            // connection silently died first — a network blip, a backgrounded/
            // throttled tab, a proxy timeout — no terminal SSE frame ever
            // arrives and `isLoading` is stuck true forever, even though the DB
            // (and by now the reconciled `messages` array) already show the run
            // is done. Give it a generous grace window, then force it terminal
            // if it's still loading. By the time this fires the durable report
            // has already been merged in above, so this can only clear a stuck
            // loading flag — it never discards content a live stream is still
            // flushing (that case already resolved `isLoading` on its own).
            window.setTimeout(() => {
              if (isLoadingRef.current) {
                try { stopRef.current?.(); } catch { /* stream already closed */ }
              }
            }, 8_000);
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [reconcilePersistedMessages, threadId]);

  // ---- A stream that outlived its run ---------------------------------------
  // The watchdog above only hears a realtime UPDATE. When the socket is dead as
  // well as the stream (the same conditions that kill one tend to kill both),
  // the case snapshot still re-reads the row on return to the tab and on its
  // live poll, but `run.state` keeps reading "running" for as long as this tab
  // is streaming, so nothing acted on it: the case sat on Running and the
  // report needed a manual refresh. The row's own reading says the run this
  // tab is streaming has ended (its recorded start is at or after this
  // stream's). Held for the same 8s grace the watchdog gives a trailing report
  // chunk, then the dead stream is cut and the saved messages are merged, as
  // the watchdog would have done.
  const streamStartedAtRef = useRef<number | null>(null);
  if (isLoading) {
    if (streamStartedAtRef.current === null) streamStartedAtRef.current = Date.now();
  } else {
    streamStartedAtRef.current = null;
  }
  const streamOutlivedRun = useHeldTrue(
    shouldForceStreamEnd({
      clientStreaming: isLoading,
      rowState: caseSnapshot?.snapshot?.run.rowState ?? "draft",
      rowStartedAt: serverRunStartedAt,
      streamStartedAtMs: streamStartedAtRef.current,
    }),
    8_000,
  );
  useEffect(() => {
    if (!streamOutlivedRun) return;
    try { stopRef.current?.(); } catch { /* stream already closed */ }
    void reconcilePersistedMessages();
  }, [streamOutlivedRun, reconcilePersistedMessages]);

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
  // The message LiveActivityCard speaks for. It derives the role/action label and
  // owns that message's tool cards while the run streams, so the in-flight-part
  // selection that used to live here now sits with the thing that renders it.
  const liveAssistantMessage = useMemo(() => {
    if (!isLoading) return null;
    return [...messages].reverse().find((mm) => mm.role === "assistant") ?? null;
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

  // What the agent has linked so far: the same graph the Graph tab draws,
  // summarized. Held back until there is something to summarize.
  const artifactsByIdMemo = useMemo(() => new Map(artifacts.map((a) => [a.id, a] as const)), [artifacts]);
  const connections = useMemo(() => {
    if (artifacts.length === 0) return null;
    const reviews: Record<string, ReviewState> = {};
    for (const a of artifacts) {
      const r = review.map[a.id];
      if (r && r !== "new") reviews[a.id] = r;
    }
    return summarizeConnections(buildEntityGraph(artifacts, seedValue, seedType, reviews), artifacts);
  }, [artifacts, seedValue, seedType, review.map]);

  // Build suggested next-step replies after the agent stops streaming.
  // Memoized — without this the IIFE re-runs on every streamed token because
  // `messages` updates dozens of times per second during streaming.
  const suggestions = useMemo(() => {
    if (isLoading || messages.length === 0) return [] as NextStepItem[];
    // Wait for every input the ranking depends on, so the list is stable when shown.
    if (!seedLoaded || review.availability === "unknown") return [] as NextStepItem[];
    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!latestAssistant) return [];
    // "Next Steps" implies the investigation reached a real closing report.
    // Checking "any assistant message exists" let an interrupted run's
    // "### Run interrupted" recovery stub (or bare reasoning/narration, no
    // synthesis) show follow-up suggestions as if the run had finished —
    // gate on the LATEST turn actually being report-shaped instead.
    // Strip reasoning PER PART before joining: the backend salvage path
    // appends the salvaged report as a NEW text part after the truncated
    // turn's parts, and joining first let an unclosed <think> in an earlier
    // part swallow that report (REASONING_DANGLING_RE eats to end-of-string),
    // blanking this gate and hiding the panel on recovered/salvaged runs.
    const latestText = stripReasoningPerPart(
      (latestAssistant.parts as MessagePartShape[])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? ""),
    );
    if (!hasReportShape(latestText)) return [];
    const out: NextStepItem[] = [];
    const seenLabels = new Set<string>();
    const seenKeys = new Set<string>();
    const artifactsById = new Map(artifacts.map((a) => [a.id, a] as const));
    const reviewOf = (id: string) => review.map[id] ?? "new";
    // ONE engine over LIVE state: report recommendations + artifact findings,
    // deduped, already-run-filtered and ranked. Chat only takes the top 3
    // still-actionable ("new") pivots; already-searched ones sink to the Pivots
    // tab. Each is VALIDATED before it may carry a Run button — a malformed
    // suggestion (a table row, a report footer) stays visible as "needs repair".
    const ranked = computePivots({ artifacts, seedValue, reportPivots, skipSet: pivotSkip, queriedSet: queriedTargets, reviews: review.map, attempts: pivotAttempts });
    // Three RUNNABLE pivots, not the top three candidates. Validation used to
    // run after the slice, so a report whose recommendations were partly
    // unparseable filled two of three slots with "needs repair" cards and
    // pushed real, runnable pivots off the list. Unrunnable ones are still
    // collected (bounded) and shown behind one disclosure line by NextSteps.
    const repair: NextStepItem[] = [];
    let runnable = 0;
    for (const p of ranked.filter((candidate) => candidate.status === "new")) {
      if (runnable >= 3) break;
      const dedupe = cardDedupeKey({ title: p.actionLabel, target: p.value });
      if (seenKeys.has(dedupe)) continue;
      seenKeys.add(dedupe);
      const validation = validatePivotSuggestion(pivotSuggestionInput(p));
      if (validation.status !== "valid") {
        if (repair.length < 3) repair.push({ kind: "pivot", key: dedupe, validation, eligibility: null });
        continue;
      }
      seenLabels.add(p.actionLabel);
      runnable++;
      out.push({
        kind: "pivot",
        key: dedupe,
        validation,
        eligibility: pivotEligibility(validation.pivot, { artifactsById, review: reviewOf }),
        rationale: p.rationale,
      });
    }
    // Always include 1-2 generic next steps as fallback.
    const generic = [
      { title: "Summarize findings", detail: "Rank the strongest claims and rate overall confidence.", prompt: "Summarize the strongest findings so far and rate overall confidence." },
      { title: "Check for breaches", detail: "Run credential-exposure checks on the strongest identifiers.", prompt: "Run breach and credential-exposure checks on the strongest identifiers found so far." },
      { title: "Find more pivots", detail: "Return the next three highest-value leads.", prompt: "Suggest the next 3 highest-value pivots based on what's been discovered." },
    ] as const;
    for (const g of generic) {
      if (out.length >= 4) break;
      if (seenLabels.has(g.title)) continue;
      seenLabels.add(g.title);
      out.push({ kind: "action", key: `action:${g.title}`, title: g.title, detail: g.detail, prompt: g.prompt });
    }
    return [...out.slice(0, 4), ...repair];
  }, [isLoading, messages, artifacts, seedValue, seedLoaded, reportPivots, pivotSkip, queriedTargets, pivotAttempts, review.map, review.availability]);

  // The pivot Auto-run would start next. Read from a ref at cycle time, because
  // the cycle effect fires between renders. A pivot Auto-run already sent this
  // session is not sent again while the tool log catches up to it.
  const autoPick = pickAutoPivot(suggestions, autoSentRef.current);
  autoPivotRef.current = autoPick?.pivot ?? null;
  autoPivotKeyRef.current = autoPick?.key ?? null;

  return (
    <div className="chat-stage relative h-full min-w-0 overflow-hidden bg-background">
      {/* Soft stage wash — fills the main pane so content doesn't float in void */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -10%, hsl(var(--film) / 0.045), transparent 55%), radial-gradient(ellipse 70% 40% at 50% 110%, hsl(0 0% 0% / 0.5), transparent 50%)",
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

              <div className="mt-5 w-full max-w-md">
                <div className="mb-2 text-center font-mono text-eyebrow uppercase tracking-[0.2em] text-muted-foreground/55">
                  Try an example
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {["jordan.sample@example.com", "elonmusk", "8.8.8.8", "lovable.app"].map((s) => (
                    <button
                      key={s}
                      // Prefill the composer AND focus it so the caret lands in the
                      // now-populated box — a tap that silently set state read as
                      // "nothing happened", especially on mobile where the composer
                      // sits below the fold.
                      onClick={() => { setInput(s); inputRef.current?.focus(); }}
                      className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 font-mono text-data tabular-nums text-foreground/75 transition-colors hover:border-[hsl(var(--intel-blue)/0.45)] hover:bg-[hsl(var(--intel-blue)/0.07)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--intel-blue)/0.4)]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
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
          {/* Hide mid-run progress checkpoints once the final report lands so the
              same findings never render twice (see src/lib/chat-checkpoints.ts). */}
          {(() => {
            const rendered = dedupeCheckpoints(messages);
            // A multi-cycle run writes a COMPLETE report at every finalize, and
            // the transcript rendered all of them at full length. One observed
            // production thread carried four full "Investigation Report"
            // documents and SEVEN blocks each headed "Evidence Record —
            // authoritative" — a label only one of them can truthfully hold.
            // The newest report stays open; the earlier ones collapse to a line
            // the analyst can expand. Nothing is removed: a superseded report is
            // still the record of what the run believed at that point.
            const lastReportIdx = findLastReportIndex(rendered);
            return rendered.map((m, idx, arr) => {
              const isLastAssistant = m.role === "assistant" && idx === arr.length - 1;
              const hasCacheBanner = m.role === "assistant" && (m.parts as MessagePartShape[]).some((p) => p?.type === CACHE_BANNER_TYPE);
              const superseded = lastReportIdx >= 0 && idx < lastReportIdx && isReportMessage(m);
              return (
                <MessageView
                  key={m.id}
                  m={m}
                  createdAt={createdAtMap[m.id]}
                  onRetry={isLastAssistant ? retryLastUser : undefined}
                  onRerun={hasCacheBanner ? rerunInvestigation : undefined}
                  rerunBusy={rerunBusy}
                  superseded={superseded}
                  // While following the server, this run's first reply is still in
                  // progress there: not "Interrupted", and the panel lists its calls.
                  // A reply saved before the run started is an earlier run's (a tab
                  // that already had the case open) and keeps rendering as it was.
                  live={(isLoading || (followingServer && isCurrentRunMessage(createdAtMap[m.id], serverRunStartedAt))) && isLastAssistant}
                />
              );
            });
          })()}
          {isLoading && (
            <LiveActivityCard message={liveAssistantMessage} elapsedLabel={runElapsedLabel} />
          )}
          <ServerFollowPanel
            active={followingServer}
            events={currentRunEvents(caseSnapshot?.snapshot?.tools?.events ?? [], caseSnapshot?.snapshot?.run?.startedAt ?? null)}
          />
          {/* ONE card per failure.
              A failed run lands in two places: the live `error` state here, and
              a persisted assistant message prefixed FAIL_PREFIX which renders
              its own FailedRunCard in the transcript above. Both fired, so the
              analyst saw the same "Investigation run failed" card twice, stacked
              — identical title, body, hint and buttons — which reads as two
              separate failures.
              The persisted message is the durable record and wins; this live
              card is for a failure that has not been written to the thread.

              Third gate: a dropped CLIENT connection over a run the heartbeat
              proved alive. useChat keeps its `error` set for that dropped fetch
              regardless of what onError decided, so without this the analyst
              gets the warning toast ("still running") AND a red failure card
              with a Retry button — contradictory, and the Retry starts a second
              concurrent run on a thread that is already working. */}
          {error && !isLoading && !networkDropWhileAlive && !hasPersistedFailure(messages) && (
            <FailedRunCard reason={error.message} onRetry={retryLastUser} />
          )}
          {suggestions.length > 0 && (
            <NextSteps
              items={suggestions}
              onRunPivot={runPivotFromRail}
              onRunAction={(prompt) => void sendText(prompt)}
              busy={isLoading}
              openKey={openStep}
              onOpenChange={setOpenStep}
              connections={connections}
              artifactsById={artifactsByIdMemo}
              onOpenGraph={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "graph" } }))}
            />
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

      {/* Composer dock. Flat ground, no blur. Side padding mirrors
          .chat-stage__frame (1.25rem, 1.75rem from 1024px) so the composer
          column sits on the transcript column at every width (#645). On a
          phone the workspace's bottom tab bar sits below this and owns the
          safe-area inset, so the dock keeps only its own vertical padding. */}
      <div className="relative z-10 border-t border-border-subtle bg-background px-5 pb-1.5 pt-2 sm:pb-5 sm:pt-4 lg:px-7">
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
          <div className="composer-shell">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.json,.eml,.html,.md"
              className="hidden"
              onChange={(e) => onFilesPicked(e.target.files)}
            />
            {/* Label row. Visually hidden on a phone, where the composer is one
                line, but still the textarea's accessible name. */}
            <div className="flex items-center justify-between gap-2 px-3 pt-2 max-sm:sr-only">
              <label htmlFor={composerIds.textarea} className="text-data font-medium text-foreground/90">
                {isFollowUp ? "Message this case" : "Investigation request"}
              </label>
              <span className="hidden text-micro text-muted-foreground sm:inline" aria-hidden>
                {primary.kind === "continue"
                  ? <><kbd className="font-sans">⌘/Ctrl</kbd> + <kbd className="font-sans">Enter</kbd> to continue</>
                  : <><kbd className="font-sans">⌘/Ctrl</kbd> + <kbd className="font-sans">Enter</kbd> to {isFollowUp ? "send" : "start"} · Enter for a new line</>}
              </span>
            </div>
            <div className="flex items-end gap-1 p-1.5 sm:block sm:p-0">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                className="h-11 w-11 shrink-0 rounded-full text-muted-foreground hover:bg-white/[0.05] hover:text-foreground sm:hidden"
                aria-label="Attach file"
              >
                <Paperclip className="h-[18px] w-[18px]" aria-hidden />
              </Button>
              <Textarea
                ref={inputRef}
                id={composerIds.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onKeyDown={(e) => {
                  // Enter writes a new line; Cmd/Ctrl+Enter runs the primary
                  // action — Continue on an open case with an empty box, else
                  // start/send, and only when the preflight says the request is
                  // valid. An IME composition's confirming Enter is never a submit.
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    if (primary.kind === "continue") runContinue();
                    else if ((primary.kind === "start" || primary.kind === "send") && !primary.disabled) void send();
                  }
                }}
                placeholder={isFollowUp
                  ? (isPhone ? "Ask or add a selector" : "Ask about this case, or add a selector to pivot on…")
                  : (isPhone ? "Email, handle, phone…" : "e.g. analyst@example.com — who controls this mailbox?")}
                aria-describedby={composerIds.help}
                aria-invalid={Boolean(preflight.errors.target)}
                rows={1}
                enterKeyHint="enter"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-h-[44px] max-h-52 min-w-0 flex-1 font-chat bg-transparent border-0 resize-none overflow-y-auto focus-visible:ring-0 focus-visible:ring-offset-0 px-1 py-2.5 text-[16px] leading-6 tracking-[-0.01em] placeholder:text-muted-foreground/70 sm:px-3 sm:py-2 sm:text-body"
              />
              <div className="flex shrink-0 items-center gap-1 sm:gap-1.5 sm:px-2 sm:pb-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                  className="hidden h-8 w-8 shrink-0 rounded-md text-muted-foreground transition-colors duration-fast hover:bg-white/[0.05] hover:text-foreground sm:inline-flex [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                  aria-label="Attach file"
                  title="Attach file"
                >
                  <Paperclip className="h-4 w-4" aria-hidden />
                </Button>
                <span className="hidden min-w-0 sm:contents">
                  <TargetChip
                    result={preflight}
                    kindOverride={controls.targetKind}
                    onKindChange={(k) => setControls((c) => ({ ...c, targetKind: k }))}
                  />
                </span>
                {runControlsVisible && (
                  <>
                    <RunChips
                      busy={isLoading}
                      autoRunEnabled={autoRun.enabled}
                      autoRunCyclesRun={autoRun.cyclesRun}
                      onToggleAutoRun={toggleAutoRun}
                      onWriteReport={runWriteReport}
                      className="ml-auto max-sm:hidden"
                    />
                    <RunMenu
                      busy={isLoading}
                      autoRunEnabled={autoRun.enabled}
                      autoRunCyclesRun={autoRun.cyclesRun}
                      onToggleAutoRun={toggleAutoRun}
                      onWriteReport={runWriteReport}
                      className="sm:hidden"
                    />
                  </>
                )}
                <Button
                  type="button"
                  data-testid={primary.kind === "continue" ? "run-continue" : "composer-primary"}
                  onClick={
                    primary.kind === "stop" ? stopInvestigation
                      : primary.kind === "continue" ? runContinue
                        : () => void send()
                  }
                  disabled={
                    primary.kind === "stop" ? primary.stopping
                      : primary.kind === "continue" ? false
                        : primary.disabled
                  }
                  className={cn(
                    "h-11 w-11 shrink-0 gap-1.5 rounded-full p-0 text-data font-semibold transition-colors duration-fast",
                    "sm:h-9 sm:w-auto sm:rounded-lg sm:px-3.5 [@media(pointer:coarse)]:sm:h-11",
                    !runControlsVisible && "sm:ml-auto",
                    primary.kind === "stop"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : "bg-white text-black hover:bg-white/90 disabled:bg-white/[0.08] disabled:text-muted-foreground disabled:opacity-100",
                  )}
                >
                  {primary.kind === "stop"
                    ? primary.stopping
                      ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> <span className="max-sm:sr-only">Stopping…</span></>
                      : <><Square className="h-3.5 w-3.5 fill-current" aria-hidden /> <span className="max-sm:sr-only">Stop investigation</span></>
                    : primary.kind === "continue"
                      ? <><Play className="h-4 w-4 fill-current sm:h-3.5 sm:w-3.5" aria-hidden /> <span className="max-sm:sr-only">Continue</span></>
                      : primary.kind === "send"
                        ? <><span className="max-sm:sr-only">Send</span> <ArrowUp className="h-4 w-4" aria-hidden /></>
                        : <><span className="max-sm:sr-only">Start investigation</span> <ArrowUp className="h-4 w-4 rotate-90 max-sm:rotate-0" aria-hidden /></>}
                </Button>
              </div>
            </div>
          </div>
          {/* One stable line under the composer: the helper, the error, or the
              pre-submit summary — so what the request will do is always
              stated, and the box never jumps as it changes. */}
          <p
            id={composerIds.help}
            aria-live="polite"
            className={cn(
              "mt-1.5 min-h-[1.25rem] truncate px-1 text-micro",
              preflight.errors.target ? "text-[hsl(var(--danger))]" : "text-muted-foreground",
              // On a phone the default instruction is the placeholder's job;
              // the line only appears when it says something about THIS input.
              preflight.empty && !preflight.errors.target && "max-sm:sr-only",
            )}
          >
            {preflight.errors.target
              ? preflight.errors.target
              : preflight.empty
                ? primary.kind === "continue"
                  ? "Continue runs the next best pivots and reports only what is new — or ask anything about this case."
                  : isFollowUp
                    ? "Ask about this case, or name a new selector to pivot on."
                    : "Enter one primary target, then state the question you need answered."
                : `Target: ${preflight.summary.target}`}
          </p>
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
