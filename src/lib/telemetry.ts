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

// --- Size caps + URL sanitization (issue #67 review) -----------------------
// A remote error sink must never persist auth/token material and must not grow
// unbounded. These caps bound each field; sanitizeUrl strips credentials.
export const MAX_URL_LEN = 2048;
export const MAX_MESSAGE_LEN = 8192;
export const MAX_STACK_LEN = 16384;
export const MAX_SINK_BREADCRUMBS = 30;
export const MAX_EXTRA_BYTES = 16384;

const SENSITIVE_PARAM_KEYS = new Set([
  "access_token", "refresh_token", "id_token", "provider_token", "provider_refresh_token",
  "token", "code", "state", "session", "session_id", "otp", "password", "secret",
  "api_key", "apikey", "jwt", "auth", "credential",
]);

function isSensitiveParam(key: string): boolean {
  const k = key.toLowerCase();
  if (SENSITIVE_PARAM_KEYS.has(k)) return true;
  // Denylist backstop for anything token/secret/session-shaped we didn't list.
  return /token|secret|password|passwd|pwd|session|credential|otp|jwt|api[_-]?key/.test(k);
}

/**
 * Strip auth/token material from a URL before it is persisted or shipped remotely.
 * Supabase's implicit OAuth/recovery flow returns access/refresh tokens in the URL
 * FRAGMENT (`#access_token=…&refresh_token=…`) and the PKCE `code`/`state` in the
 * QUERY, so an error captured on `/auth` would otherwise leak live credentials into
 * `client_errors`. Component allowlist: keep origin + path always; drop the fragment
 * wholesale; keep only non-sensitive query params (e.g. `?tab=evidence`) for triage.
 */
export function sanitizeUrl(raw: string): string {
  if (!raw) return raw;
  try {
    // record.url is always an absolute href (location.href); no base, so genuine
    // garbage throws into the catch branch instead of resolving to a fake origin.
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveParam(key)) u.searchParams.delete(key);
    }
    u.search = u.searchParams.toString();
    const out = u.toString();
    return out.length > MAX_URL_LEN ? out.slice(0, MAX_URL_LEN) : out;
  } catch {
    // Not parseable as a URL — defensively drop everything from the first ? or #.
    return raw.split(/[?#]/, 1)[0].slice(0, MAX_URL_LEN);
  }
}

/** Truncate a string to a max length, marking where it was cut. */
export function capString(s: string | undefined | null, max: number): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

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
    url: sanitizeUrl(typeof location !== "undefined" ? location.href : ""),
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
