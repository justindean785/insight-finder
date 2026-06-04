---
name: osint-agent-tool-integration
description: Add a new external OSINT API or tool to the osint-agent edge function. Use when wiring a new provider (breach lookup, social, image, infra, etc.) end-to-end — secret, cost, system prompt, tool implementation, planner registration, deploy, and smoke test.
---

# Adding a new tool to the OSINT agent

The agent lives in `supabase/functions/osint-agent/index.ts`. A "tool" here is an AI SDK `tool({ ... })` exposed inside the `streamText` call. Every new tool MUST be wired through all six checkpoints below — skipping any one of them produces silent failures (tool never called, cost not tracked, planner can't see it, or no auth).

## Inputs needed before starting

- Provider name + endpoint
- Auth scheme (header name, query param, bearer)
- Rate limit / quota (req/hour, req/day)
- Pricing (used for `costs.ts`, in micro-USD per successful call)
- Required input shape (e.g. Discord snowflake ID, email, domain)
- Sample successful response (to design the trim/normalization)

If any are missing, ask the user before writing code.

## Six-checkpoint workflow

### 1. Secret
If a private API key is required, call `secrets--add_secret` with `["PROVIDER_API_KEY"]`. Wait for the user to set it before continuing. Skip for publishable/public endpoints.

### 2. Cost entry — `supabase/functions/osint-agent/costs.ts`
Add a line to `TOOL_COSTS_MICRO_USD` keyed by the exact tool name. Use micro-USD (1e-6 USD). Guidance:
- Free/local endpoint → `0` or small floor (`50`)
- Daily quota of N per day on a free tier → `(2 / N) * 1_000_000` rounded, treating it as ~$2/mo replacement cost
- Pay-per-call → provider's published price × 1_000_000
- Bundled multi-call tools → sum the children

Group the new entry in the appropriate `// ----` section comment so the file stays scannable.

### 3. Env var binding — top of `index.ts`
Add `const PROVIDER_API_KEY = Deno.env.get("PROVIDER_API_KEY");` next to the existing block (~lines 33–42). Do NOT add `!` — let the tool branch handle the missing-key case gracefully.

### 4. Tool implementation
Add a `provider_tool_name: tool({ ... })` entry inside the `tools` object passed to `streamText`. Required shape:

```ts
provider_tool_name: tool({
  description: "One-line purpose. Input shape (e.g. 17-20 digit Discord snowflake, NOT username). Quota: 60 req/hour.",
  inputSchema: z.object({ id: z.string().describe("Discord snowflake ID") }),
  execute: async ({ id }) => {
    if (!PROVIDER_API_KEY) return { error: "PROVIDER_API_KEY not configured" };
    const r = await fetchRetry(`https://api.provider.com/v2/${encodeURIComponent(id)}`, {
      headers: { "X-API-Key": PROVIDER_API_KEY },
    });
    if (!r.ok) return { error: `provider ${r.status}`, status: r.status };
    const data = await r.json();
    // Trim/normalize: drop heavy fields, keep what the orchestrator reasons over.
    return { ok: true, ...normalize(data) };
  },
}),
```

Rules:
- Always use `fetchRetry` (defined at top of file) — never bare `fetch`. Gives 429/5xx backoff for free.
- Return `{ error: string }` on failure, never throw — throws kill the whole stream.
- Trim large response payloads (see `trimExaResults` as the pattern). Big payloads blow the context window.
- Validate the input matches what the API actually expects in the `description` (e.g. snowflake vs username) — the LLM reads this verbatim.
- If the tool mutates anything user-visible (artifacts, memory), use the existing `record_artifact` / `save_agent_memories` paths — do NOT write to Postgres directly inside a new tool.

### 5. Planner registration
Find the `toolList` array (passed to the planner / `minimax_plan_pivots`) and add `"provider_tool_name"`. If you skip this, the planner cannot suggest the new tool and it will only fire when the orchestrator stumbles into it.

### 6. System prompt
Add a short bullet to the system prompt section that lists tools, with: name, what it returns, required input shape, and rate limit. Match the existing format. Keep it under two lines.

## Verify

1. Deploy: `supabase--deploy_edge_functions` with `["osint-agent"]`.
2. Smoke test: `supabase--curl_edge_functions` against `/osint-agent` with a seed that should trigger the new tool. Confirm the tool fires in the streamed output.
3. Check `tool_usage_log` for a row with the new `tool_name` and a non-zero `cost_micro_usd`.
4. If the tool failed silently, check `supabase--edge_function_logs` for the `osint-agent` function.

## Common mistakes

- Forgetting checkpoint 5 (planner) → tool exists but never called.
- Forgetting checkpoint 2 (cost) → call works but defaults to `DEFAULT_TOOL_COST_MICRO_USD`, undercounting spend.
- Returning raw provider JSON → context window blows up after 3–4 calls.
- Throwing on auth failure → kills the whole investigation stream. Always return `{ error }`.
- Describing input wrong (e.g. "username" when API needs snowflake) → LLM passes garbage forever.