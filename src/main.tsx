import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import {
  installGlobalHandlers, setErrorSink, sanitizeUrl, capString,
  MAX_MESSAGE_LEN, MAX_STACK_LEN, MAX_SINK_BREADCRUMBS, MAX_EXTRA_BYTES,
  type CapturedError,
} from "./lib/telemetry";
import { supabase } from "./integrations/supabase/client";

// Catch uncaught errors + unhandled promise rejections before first render.
installGlobalHandlers();

// Remote error capture (Option B: Supabase table, no new dependency — see #67).
// Fire-and-forget: never blocks startup, never throws, never recurses into the
// global handlers it's fed by even if the insert itself fails.
setErrorSink((record: CapturedError) => {
  void (async () => {
    try {
      let userId: string | null = null;
      try {
        const { data } = await supabase.auth.getSession();
        userId = data.session?.user?.id ?? null;
      } catch {
        /* no session available — report anonymously */
      }

      // Bound each field so a runaway payload (or a malicious anon-key caller)
      // can't bloat the table. breadcrumbs → last N; extra → size-capped.
      const cappedBreadcrumbs = record.breadcrumbs.slice(-MAX_SINK_BREADCRUMBS);
      let extra = record.extra ? JSON.parse(JSON.stringify(record.extra)) : null;
      try {
        if (extra && JSON.stringify(extra).length > MAX_EXTRA_BYTES) {
          extra = { truncated: true, note: "extra exceeded client size cap" };
        }
      } catch {
        extra = null;
      }

      await supabase.from("client_errors").insert({
        user_id: userId,
        // sanitizeUrl already runs at capture; re-apply here as the persistence-
        // boundary guard so the remote table is protected regardless of caller.
        source: capString(record.source, 256) ?? "unknown",
        message: capString(record.message, MAX_MESSAGE_LEN) ?? "",
        stack: capString(record.stack, MAX_STACK_LEN) ?? null,
        url: sanitizeUrl(record.url),
        // Round-trip through JSON so arbitrary breadcrumb/extra payloads (which may
        // contain values TS can't statically prove are `Json`) match the column type.
        breadcrumbs: JSON.parse(JSON.stringify(cappedBreadcrumbs)),
        extra,
        client_ts: new Date(record.ts).toISOString(),
      });
    } catch {
      /* remote sink is best-effort only; localStorage + console already captured it */
    }
  })();
});

createRoot(document.getElementById("root")!).render(<App />);
