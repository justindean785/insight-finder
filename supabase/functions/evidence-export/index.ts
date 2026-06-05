// Evidence Export — packages an investigation's chain-of-custody as a
// PDF + JSON manifest, zipped, with embedded chain attestation.

import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { zipSync, strToU8 } from "npm:fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type EvidenceRow = {
  id: string;
  seq: number;
  classification: "hard" | "soft";
  kind: string | null;
  value: string | null;
  source: string | null;
  source_url: string | null;
  tool_name: string | null;
  confidence: number | null;
  chain_hash: string;
  prev_hash: string;
  content_hash: string;
  collected_at: string;
  metadata: Record<string, unknown> | null;
  archive_storage_path?: string | null;
  archive_sha256?: string | null;
  archive_bytes?: number | null;
  archive_content_type?: string | null;
};

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/);
  let line = "";
  for (const w of words) {
    if ((line + " " + w).length > max) { if (line) out.push(line); line = w.slice(0, max); }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

async function buildPdf(opts: {
  thread: { id: string; title: string; seed_value: string | null; seed_type: string | null; created_at: string };
  rows: EvidenceRow[];
  verify: { ok: boolean; total: number; first_break: number | null };
  exportedAt: string;
  manifestSha: string;
}): Promise<Uint8Array> {
  const { thread, rows, verify, exportedAt, manifestSha } = opts;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const PAGE_W = 612, PAGE_H = 792, MARGIN = 48;
  const ink = rgb(0.08, 0.08, 0.1);
  const muted = rgb(0.45, 0.45, 0.5);
  const accent = rgb(0.2, 0.6, 0.95);
  const danger = rgb(0.85, 0.25, 0.25);
  const good = rgb(0.15, 0.65, 0.4);

  // Cover
  const cover = pdf.addPage([PAGE_W, PAGE_H]);
  cover.drawText("Chain of Custody Report", { x: MARGIN, y: PAGE_H - MARGIN - 8, size: 22, font: bold, color: ink });
  cover.drawText("Tamper-evident evidence bundle", { x: MARGIN, y: PAGE_H - MARGIN - 32, size: 11, font, color: muted });

  const kv: [string, string][] = [
    ["Investigation", thread.title || "(untitled)"],
    ["Thread ID", thread.id],
    ["Seed", `${thread.seed_type ?? "—"} · ${thread.seed_value ?? "—"}`],
    ["Opened", new Date(thread.created_at).toISOString()],
    ["Exported", exportedAt],
    ["Entries", String(rows.length)],
    ["Hard / Soft", `${rows.filter((r) => r.classification === "hard").length} / ${rows.filter((r) => r.classification === "soft").length}`],
    ["Archived attachments", String(rows.filter((r) => r.archive_storage_path).length)],
  ];
  let y = PAGE_H - MARGIN - 80;
  for (const [k, v] of kv) {
    cover.drawText(k, { x: MARGIN, y, size: 10, font: bold, color: muted });
    for (const ln of wrap(v, 70)) {
      cover.drawText(ln, { x: MARGIN + 130, y, size: 10, font, color: ink });
      y -= 14;
    }
    y -= 6;
  }
  // Verdict
  y -= 10;
  cover.drawRectangle({ x: MARGIN, y: y - 50, width: PAGE_W - 2 * MARGIN, height: 50, color: verify.ok ? rgb(0.92, 0.98, 0.94) : rgb(0.99, 0.92, 0.92) });
  cover.drawText(verify.ok ? "✓ CHAIN VERIFIED" : "✗ CHAIN BROKEN", {
    x: MARGIN + 12, y: y - 22, size: 14, font: bold, color: verify.ok ? good : danger,
  });
  cover.drawText(verify.ok ? `${verify.total} rows · all hash links valid` : `Break detected at seq ${verify.first_break ?? "?"}`, {
    x: MARGIN + 12, y: y - 40, size: 10, font, color: ink,
  });

  // Entries
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let cy = PAGE_H - MARGIN;
  page.drawText("Evidence Log", { x: MARGIN, y: cy, size: 14, font: bold, color: ink }); cy -= 22;

  const newPageIfNeeded = (needed: number) => {
    if (cy - needed < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      cy = PAGE_H - MARGIN;
    }
  };

  for (const r of rows) {
    newPageIfNeeded(90);
    page.drawText(`#${r.seq}`, { x: MARGIN, y: cy, size: 10, font: bold, color: muted });
    page.drawText(r.classification.toUpperCase(), {
      x: MARGIN + 40, y: cy, size: 9, font: bold,
      color: r.classification === "hard" ? good : accent,
    });
    page.drawText(`${r.kind ?? "—"}${typeof r.confidence === "number" ? ` · ${r.confidence}%` : ""}`, {
      x: MARGIN + 90, y: cy, size: 9, font, color: muted,
    });
    page.drawText(new Date(r.collected_at).toISOString(), {
      x: PAGE_W - MARGIN - 130, y: cy, size: 8, font: mono, color: muted,
    });
    cy -= 14;
    for (const ln of wrap(`value: ${r.value ?? ""}`, 90)) {
      newPageIfNeeded(14);
      page.drawText(ln, { x: MARGIN, y: cy, size: 9, font, color: ink }); cy -= 12;
    }
    if (r.source || r.source_url) {
      const s = `source: ${r.source ?? ""}${r.source_url ? ` · ${r.source_url}` : ""}`;
      for (const ln of wrap(s, 95)) {
        newPageIfNeeded(12);
        page.drawText(ln, { x: MARGIN, y: cy, size: 8, font, color: muted }); cy -= 10;
      }
    }
    if (r.archive_storage_path) {
      newPageIfNeeded(12);
      page.drawText(`archived: ${r.archive_storage_path} · ${r.archive_bytes ?? 0}B · sha256:${(r.archive_sha256 ?? "").slice(0, 16)}…`, {
        x: MARGIN, y: cy, size: 7, font: mono, color: accent,
      });
      cy -= 10;
    }
    newPageIfNeeded(12);
    page.drawText(`chain: ${r.chain_hash.slice(0, 32)}…  prev: ${r.prev_hash.slice(0, 16)}…`, {
      x: MARGIN, y: cy, size: 7, font: mono, color: muted,
    });
    cy -= 18;
  }

  // Verification page
  const vp = pdf.addPage([PAGE_W, PAGE_H]);
  let vy = PAGE_H - MARGIN;
  vp.drawText("Verification", { x: MARGIN, y: vy, size: 14, font: bold, color: ink }); vy -= 24;
  vp.drawText("This PDF is a self-attesting bundle. Integrity is provided by the underlying SHA-256 hash chain", {
    x: MARGIN, y: vy, size: 9, font, color: muted,
  }); vy -= 12;
  vp.drawText("recorded server-side in evidence_log, not by a PKI digital signature.", {
    x: MARGIN, y: vy, size: 9, font, color: muted,
  }); vy -= 24;

  const lastChain = rows.length > 0 ? rows[rows.length - 1].chain_hash : "—";
  const attest: [string, string][] = [
    ["Manifest SHA-256", manifestSha],
    ["Final chain_hash", lastChain],
    ["Verification result", verify.ok ? "VALID" : `BROKEN at seq ${verify.first_break}`],
    ["Verified rows", String(verify.total)],
    ["Exported at", exportedAt],
  ];
  for (const [k, v] of attest) {
    vp.drawText(k, { x: MARGIN, y: vy, size: 10, font: bold, color: muted }); vy -= 14;
    for (const ln of wrap(v, 78)) {
      vp.drawText(ln, { x: MARGIN + 12, y: vy, size: 9, font: mono, color: ink }); vy -= 12;
    }
    vy -= 8;
  }

  return await pdf.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = userData.user.id;
    const { threadId } = (await req.json()) as { threadId: string };
    if (!threadId) return new Response(JSON.stringify({ error: "threadId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: thread } = await admin.from("threads")
      .select("id,user_id,title,seed_value,seed_type,created_at")
      .eq("id", threadId).maybeSingle();
    if (!thread || (thread as { user_id: string }).user_id !== userId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: rowsData } = await admin.from("evidence_log")
      .select("id,seq,classification,kind,value,source,source_url,tool_name,confidence,chain_hash,prev_hash,content_hash,collected_at,metadata,archive_storage_path,archive_sha256,archive_bytes,archive_content_type")
      .eq("thread_id", threadId)
      .order("seq", { ascending: true });
    const rows = (rowsData as EvidenceRow[]) ?? [];

    // Verify chain as the user
    const { data: verifyData } = await userClient.rpc("verify_evidence_chain", { _thread_id: threadId });
    const v = Array.isArray(verifyData) ? verifyData[0] : verifyData;
    const verify = { ok: !!v?.ok, total: Number(v?.total ?? rows.length), first_break: (v?.first_break ?? null) as number | null };

    const exportedAt = new Date().toISOString();
    const manifest = {
      schema: "lovable.evidence.bundle.v1",
      exported_at: exportedAt,
      thread: thread,
      verification: verify,
      entries: rows,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestSha = await sha256Hex(manifestJson);
    const finalManifest = { ...manifest, manifest_sha256: manifestSha };
    const finalJson = JSON.stringify(finalManifest, null, 2);

    const pdfBytes = await buildPdf({
      thread: thread as { id: string; title: string; seed_value: string | null; seed_type: string | null; created_at: string },
      rows, verify, exportedAt, manifestSha,
    });

    const stamp = exportedAt.replace(/[:.]/g, "-");
    const zipped = zipSync({
      [`evidence-${threadId}-${stamp}/manifest.json`]: strToU8(finalJson),
      [`evidence-${threadId}-${stamp}/report.pdf`]: pdfBytes,
      [`evidence-${threadId}-${stamp}/README.txt`]: strToU8(
        `Chain-of-custody export for thread ${threadId}\nExported: ${exportedAt}\nManifest SHA-256: ${manifestSha}\nVerification: ${verify.ok ? "VALID" : `BROKEN@${verify.first_break}`}\n`,
      ),
    });

    const fname = `evidence-${threadId}-${stamp}.zip`;
    return new Response(zipped, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "X-Manifest-Sha256": manifestSha,
        "X-Verification": verify.ok ? "valid" : `broken@${verify.first_break}`,
        // Sensitive chain-of-custody data — never cache.
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("[evidence-export] error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});