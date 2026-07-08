import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Ordered [chunkName, moduleIdPattern] rules for splitting heavy vendors into
// independently-cacheable chunks. Function-form manualChunks (rather than the
// object form) is required for correctness here: with the object form, Rollup
// places shared transitive deps by dependency-graph heuristics, which moved the
// react-dom runtime (~140 kB) into the radix chunk once one existed. Path
// matching is deterministic, and prefix rules (@radix-ui/, @supabase/) pick up
// newly added packages automatically instead of drifting back into the entry.
// Order matters: first match wins (e.g. react-markdown before the react rule).
const vendorChunkRules: Array<[chunk: string, pattern: RegExp]> = [
  ["vendor-radix", /node_modules\/@radix-ui\//],
  ["vendor-supabase", /node_modules\/@supabase\//],
  ["vendor-graph", /node_modules\/(@?reactflow|@reactflow\/)/],
  ["vendor-charts", /node_modules\/(recharts|victory-vendor)\//],
  ["vendor-map", /node_modules\/(leaflet|react-leaflet)\//],
  [
    "vendor-markdown",
    /node_modules\/(react-markdown|remark-[\w-]+|rehype-[\w-]+|micromark|micromark-[\w-]+|mdast-[\w-]+|unist-[\w-]+|unified|vfile[\w-]*|hast-[\w-]+|hastscript|property-information|space-separated-tokens|comma-separated-tokens|character-entities[\w-]*|decode-named-character-reference|markdown-table|trim-lines|ccount|zwitch|bail|trough|devlop|longest-streak|html-url-attributes)\//,
  ],
  ["vendor-react", /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//],
];

function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  for (const [chunk, pattern] of vendorChunkRules) {
    if (pattern.test(id)) return chunk;
  }
  return undefined;
}

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
        manualChunks,
      },
    },
  },
}));
