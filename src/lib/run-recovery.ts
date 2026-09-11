/**
 * run-recovery.ts — what the analyst is told when a run did not finish.
 *
 * PURE. Turns the thread's free-text `recovery_reason` into a stable code and a
 * plain-language explanation, and decides which recovery action (if any) is
 * safe to offer.
 *
 * THE SAFETY RULE THIS FILE EXISTS TO HOLD: never offer a blind retry. The
 * `osint-agent` endpoint accepts `{ messages, threadId }` and nothing else —
 * there is no run ID, no resume flag and no idempotency key, and the server does
 * not reject overlapping runs (see `fetch-retry.ts`). Every "retry", "re-run" or
 * "continue" is therefore a NEW POST that starts a NEW run with fresh budgets and
 * fresh spend. A button labelled "Resume" on top of that would promise the
 * analyst something the backend cannot do, and a double-click would start two
 * billed runs.
 *
 * So the primary action is modelled on a `ResumeContract` — the server-issued
 * run ID + idempotency key a real resume must bind to — and today no such
 * contract exists, so the action is always `unavailable` with the exact reason.
 * When the backend ships one, the plan offers `Resume investigation` without any
 * change to the banner.
 */
import type { CaseRunState } from "@/lib/case-snapshot";

export type RecoveryCode =
  | "STALE_HEARTBEAT"
  | "RUN_INCOMPLETE"
  | "REPORT_NOT_SAVED"
  | "STREAM_ERROR"
  | "RECOVERED"
  | "RUN_STALLED"
  | "STOPPED_BY_ANALYST"
  | "UNSPECIFIED";

export interface RecoveryClassification {
  code: RecoveryCode;
  title: string;
  /** One sentence, plain language, no internals. */
  message: string;
  /** The backend's own words, when they add something (the stream error text). */
  detail: string | null;
  tone: "warning" | "neutral";
}

const STALE_WHERE: { prefix: string; where: string }[] = [
  { prefix: "stale heartbeat recovered by health sweep", where: "Recovered by the server's health sweep." },
  { prefix: "stale heartbeat recovered at run startup", where: "Recovered when the next run started." },
  { prefix: "stale heartbeat recovered before new request", where: "Recovered when a new request arrived." },
  { prefix: "stale heartbeat recovered by sweeper", where: "Recovered by the server sweep." },
];

function clip(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Classify a run that did not finish. Returns null for a run that did (or is
 * still going): a completed or running case has nothing to recover.
 *
 * Every value the backend writes to `recovery_reason` is matched by PREFIX,
 * because the column is free text — `stream_error:` carries raw provider output.
 */
export function classifyRecovery(input: {
  runState: CaseRunState;
  recoveryReason: string | null;
  recoveredAt: string | null;
}): RecoveryClassification | null {
  if (input.runState === "stopped") {
    return {
      code: "STOPPED_BY_ANALYST",
      title: "Run stopped",
      message: "This run was stopped before it finished. Everything it collected up to that point is kept.",
      detail: null,
      tone: "neutral",
    };
  }
  if (input.runState !== "interrupted") return null;

  const reason = (input.recoveryReason ?? "").trim();
  const lower = reason.toLowerCase();

  if (lower.startsWith("stale heartbeat")) {
    const where = STALE_WHERE.find((s) => lower.startsWith(s.prefix))?.where ?? null;
    return {
      code: "STALE_HEARTBEAT",
      title: "Run stopped responding",
      message: "The run stopped sending heartbeats, so the server closed it. Evidence recorded before that point is kept.",
      detail: where,
      tone: "warning",
    };
  }
  if (lower.startsWith("incomplete: final report could not be saved")) {
    return {
      code: "REPORT_NOT_SAVED",
      title: "Final report not saved",
      message: "The run finished, but its final report could not be saved. The evidence it recorded is kept.",
      detail: null,
      tone: "warning",
    };
  }
  if (lower.startsWith("incomplete:")) {
    return {
      code: "RUN_INCOMPLETE",
      title: "Run ended without a report",
      message: "The run ended before it wrote a final report. Treat the findings as partial.",
      detail: lower.startsWith("incomplete: run ended without a durable report") ? null : clip(reason.slice("incomplete:".length)),
      tone: "warning",
    };
  }
  if (lower.startsWith("stream_error:")) {
    const text = reason.slice("stream_error:".length).trim();
    return {
      code: "STREAM_ERROR",
      title: "Model connection failed",
      message: "The connection to the model failed mid-run. Evidence recorded before the failure is kept.",
      detail: text ? clip(text) : null,
      tone: "warning",
    };
  }
  if (!reason && input.recoveredAt) {
    return {
      code: "RECOVERED",
      title: "Run recovered",
      message: "The server recovered this run after it stopped responding. Evidence recorded before that point is kept.",
      detail: null,
      tone: "warning",
    };
  }
  if (!reason && !input.recoveredAt) {
    return {
      code: "RUN_STALLED",
      title: "Run is not responding",
      message: "The run has stopped sending heartbeats but has not been closed yet. The server will mark it within a few minutes.",
      detail: null,
      tone: "warning",
    };
  }
  return {
    code: "UNSPECIFIED",
    title: "Run did not finish",
    message: "The run did not finish normally. Evidence recorded before it stopped is kept.",
    detail: clip(reason),
    tone: "warning",
  };
}

// ── Recovery action ─────────────────────────────────────────────────────────

/** What a safe resume must bind to. Issued by the server; never minted client-side. */
export interface ResumeContract {
  runId: string;
  idempotencyKey: string;
}

export const RESUME_UNAVAILABLE_REASON =
  "The server does not issue a resumable run ID or idempotency key yet, so a resume could not be guaranteed to run once. A new message would start a separate, billed run rather than continue this one.";

export type RecoveryAction =
  | { kind: "resume"; label: "Resume investigation"; contract: ResumeContract }
  | { kind: "unavailable"; label: "Recovery unavailable"; reason: string };

/**
 * The ONE primary action the recovery banner may offer.
 *
 * `resume` only with a server-issued contract that is well-formed. Anything else
 * — including a half-formed contract — is `unavailable`, with the reason spelled
 * out. There is deliberately no "retry" variant.
 */
export function recoveryPrimaryAction(contract: ResumeContract | null | undefined): RecoveryAction {
  if (
    contract &&
    typeof contract.runId === "string" && contract.runId.trim() &&
    typeof contract.idempotencyKey === "string" && contract.idempotencyKey.trim()
  ) {
    return { kind: "resume", label: "Resume investigation", contract };
  }
  return { kind: "unavailable", label: "Recovery unavailable", reason: RESUME_UNAVAILABLE_REASON };
}

// ── Diagnostic ──────────────────────────────────────────────────────────────

export interface RecoveryDiagnosticInput {
  threadId: string;
  classification: RecoveryClassification;
  runStateLabel: string;
  recoveryReason: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  recoveredAt: string | null;
  artifacts: number;
  toolTotal: number;
  toolFailed: number;
  toolDegraded: number;
  spendText: string;
  lastStage: string | null;
  failedTools: { name: string; reason?: string }[];
  capturedAt: string;
}

/**
 * Plain-text diagnostic for "Copy diagnostic".
 *
 * Carries identifiers, codes, counts and timestamps — enough to hand to whoever
 * operates the backend — and deliberately NOT the seed value or any artifact
 * value: a diagnostic is pasted into tickets and chats, and the investigation
 * target is personal data.
 */
export function buildRecoveryDiagnostic(d: RecoveryDiagnosticInput): string {
  const lines = [
    "Insight Finder — run diagnostic",
    `Case: ${d.threadId}`,
    `Status: ${d.runStateLabel} (${d.classification.code})`,
    `Recorded reason: ${d.recoveryReason ? clip(d.recoveryReason, 240) : "none"}`,
    `Run started: ${d.startedAt ?? "unknown"}`,
    `Last heartbeat: ${d.heartbeatAt ?? "unknown"}`,
    `Recovered at: ${d.recoveredAt ?? "not recovered"}`,
    `Preserved: ${d.artifacts} artifacts · ${d.toolTotal} tool calls (${d.toolFailed} failed, ${d.toolDegraded} degraded)`,
    `Spend recorded: ${d.spendText}`,
    `Last stage with tool activity: ${d.lastStage ?? "unknown"}`,
  ];
  if (d.failedTools.length > 0) {
    lines.push("Failed tools:");
    for (const t of d.failedTools.slice(0, 12)) {
      lines.push(`  - ${t.name}${t.reason ? ` — ${clip(t.reason, 140)}` : ""}`);
    }
  }
  lines.push(`Captured: ${d.capturedAt}`);
  return lines.join("\n");
}
