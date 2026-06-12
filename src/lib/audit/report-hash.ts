/**
 * Chain-of-custody hashing — two interchangeable SHA-256 implementations.
 *
 * Both produce IDENTICAL output for identical input (lowercase hex), so a report
 * fingerprinted in CI (Node) verifies byte-for-byte against one fingerprinted in
 * the browser (Web Crypto). Pick the impl that matches your runtime and pass it
 * to `serializeReport` as its `hash` argument.
 *
 *   - hashSourceWeb  → browser / Vite bundle. Uses Web Crypto only; pulls in no
 *                      `node:` builtins, so it never breaks the Vite build.
 *   - hashSourceNode → Node / CI scripts. `node:crypto` is dynamically imported
 *                      so it stays out of any browser bundle's static graph.
 */

export type HashFn = (input: string) => Promise<string>;

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Browser-safe SHA-256 via Web Crypto. Also valid under Node ≥18 and jsdom. */
export const hashSourceWeb: HashFn = async (input) => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
};

/** Node SHA-256 via node:crypto, dynamically imported to stay out of browser bundles. */
export const hashSourceNode: HashFn = async (input) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input, "utf8").digest("hex");
};
