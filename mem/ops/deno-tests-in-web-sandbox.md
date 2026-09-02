---
name: Run deno (edge-fn) tests in the Claude Code web sandbox
description: dl.deno.land is egress-blocked in the web sandbox, but deno's official npm package delivers the binary via the allowlisted npm registry — install it that way, set DENO_CERT to the proxy CA, and the deno.land/std imports resolve so edge tests run
type: ops
---
> ⚠️ **CORRECTION, measured 2026-08-28.** `dl.deno.land` now answers **200**, not 403, so the
> official installer works directly and is the shorter route:
> `DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y` (verified —
> deno 2.9.6, full edge suite 1407 passed / 0 failed / 5 ignored). Egress policy varies by
> sandbox and by day: **test the host before believing either claim.** Everything below still
> works and remains the fallback when `dl.deno.land` is blocked again.
>
> Also add **`--no-lock`**: an unqualified `deno test` rewrites `deno.lock` and drops four real
> dependency entries (see `mem/ops/sandbox-traps.md`).

**Problem.** In the Claude Code on-the-web sandbox, `cd supabase/functions/osint-agent && deno test`
may not run because **`deno` is not installed and `dl.deno.land` can be a hard egress
policy-denial** (`403 CONNECT` — observed 2026-08-25, NOT reproducing 2026-08-28). Past sessions
concluded backend/edge changes are "unverifiable here" and pushed them CI-only. That is avoidable.

**Fix — install deno through the allowlisted npm registry:**
```bash
mkdir -p /tmp/denoinstall && cd /tmp/denoinstall && npm init -y >/dev/null
npm i deno@latest --no-audit --no-fund          # binary ships via npm optional-deps (like esbuild)
ln -sf "$PWD/node_modules/deno/deno" /usr/local/bin/deno
deno --version                                   # e.g. deno 2.9.2
```
`registry.npmjs.org` is on the proxy `noProxy` allowlist, so the binary downloads
even though `dl.deno.land` is blocked.

**Then run the edge suite** — `deno.land` (the module host, NOT `dl.deno.land`) IS
reachable (200), so `https://deno.land/std@0.224.0/...` imports resolve once you
point deno at the proxy CA:
```bash
cd supabase/functions/osint-agent
export DENO_CERT=/root/.ccr/ca-bundle.crt      # else TLS verify fails on std imports
deno test --no-check --allow-net --allow-env --allow-sys --allow-read safety_test.ts
# or the whole suite: npm run test:edge (from repo root)
```

**Reachability map (this sandbox, via the agent proxy):**
- `dl.deno.land` → **was BLOCKED 2026-08-25 (403 CONNECT), reachable 200 on 2026-08-28** — deno binary host. Re-test; do not assume.
- `deno.land/std@…` → **200** — module/std host, fine for imports at test time.
- `registry.npmjs.org`, `jsr.io`, `pypi.org`, `crates.io`, `proxy.golang.org` → allowlisted (`noProxy`).
- `github.com` web/releases → 403 (only git + the GitHub MCP API work).

Check state anytime with `curl -sS "$HTTPS_PROXY/__agentproxy/status"` (lists `noProxy`
+ recent relay failures). Never disable TLS / unset HTTPS_PROXY; point tools at
`/root/.ccr/ca-bundle.crt` instead (DENO_CERT for deno).
