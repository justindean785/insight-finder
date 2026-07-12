import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { installGlobalHandlers, setErrorSink, type CapturedError } from "./lib/telemetry";
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

      await supabase.from("client_errors").insert({
        user_id: userId,
        source: record.source,
        message: record.message,
        stack: record.stack ?? null,
        url: record.url,
        // Round-trip through JSON so arbitrary breadcrumb/extra payloads (which may
        // contain values TS can't statically prove are `Json`) match the column type.
        breadcrumbs: JSON.parse(JSON.stringify(record.breadcrumbs)),
        extra: record.extra ? JSON.parse(JSON.stringify(record.extra)) : null,
        client_ts: new Date(record.ts).toISOString(),
      });
    } catch {
      /* remote sink is best-effort only; localStorage + console already captured it */
    }
  })();
});

createRoot(document.getElementById("root")!).render(<App />);
