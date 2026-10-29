/**
 * DEV-ONLY Vite config for the UI harness.
 *
 * Runs the real app with the Supabase client swapped for a fixture stub, so the
 * signed-in workspace renders without prod credentials or network access. Used
 * to review UI changes with screenshots before merging.
 *
 *   npx vite --config vite.harness.config.ts --port 5174
 *   → http://127.0.0.1:5174/chat/11111111-2222-4333-8444-555555555555
 *
 * The production config (`vite.config.ts`) is untouched, and nothing under
 * `src/` imports the stub — so this cannot affect a real build.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  // strictPort: when :5174 is taken, fail instead of drifting to the next free
  // port. Drifting landed a second harness on :5175, the Playwright e2e port,
  // where a local run tested it in place of the checkout (2026-10-26).
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      // Must precede the generic "@" alias — Vite matches in order.
      {
        find: /^@\/integrations\/supabase\/client$/,
        replacement: path.resolve(__dirname, "./src/dev/supabase-mock.ts"),
      },
      // Lets the harness render a RUNNING investigation. `isLoading` is useChat's
      // status, and the transport POSTs to a `harness.local` host that does not
      // resolve — so without this the live run state cannot be previewed at all,
      // and every UI change to it ships unscreenshotted. Same scope rule as the
      // client stub above: dev-only, nothing under src/ imports it.
      {
        find: /^@\/lib\/fetch-retry$/,
        replacement: path.resolve(__dirname, "./src/dev/fetch-retry-mock.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
