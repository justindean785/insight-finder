import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY not set' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const started = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly the word: pong' }] }] }),
  });
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  const reply = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  return new Response(JSON.stringify({
    ok: r.ok,
    status: r.status,
    latency_ms: Date.now() - started,
    model,
    key_prefix: key.slice(0, 6),
    reply,
    usage: parsed?.usageMetadata,
    error: r.ok ? undefined : parsed,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});