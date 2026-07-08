import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY not set' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const started = Date.now();
  const r = await fetch(url);
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  const modelCount = (parsed as { models?: unknown[] })?.models?.length;
  return new Response(JSON.stringify({
    ok: r.ok,
    status: r.status,
    latency_ms: Date.now() - started,
    key_length: key.length,
    key_prefix: key.slice(0, 6),
    model_count: modelCount,
    sample: r.ok
      ? ((parsed as { models?: Array<{ name: string }> }).models ?? []).slice(0, 3).map((m) => m.name)
      : parsed,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});