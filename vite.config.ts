import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    // Bind all interfaces. Avoid hardcoding "::" (IPv6-only), which fails with
    // EAFNOSUPPORT in containers/sandboxes that aren't IPv6-enabled.
    host: true,
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy, independently-cacheable vendors out of the main bundle so
        // the >500kb single-chunk warning clears and first paint doesn't pull in
        // the graph/chart/map libs (which only mount behind lazy workspace tabs).
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-supabase": ["@supabase/supabase-js"],
          "vendor-markdown": ["react-markdown", "remark-gfm"],
          "vendor-charts": ["recharts"],
          "vendor-graph": ["reactflow"],
          "vendor-map": ["leaflet", "react-leaflet"],
        },
      },
    },
  },
}));
