/**
 * redact-error — strip OUR OWN service credentials from an error message before it
 * leaves the function: an HTTP response body, a stream error part, an edge log line,
 * or a durable telemetry / tool_usage_log row.
 *
 * One implementation. There used to be three copies (here, telemetry.ts and a
 * weaker one inside cache.ts that missed `xai-` keys), and the request catch-all
 * logged the raw exception while redacting only the response (audit 2026-09-24,
 * F-7b/d).
 *
 * Two layers:
 *  1. Exact match on the credential VALUES this function is configured with (any
 *     env var named *_KEY / *_TOKEN / *_SECRET, 16+ chars). This catches a provider
 *     echoing our key whatever its shape: Z.AI, MiniMax and the rest have no stable
 *     prefix the patterns below could key on.
 *  2. Shape patterns, for credentials we do not hold as env values (a rotated key,
 *     a token minted at runtime).
 *
 * Scope: service credentials in ERROR text only. It is not applied to tool output
 * and has nothing to do with breach-data reveal (REVEAL_BREACH_DATA).
 */

const SECRET_ENV_NAME_RE = /(?:_KEY|_TOKEN|_SECRET)$/;
const MIN_SECRET_CHARS = 16;

type EnvReader = () => Record<string, string>;

// This module is Deno-only today, but read the global defensively so an import
// from a non-Deno test runner cannot throw.
const readEnv: EnvReader = () =>
  (globalThis as { Deno?: { env: { toObject(): Record<string, string> } } }).Deno?.env.toObject() ?? {};

/** The configured credential values, longest first so a key that contains another
 *  is replaced whole. Never throws: no env access means no values, patterns still run. */
export function configuredSecrets(env: EnvReader = readEnv): string[] {
  let vars: Record<string, string>;
  try {
    vars = env();
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const [name, value] of Object.entries(vars)) {
    const v = (value ?? "").trim();
    if (SECRET_ENV_NAME_RE.test(name) && v.length >= MIN_SECRET_CHARS) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

let cachedSecrets: string[] | null = null;

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]"],
  [/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]"],
  [/xai-[A-Za-z0-9._-]+/g, "xai-[REDACTED]"],
  [/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]"],
  // A labelled key in a header or body: `x-api-key: …`, `api_key=…`, `"apiKey":"…"`.
  [/((?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1[REDACTED]"],
  // A credential in a URL query string.
  [/([?&](?:key|api_?key|apikey|access_?token|token)=)[^\s&"']+/gi, "$1[REDACTED]"],
];

/**
 * Redact service credentials from `message`. `secrets` is injectable for tests; by
 * default it is read from the environment once per isolate.
 */
export function redactErrorMessage(message: string, secrets?: string[]): string {
  let out = String(message ?? "");
  const values = secrets ?? (cachedSecrets ??= configuredSecrets());
  for (const v of values) if (out.includes(v)) out = out.split(v).join("[REDACTED]");
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}
