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
  server: { host: "127.0.0.1", port: 5174 },
  plugins: [react()],
  resolve: {
    alias: [
      // Must precede the generic "@" alias — Vite matches in order.
      {
        find: /^@\/integrations\/supabase\/client$/,
        replacement: path.resolve(__dirname, "./src/dev/supabase-mock.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
