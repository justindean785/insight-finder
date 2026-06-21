import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  ArrowDown, ArrowUp, Loader2, ChevronDown, ChevronRight, Wrench, RotateCcw, AlertTriangle,
  StickyNote, CheckCircle2, XCircle, Clock, CircleSlash, Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { detectSeed } from "@/lib/seed";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { buildPivots } from "@/lib/intel";
import { scrollBehavior } from "@/lib/motion";
import { deriveToolCharge, deriveToolPreview, deriveToolRuntime, deriveToolTone } from "@/lib/tool-run";
import { shouldFollowChatScroll } from "@/lib/chat-scroll";
import {
  extractRecommendedPivots,
  recommendedPivotsStorageKey,
} from "@/lib/recommended-pivots";
import { Sparkles, GitBranch, Paperclip, X, FileText, Image as ImageIcon } from "lucide-react";

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

function CodePanel({
  label, content, onCopy, variant = "input",
}: {
  label: string;
  content: string;
  onCopy: () => void;
  variant?: "input" | "output" | "error";
}) {
  const lineCount = content.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join("\n");
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
        <span className="code-panel__head-label">{label}</span>
        <button
          type="button"
          className="text-data tracking-wider hover:text-foreground transition-colors"
          onClick={onCopy}
        >
          copy
        </button>
      </div>
      <div className="code-panel__body">
        <div className="code-panel__gutter" aria-hidden>{gutter}</div>
        <pre className="code-panel__code">{content}</pre>
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

  // Duration: capture wall-clock when the call resolves so we can show
  // "2.3s" / "412ms" inline. Falls back to elapsed-since-mount when
  // createdAt is missing on legacy messages.
  const startRef = useRef<number>(ts ? ts.getTime() : Date.now());
  const [doneAt, setDoneAt] = useState<number | null>(null);
  useEffect(() => {
    if ((done || failed) && doneAt == null) setDoneAt(Date.now());
  }, [done, failed, doneAt]);
  const durationMs = doneAt != null ? Math.max(0, doneAt - startRef.current) : null;
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

  return (
    <div
      ref={rootRef}
      data-failed-tool={failed ? "true" : undefined}
      className={cn(
        "group relative my-2 text-xs animate-fade-up overflow-hidden rounded-2xl border backdrop-blur-xl",
        failed
          ? "intel-node intel-node--failed border-destructive/30 bg-[linear-gradient(180deg,rgba(70,20,20,0.24),rgba(16,9,9,0.82))] shadow-[0_24px_60px_-46px_hsl(var(--danger)/0.55)]"
          : "intel-node border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] shadow-[0_24px_60px_-48px_rgba(0,0,0,0.85)]",
        flash && "ring-2 ring-destructive/60",
      )}
    >
      {/* status rail */}
      <span
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[2px]",
          failed
            ? "bg-destructive shadow-[0_0_12px_hsl(var(--danger)/0.7)]"
            : tone === "skip"
            ? "bg-muted-foreground/30"
            : done
            ? "bg-primary shadow-[0_0_12px_hsl(var(--intel-blue)/0.6)]"
            : "bg-muted-foreground/40",
        )}
      />
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
      >
        <span
          className={cn(
            "inline-flex items-center justify-center w-2 h-2 rounded-full shrink-0",
            failed
              ? "bg-destructive shadow-[0_0_10px_hsl(var(--danger)/0.8)]"
              : tone === "skip"
              ? "bg-muted-foreground/45"
              : done
              ? "bg-primary shadow-[0_0_10px_hsl(var(--intel-blue)/0.7)]"
              : "bg-muted-foreground/60 animate-pulse",
          )}
        />
        <span
          className={cn(
            "font-mono text-eyebrow font-semibold tracking-[0.14em] uppercase truncate",
            failed ? "text-destructive" : "text-foreground/85",
          )}
        >
          {name}
        </span>
        {failed ? (
          <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
        ) : tone === "skip" ? (
          <CircleSlash className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
        ) : done ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
        ) : (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
        )}
        {artifactPreview && (
          <span className="text-data text-muted-foreground font-mono shrink-0">
            · {artifactPreview}
          </span>
        )}
        {argSummary && (
          <span
            className="hidden md:inline text-data text-muted-foreground/70 font-mono truncate min-w-0 max-w-[42%]"
            title={argSummary}
          >
            {argSummary}
          </span>
        )}

        <span className="ml-auto hidden sm:flex items-center gap-2 shrink-0">
          {cached && (
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-mono uppercase tracking-wider border border-primary/30 bg-primary/10 text-primary">
              cached
            </span>
          )}
          {tier && (
            <span
              className={cn(
                "px-1.5 py-0.5 rounded-md text-[9px] font-mono uppercase tracking-wider border",
                tier === "smart"
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-white/10 bg-white/[0.04] text-muted-foreground",
              )}
              title={tierModel ? `${tier} · ${tierModel}` : tier}
            >
              {tier}
            </span>
          )}
          {durationLabel && (
            <span
              className="px-1.5 py-0.5 rounded-md text-[9px] font-mono tabular-nums border border-white/10 bg-white/[0.03] text-muted-foreground"
              title={`Tool runtime: ${durationMs}ms`}
            >
              {durationLabel}
            </span>
          )}
          {ts && (
            <span className="font-mono text-data text-muted-foreground/70 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          {charge.label && (
            <span
              className="font-mono text-data text-muted-foreground/60"
              title={charge.title ?? undefined}
            >
              {charge.label}
            </span>
          )}
        </span>
        <span className="ml-auto sm:hidden font-mono text-data text-muted-foreground/70 shrink-0">
          {ts ? ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        )}
      </button>
      {open && (
        <div className="border-t border-white/6 bg-background/40 p-4 space-y-3 text-xs">
          {part.input != null && (
            <CodePanel
              label="Input"
              content={safeStringify(part.input)}
              onCopy={() => copyToClipboard(safeStringify(part.input), "Input copied")}
              variant="input"
            />
          )}
          {part.output !== undefined && (
            <CodePanel
              label="Output"
              content={safeStringify(part.output)}
              onCopy={() => copyToClipboard(safeStringify(part.output), "Output copied")}
              variant="output"
            />
          )}
          {part.errorText && (
            <CodePanel
              label="Error"
              content={part.errorText}
              onCopy={() => copyToClipboard(part.errorText ?? "", "Error copied")}
              variant="error"
            />
          )}
          <div>
            <div className="text-muted-foreground mb-1.5 flex items-center gap-1 font-mono uppercase tracking-wider text-eyebrow"><StickyNote className="w-3 h-3" /> Note</div>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Analyst note (saved locally)…"
              rows={2}
              className="text-xs"
            />
            <div className="flex items-center justify-end gap-2 mt-1">
              {noteSaved && <span className="text-data text-muted-foreground">saved</span>}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  localStorage.setItem(noteKey, note);
                  setNoteSaved(note);
                  toast.success("Note saved");
                }}
              >Save note</Button>
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

function groupToolParts(parts: MessagePartShape[]): Array<ToolRunGroup | { part: ToolPartShape }> {
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
    const selector = typeof runtime?.selector === "string" && runtime.selector ? runtime.selector : name;
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

function ToolGroupSummary({ group, createdAt }: { group: ToolRunGroup; createdAt?: string }) {
  const [expanded, setExpanded] = useState(false);
  const avgExpected = group.expectedValues.length
    ? Math.round(group.expectedValues.reduce((sum, value) => sum + value, 0) / group.expectedValues.length)
    : null;
  const time = createdAt ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const selectors = Array.from(new Set(group.selectors)).slice(0, 3);
  const extra = Math.max(0, new Set(group.selectors).size - selectors.length);
  const summaryBits = [
    group.cached > 0 ? `${group.cached} cached` : null,
    group.stale > 0 ? `${group.stale} stale` : null,
    group.skipped > 0 ? `${group.skipped} skipped` : null,
    group.failed > 0 ? `${group.failed} failed` : null,
    group.useful > 0 ? `${group.useful} completed` : null,
  ].filter(Boolean);
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] text-data text-muted-foreground">
      <button
        type="button"
        className="w-full px-4 py-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex flex-wrap items-center gap-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-mono uppercase tracking-[0.2em] text-foreground/80">
            {group.stage} cycle {group.cycleId > 0 ? group.cycleId : "?"}
          </span>
          <span>{group.parts.length} call{group.parts.length === 1 ? "" : "s"}</span>
          {avgExpected != null && <span>EV {avgExpected}</span>}
          {time && <span>{time}</span>}
        </div>
        <div className="mt-1 break-all text-foreground/80 sm:break-normal">
          {selectors.join(" • ")}
          {extra > 0 ? ` • +${extra} more` : ""}
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          {summaryBits.map((bit) => (
            <span key={bit} className="rounded-md border border-white/8 bg-black/20 px-1.5 py-0.5 font-mono text-data">
              {bit}
            </span>
          ))}
        </div>
        {group.reasons[0] && (
          <div className="mt-1 text-data text-muted-foreground/80">
            {group.reasons[0]}
          </div>
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-white/8 px-3 py-3">
          {group.parts.map((part, partIndex) => (
            <ToolPart key={`${group.key}-${partIndex}`} part={part} createdAt={createdAt} />
          ))}
        </div>
      )}
    </div>
  );
}

const LABEL_STYLES: Record<string, string> = {
  CONFIRMED: "bg-primary/15 text-primary border-primary/30",
  INFERRED:  "bg-accent/15 text-accent border-accent/30",
  VERIFY:    "bg-[hsl(var(--confidence-mid)/0.15)] text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid)/0.4)]",
  FAILED:    "bg-destructive/15 text-destructive border-destructive/40",
  LOW:       "bg-muted text-muted-foreground border-border",
};

function renderTextWithBadges(text: string): React.ReactNode {
  const re = /\[(CONFIRMED|INFERRED|VERIFY|FAILED|LOW)\]/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tag = m[1];
    out.push(
      <span
        key={`b-${m.index}`}
        className={cn(
          "inline-block px-1.5 py-0.5 mr-1 rounded text-data font-semibold font-mono border align-middle",
          LABEL_STYLES[tag],
        )}
      >{tag}</span>,
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
          <div className="text-eyebrow font-mono uppercase tracking-[0.18em] text-destructive/80">
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
          className="text-eyebrow font-mono uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-white/[0.04]"
        >
          Copy technical details
        </button>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="text-eyebrow font-mono uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-white/[0.04]"
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

function MessageView({ m, createdAt, onRetry, onRerun, rerunBusy }: { m: UIMessage; createdAt?: string; onRetry?: () => void; onRerun?: () => void; rerunBusy?: boolean }) {
  if (m.role === "user") {
    const text = (m.parts as MessagePartShape[]).filter((p) => p.type === "text").map((p) => p.text).join("");
    return (
      <div className="flex justify-end">
        <div
          className="relative max-w-[78%] min-w-0 rounded-2xl rounded-br-md pl-4 pr-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground/95 border border-white/[0.06] shadow-[0_8px_28px_-16px_hsl(0_0%_0%/0.7)]"
          style={{
            background:
              "linear-gradient(180deg, hsl(248 40% 12% / 0.55) 0%, hsl(230 14% 5% / 0.65) 100%)",
            backdropFilter: "blur(18px) saturate(160%)",
            WebkitBackdropFilter: "blur(18px) saturate(160%)",
            overflowWrap: "anywhere",
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
            style={{
              background:
                "linear-gradient(180deg, hsl(var(--primary)) 0%, hsl(var(--intel-violet)) 100%)",
              boxShadow: "0 0 12px hsl(var(--primary) / 0.55)",
            }}
          />
          {text}
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
  // Detect failed run sentinel
  const firstText = parts.find((p) => p.type === "text");
  if (firstText?.text?.startsWith?.(FAIL_PREFIX)) {
    const reason = firstText.text.slice(FAIL_PREFIX.length);
    return (
      <div className="space-y-2">
        {toolGroups.map((entry, i) => "part" in entry ? (
          <ToolPart key={`failed-tool-${i}`} part={entry.part} createdAt={createdAt} />
        ) : (
          <ToolGroupSummary key={`failed-group-${entry.key}-${i}`} group={entry} createdAt={createdAt} />
        ))}
        {onRetry && <FailedRunCard reason={reason} onRetry={onRetry} />}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {cacheMeta && onRerun && (
        <CacheBanner cachedAt={cacheMeta.cachedAt} onRerun={onRerun} busy={!!rerunBusy} />
      )}
      {toolGroups.length > 0 && (
        <div className="space-y-2">
          {toolGroups.map((entry, i) => "part" in entry ? (
            <ToolPart key={`tool-${i}`} part={entry.part} createdAt={createdAt} />
          ) : (
            <ToolGroupSummary key={`${entry.key}-${i}`} group={entry} createdAt={createdAt} />
          ))}
        </div>
      )}
      {parts.map((p, i) => {
        if (p.type === CACHE_BANNER_TYPE) return null;
        if (typeof p.type === "string" && p.type.startsWith("tool-")) return null;
        if (p.type === "text") {
          const cleaned = reflowCollapsedTables(stripThinkTags(p.text ?? ""));
          if (!cleaned) return null;
          return (
            <div
              key={i}
              className="prose prose-sm prose-invert font-chat max-w-none min-w-0 break-words prose-headings:font-display prose-headings:tracking-tight prose-h1:text-base prose-h2:text-sm prose-h2:mt-4 prose-h2:mb-2 prose-h2:pb-1 prose-h2:border-b prose-h2:border-border-subtle prose-h3:text-meta prose-h3:mt-3 prose-h3:mb-1.5 prose-p:leading-7 prose-p:my-2 prose-li:my-0.5 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-[hsl(var(--info))] prose-code:px-1 prose-code:py-px prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-a:text-[hsl(var(--info))] prose-a:no-underline hover:prose-a:underline prose-hr:border-border-subtle"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Replace plain text nodes containing [LABEL] tokens with badges
                  p: ({ node, children, ...rest }) => <p {...rest}>{wrapChildren(children)}</p>,
                  li: ({ node, children, ...rest }) => <li {...rest}>{wrapChildren(children)}</li>,
                  pre: ({ node, children, ...rest }) => (
                    <div className="my-2 -mx-1 sm:mx-0 rounded-lg border border-border-subtle bg-secondary/40 overflow-hidden">
                      <pre
                        {...rest}
                        className="overflow-x-auto whitespace-pre p-3 text-data leading-[1.55] font-mono text-foreground/90 [scrollbar-width:thin]"
                      >
                        {children}
                      </pre>
                    </div>
                  ),
                  table: ({ node, children, ...rest }) => (
                    <div className="my-2 -mx-1 sm:mx-0 rounded-lg border border-border-subtle bg-secondary/30 overflow-x-auto [scrollbar-width:thin]">
                      <table {...rest} className="w-full text-data border-collapse">
                        {children}
                      </table>
                    </div>
                  ),
                  th: ({ node, children, ...rest }) => (
                    <th {...rest} className="text-left font-semibold text-foreground px-2.5 py-1.5 border-b border-border-subtle bg-secondary/40 whitespace-nowrap">
                      {children}
                    </th>
                  ),
                  td: ({ node, children, ...rest }) => (
                    <td {...rest} className="align-top px-2.5 py-1.5 border-b border-border-subtle/60 text-foreground/90">
                      {wrapChildren(children)}
                    </td>
                  ),
                } satisfies Components}
              >{cleaned}</ReactMarkdown>
            </div>
          );
        }
        if (typeof p.type === "string" && p.type.startsWith("tool-")) {
          return <ToolPart key={i} part={p as ToolPartShape} createdAt={createdAt} />;
        }
        return null;
      })}
    </div>
  );
}

function wrapChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") return renderTextWithBadges(children);
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === "string" ? <span key={i}>{renderTextWithBadges(c)}</span> : c,
    );
  }
  return children;
}

/**
 * Remove agent chain-of-thought tokens so raw <think>…</think> blocks don't
 * leak into the rendered chat. Drops closed blocks and any trailing unclosed
 * block streaming in.
 */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/<think[\s\S]*$/i, "")
    .replace(/<\/think>/gi, "")
    .trim();
}

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
    return <div className="flex-1 grid place-items-center text-muted-foreground min-w-0">Loading…</div>;
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
  // Set true immediately before any programmatic scrollTop write so the
  // resulting scroll event doesn't get misread as the user scrolling away
  // (which would disengage follow mid-stream).
  const programmaticScrollRef = useRef(false);
  const [input, setInput] = useState("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [stopping, setStopping] = useState(false);
  const failSavedRef = useRef(false);
  const unmountedRef = useRef(false);
  const readyProbedOnceRef = useRef(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const { items: artifacts } = useThreadArtifacts(threadId);
  const [seedValue, setSeedValue] = useState<string | null>(null);
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
  useEffect(() => {
    if (status === "streaming" || status === "submitted") return;
    setMessages(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, setMessages]);

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

  // Pin the viewport to the true bottom. Flags the write as programmatic so
  // onScroll won't treat it as the user scrolling away.
  const pinToBottom = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    programmaticScrollRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  // New message added / message array changed → pin if following. A single
  // rAF isn't enough because streamed markdown lays out across several frames;
  // the ResizeObserver below catches that continuous growth.
  useEffect(() => {
    if (!followLatestRef.current) return;
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
      if (followLatestRef.current) pinToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [pinToBottom]);
  useEffect(() => { inputRef.current?.focus(); }, [threadId]);

  const beginInvestigation = useCallback(async () => {
    const { error: statusError } = await supabase
      .from("threads")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", threadId);
    if (statusError) throw statusError;
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
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: scrollBehavior() });
  }, []);

  const send = async () => {
    const text = input.trim();
    const hasFiles = attachments.length > 0;
    if ((!text && !hasFiles) || status === "streaming" || status === "submitted") return;
    if (uploading) {
      toast.error("Wait for uploads to finish");
      return;
    }
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
    //   200 + ok:false → deployed but a required dep is missing (e.g. orchestrator key)
    if (!readyProbedOnceRef.current) {
      readyProbedOnceRef.current = true;
      const { signal, cancel } = signalWithTimeout(5000);
      try {
        const probeRes = await fetch(`${FUNCTIONS_URL}?health=1`, { method: "GET", signal });
        if (probeRes.status === 404) {
          toast.error("Edge function not deployed. Run: supabase functions deploy osint-agent");
          return;
        }
        if (probeRes.ok) {
          try {
            const body = (await probeRes.json()) as {
              ok?: boolean;
              checks?: { orchestrator?: { ok: boolean; detail?: string } };
            };
            if (body && body.ok === false) {
              const orch = body.checks?.orchestrator;
              const msg = orch?.detail
                ? `Scan backend is not ready: ${orch.detail}`
                : "Scan backend is not ready (required secret missing).";
              toast.error(msg);
              return;
            }
          } catch {
            // Body wasn't JSON — treat as "deployed but unknown shape", let the scan through
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
  };

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || !user) return;
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
    if (!t || status === "streaming" || status === "submitted") return;
    try {
      await beginInvestigation();
      await sendMessage({ text: t });
    } catch (e) {
      console.error("sendText failed:", e);
      toast.error(`Failed to send message: ${describeTransportError(e)}`);
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
          title: userText.slice(0, 80),
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

  const reportPivots = useMemo(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!latestAssistant) return [];
    const text = (latestAssistant.parts as MessagePartShape[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return extractRecommendedPivots(text);
  }, [messages]);

  useEffect(() => {
    if (reportPivots.length === 0) return;
    try {
      localStorage.setItem(recommendedPivotsStorageKey(threadId), JSON.stringify(reportPivots));
    } catch {
      // Storage may be unavailable in private browsing; the event still syncs this tab.
    }
    window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", {
      detail: { threadId, pivots: reportPivots },
    }));
  }, [reportPivots, threadId]);

  // Build suggested next-step replies after the agent stops streaming.
  // Memoized — without this the IIFE re-runs on every streamed token because
  // `messages` updates dozens of times per second during streaming.
  const suggestions = useMemo(() => {
    if (isLoading || messages.length === 0) return [] as { label: string; prompt: string; icon: "pivot" | "spark" }[];
    const hasAssistant = messages.some((m) => m.role === "assistant");
    if (!hasAssistant) return [];
    const out: { label: string; prompt: string; icon: "pivot" | "spark" }[] = [];
    const seenLabels = new Set<string>();
    const seenTypes = new Map<string, number>();
    const shortValue = (v: string, type: string): string => {
      if (type === "url") {
        try {
          const u = new URL(v.startsWith("http") ? v : `https://${v}`);
          const path = u.pathname && u.pathname !== "/" ? u.pathname.slice(0, 18) : "";
          return `${u.hostname}${path}`;
        } catch { /* fall through */ }
      }
      return v.length > 36 ? v.slice(0, 34) + "…" : v;
    };
    if (reportPivots.length > 0) {
      for (const pivot of reportPivots.slice(0, 3)) {
        seenLabels.add(pivot.label);
        out.push({ label: pivot.label, prompt: pivot.prompt, icon: "pivot" });
      }
    } else {
      // No explicit final-report recommendations: fall back to artifact-derived leads.
      const allPivots = buildPivots(artifacts, seedValue).filter((p) => p.status === "new");
      const nonUrl = allPivots.filter((p) => p.type !== "url");
      const urls = allPivots.filter((p) => p.type === "url");
      const ordered = [...nonUrl, ...urls];
      for (const p of ordered) {
        if (out.length >= 3) break;
        const typeCount = seenTypes.get(p.type) ?? 0;
        if (typeCount >= 1 && out.length < Math.min(3, ordered.length)) {
          const distinctTypes = new Set(ordered.map((x) => x.type)).size;
          if (seenTypes.size < distinctTypes) continue;
        }
        const display = shortValue(p.value, p.type);
        const label = `Pivot on ${display}`;
        if (seenLabels.has(label)) continue;
        seenLabels.add(label);
        seenTypes.set(p.type, typeCount + 1);
        out.push({
          label,
          prompt: `Pivot on "${p.value}" (${p.type}). Run the next investigation step on this specific lead.`,
          icon: "pivot",
        });
      }
    }
    // Always include 1-2 generic next steps as fallback.
    const generic = [
      { label: "Summarize findings", prompt: "Summarize the strongest findings so far and rate overall confidence." },
      { label: "Check for breaches", prompt: "Run breach and credential-exposure checks on the strongest identifiers found so far." },
      { label: "Find more pivots", prompt: "Suggest the next 3 highest-value pivots based on what's been discovered." },
    ] as const;
    for (const g of generic) {
      if (out.length >= 4) break;
      if (seenLabels.has(g.label)) continue;
      seenLabels.add(g.label);
      out.push({ ...g, icon: "spark" });
    }
    return out.slice(0, 4);
  }, [isLoading, messages, artifacts, seedValue, reportPivots]);

  return (
    <div className="relative flex-1 flex flex-col h-full min-w-0 overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.05),transparent_34%),radial-gradient(circle_at_50%_100%,rgba(43,52,68,0.18),transparent_28%)]" />
      <div className="pointer-events-none absolute inset-y-0 left-[calc(50%-28rem)] w-px bg-gradient-to-b from-transparent via-white/8 to-transparent hidden xl:block" />
      <div className="pointer-events-none absolute inset-y-0 right-[calc(50%-28rem)] w-px bg-gradient-to-b from-transparent via-white/8 to-transparent hidden xl:block" />
      <div
        ref={scrollRef}
        onScroll={(event) => {
          // Ignore the scroll event produced by our own pin-to-bottom write —
          // otherwise a mid-stream programmatic scroll that momentarily lands
          // short would flip follow off and stop tracking the live reply.
          if (programmaticScrollRef.current) {
            programmaticScrollRef.current = false;
            return;
          }
          const viewport = event.currentTarget;
          const follow = shouldFollowChatScroll(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight);
          followLatestRef.current = follow;
          setShowJumpToLatest(!follow);
        }}
        className="relative z-10 flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-6 py-4 sm:py-5"
      >
        <div ref={contentRef} className="max-w-[56rem] mx-auto space-y-6 min-w-0">
          <div className="h-2" aria-hidden />
          {messages.length === 0 && (
            <div className="py-3 sm:py-10">
              <div className="w-full max-w-[54rem] mx-auto overflow-hidden rounded-[22px] border border-white/12 bg-[linear-gradient(180deg,rgba(19,22,27,0.99),rgba(6,7,9,0.99))] shadow-[0_42px_130px_-64px_rgba(0,0,0,0.96)] ring-1 ring-white/6">
                <div className="grid border-b border-white/8 sm:grid-cols-[1fr_auto]">
                  <div className="px-4 sm:px-6 py-4 bg-white/[0.025]">
                    <div className="flex items-center gap-2 text-eyebrow font-mono uppercase tracking-[0.22em] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full bg-evidence shadow-[0_0_18px_hsl(var(--info)/0.8)]" />
                      Live intake
                    </div>
                    <div className="mt-2 text-2xl sm:text-3xl font-semibold tracking-normal text-foreground">
                      Launch an investigation
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-1 divide-x sm:divide-x-0 sm:divide-y divide-white/8 border-t sm:border-t-0 sm:border-l border-white/8">
                    <div className="px-4 py-3 min-w-[170px]">
                      <div className="text-eyebrow font-mono uppercase tracking-[0.18em] text-muted-foreground">Status</div>
                      <div className="mt-1 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--confidence-high))/28] bg-[hsl(var(--confidence-high))/9] px-2.5 py-1 text-eyebrow font-mono uppercase tracking-[0.14em] text-[hsl(var(--confidence-high))]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--confidence-high))]" />
                        Ready
                      </div>
                    </div>
                    <div className="px-4 py-3 min-w-[170px]">
                      <div className="text-eyebrow font-mono uppercase tracking-[0.18em] text-muted-foreground">Case</div>
                      <div className="mt-1 font-mono text-data tabular-nums text-foreground/72">
                        {`SWB-${new Date().getFullYear()}-${threadId.slice(0, 4).toUpperCase()}`}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-px bg-white/8 sm:grid-cols-3">
                  {[
                    ["1", "Seed", "Email, domain, handle, IP, phone, wallet"],
                    ["2", "Route", "Agent selects providers and pivots"],
                    ["3", "Review", "Evidence lands with confidence tiers"],
                  ].map(([step, title, copy]) => (
                    <div key={step} className="bg-background/95 p-4 sm:p-5">
                      <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/12 bg-white/[0.035] font-mono text-data text-foreground">
                        {step}
                      </div>
                      <div className="mt-4 text-sm font-semibold text-foreground">{title}</div>
                      <div className="mt-1 text-xs leading-5 text-muted-foreground">{copy}</div>
                    </div>
                  ))}
                </div>

                <div className="grid gap-px bg-white/8 md:grid-cols-[1.15fr_0.85fr]">
                  <div className="bg-background/95 px-4 sm:px-6 py-5 sm:py-6 font-chat">
                    <div className="flex items-center gap-2 text-eyebrow font-mono uppercase tracking-[0.22em] text-muted-foreground">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary/80 shadow-[0_0_10px_hsl(var(--primary)/0.8)]" />
                      Seed examples
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {["taciocero@icloud.com", "elonmusk", "8.8.8.8", "lovable.app"].map((s) => (
                        <button
                          key={s}
                          onClick={() => setInput(s)}
                          className="min-w-0 truncate rounded-xl border border-white/10 bg-white/[0.035] px-3.5 py-3 text-left font-mono text-data tabular-nums text-foreground/90 transition-colors hover:border-info/45 hover:bg-info/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/35"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="bg-background/95 px-4 sm:px-6 py-5 sm:py-6">
                    <div className="text-eyebrow font-mono uppercase tracking-[0.22em] text-muted-foreground">
                      Opened
                    </div>
                    <div className="mt-2 break-words font-mono text-data tabular-nums text-foreground/82">
                      {new Date().toUTCString().replace("GMT", "UTC")}
                    </div>
                    <div className="mt-5 text-eyebrow font-mono uppercase tracking-[0.22em] text-muted-foreground">
                      Classification
                    </div>
                    <div className="mt-2 inline-flex rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5 font-mono text-eyebrow uppercase tracking-[0.16em] text-info">
                      Internal
                    </div>
                  </div>
                </div>
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
              <span className="bg-gradient-to-r from-foreground/40 via-foreground to-foreground/40 bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer font-medium">
                Investigating…
              </span>
            </div>
          )}
          {error && !isLoading && (
            <FailedRunCard reason={error.message} onRetry={retryLastUser} />
          )}
          {suggestions.length > 0 && (
            <div className="pt-2 animate-fade-up">
              <div className="flex items-center gap-2 mb-3 px-1">
                <Sparkles className="w-3 h-3 text-primary" />
                <span className="text-eyebrow font-mono uppercase tracking-[0.18em] text-muted-foreground">
                  Next steps
                </span>
                <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.label}-${i}`}
                    onClick={() => sendText(s.prompt)}
                    className="action-chip animate-fade-up"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    {s.icon === "pivot" ? (
                      <GitBranch className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                    )}
                    <span className="truncate max-w-[260px]">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {showJumpToLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="sticky bottom-3 ml-auto flex h-9 items-center gap-2 rounded-full border border-white/10 bg-surface-2/95 px-3 text-data font-medium text-foreground shadow-[0_16px_40px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl hover:bg-surface-3"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}
      </div>

      <div className="relative z-10 border-t border-border-subtle bg-background/95 backdrop-blur-xl px-3 sm:px-4 pt-3 sm:pt-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-5">
        <div className="max-w-[56rem] mx-auto">
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
                className="hidden"
                onChange={(e) => onFilesPicked(e.target.files)}
              />
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Investigate an email, username, phone, IP, or domain…"
                rows={2}
                className="min-h-[72px] max-h-32 font-chat bg-transparent border-0 resize-none overflow-y-auto focus-visible:ring-0 focus-visible:ring-offset-0 pl-[3.25rem] sm:pl-14 pr-14 sm:pr-16 py-3 sm:py-4 text-[15px] leading-6 tracking-[-0.01em] placeholder:text-muted-foreground/60"
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
