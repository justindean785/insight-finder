/**
 * Lightweight, dependency-free client telemetry.
 *
 * Captures a rolling buffer of breadcrumbs (route/auth/scan events) and structured
 * error records, logs them to the console, and persists the last crash to
 * localStorage so it survives the reload after a blank-page. Designed so a beta
 * user can hit "Copy diagnostics" and paste a full breadcrumb trail.
 *
 * Remote capture (Sentry/Supabase/etc.) is intentionally NOT wired — call
 * `setErrorSink()` once a real backend table or DSN exists. Until then this is
 * local-only and makes no false promises about remote reporting.
 */

export type Breadcrumb = {
  ts: number;
  category: string;
  message: string;
  data?: Record<string, unknown>;
};

export type CapturedError = {
  ts: number;
  source: string;
  message: string;
  stack?: string;
  url: string;
  breadcrumbs: Breadcrumb[];
  extra?: Record<string, unknown>;
};

const MAX_BREADCRUMBS = 50;
const LAST_ERROR_KEY = "if_last_error";

const breadcrumbs: Breadcrumb[] = [];
let sink: ((record: CapturedError) => void) | undefined;
let installed = false;

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Record a non-error event (auth bootstrap, route change, scan start, …). */
export function addBreadcrumb(category: string, message: string, data?: Record<string, unknown>): void {
  breadcrumbs.push({ ts: Date.now(), category, message, data });
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
}

export function getBreadcrumbs(): Breadcrumb[] {
  return [...breadcrumbs];
}

/** Register a remote reporter. Best-effort; failures inside it are swallowed. */
export function setErrorSink(fn: (record: CapturedError) => void): void {
  sink = fn;
}

/** Capture an error with the current breadcrumb trail. Returns the record. */
export function captureError(error: unknown, source: string, extra?: Record<string, unknown>): CapturedError {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
  const record: CapturedError = {
    ts: Date.now(),
    source,
    message: err.message,
    stack: err.stack,
    url: typeof location !== "undefined" ? location.href : "",
    breadcrumbs: getBreadcrumbs(),
    ...(extra ? { extra } : {}),
  };

  // Structured console output so it's grabbable from the browser devtools.
  console.error(`[telemetry:${source}]`, err, record);

  try {
    getLocalStorage()?.setItem(LAST_ERROR_KEY, JSON.stringify(record));
  } catch {
    /* localStorage full or unavailable — non-fatal */
  }

  if (sink) {
    try {
      sink(record);
    } catch {
      /* a broken reporter must never cascade into another error */
    }
  }

  return record;
}

/** The last persisted crash, if any (survives reload). */
export function getLastError(): CapturedError | null {
  try {
    const raw = getLocalStorage()?.getItem(LAST_ERROR_KEY);
    return raw ? (JSON.parse(raw) as CapturedError) : null;
  } catch {
    return null;
  }
}

/** Install global handlers for uncaught errors + unhandled promise rejections. */
export function installGlobalHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    captureError(e.error ?? e.message, "window.onerror");
  });
  window.addEventListener("unhandledrejection", (e) => {
    captureError(e.reason, "unhandledrejection");
  });
  addBreadcrumb("app", "telemetry installed");
}
