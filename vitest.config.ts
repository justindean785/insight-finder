import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "src/components/ui/**",
        "src/integrations/**",
        "src/vite-env.d.ts",
        "src/main.tsx",
      ],
      // Ratchet floors calibrated to current measured coverage (2026-06-27):
      // statements 24.16 / branches 78.85 / functions 57.52 / lines 24.16.
      // Set just below current so CI passes today but coverage can't regress.
      // Raise these as coverage improves; do not lower them.
      thresholds: {
        statements: 24,
        branches: 75,
        functions: 55,
        lines: 24,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
