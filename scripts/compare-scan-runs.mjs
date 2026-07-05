#!/usr/bin/env node
/**
 * Compare two scan-run CSV exports — tool success-rate deltas + artifact metrics.
 *
 * Usage:
 *   node scripts/compare-scan-runs.mjs <baseline.csv> <candidate.csv>
 *
 * Supported CSV shapes (header row required):
 *
 * 1) Per-call tool rows (most common):
 *    tool_name,outcome
 *    dns_records,ok
 *    whois_lookup,failed
 *
 * 2) Pre-aggregated tool rows:
 *    tool_name,calls,ok,failed,empty,skipped
 *
 * 3) Run summary row (optional, one per file — artifact metrics):
 *    record_type,artifact_count,avg_confidence,unique_kinds,tool_calls,duration_ms
 *    summary,42,68.5,8,71,275000
 *
 * Outcome values: ok | empty | failed | skipped (or ok=true/false for legacy exports).
 */

import { readFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(field);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      if (ch === "\r") i++;
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }

  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((cells) => {
    const rec = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i]] = (cells[i] ?? "").trim();
    return rec;
  });
  return { headers, records };
}

function normOutcome(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "true" || s === "1" || s === "yes") return "ok";
  if (s === "false" || s === "0" || s === "no") return "failed";
  if (["ok", "empty", "failed", "skipped", "unknown"].includes(s)) return s;
  return s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function successRate(stats) {
  const attempts = stats.ok + stats.failed;
  if (attempts === 0) return null;
  return stats.ok / attempts;
}

function pct(n) {
  if (n == null || Number.isNaN(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function deltaPct(a, b) {
  if (a == null || b == null) return "n/a";
  return `${((b - a) * 100).toFixed(1)}pp`;
}

function extractSummary(records) {
  const summaryRow = records.find((r) => {
    const rt = (r.record_type ?? r.type ?? "").toLowerCase();
    return rt === "summary" || rt === "run" || rt === "run_summary";
  });
  if (!summaryRow) return null;

  return {
    artifact_count: num(summaryRow.artifact_count ?? summaryRow.artifacts),
    avg_confidence: num(summaryRow.avg_confidence ?? summaryRow.confidence_avg),
    unique_kinds: num(summaryRow.unique_kinds ?? summaryRow.kinds),
    tool_calls: num(summaryRow.tool_calls ?? summaryRow.calls),
    duration_ms: num(summaryRow.duration_ms ?? summaryRow.duration),
  };
}

function aggregateTools(records) {
  /** @type {Map<string, { calls: number, ok: number, failed: number, empty: number, skipped: number }>} */
  const byTool = new Map();

  for (const rec of records) {
    const rt = (rec.record_type ?? rec.type ?? "").toLowerCase();
    if (rt === "summary" || rt === "run" || rt === "run_summary") continue;

    const tool = rec.tool_name ?? rec.tool ?? "";
    if (!tool || ["summary", "run", "run_summary"].includes(tool.toLowerCase())) continue;

    if (rec.calls || rec.total) {
      const bucket = byTool.get(tool) ?? { calls: 0, ok: 0, failed: 0, empty: 0, skipped: 0 };
      bucket.calls += num(rec.calls ?? rec.total) ?? 0;
      bucket.ok += num(rec.ok ?? rec.ok_count) ?? 0;
      bucket.failed += num(rec.failed ?? rec.failed_count) ?? 0;
      bucket.empty += num(rec.empty ?? rec.empty_count) ?? 0;
      bucket.skipped += num(rec.skipped ?? rec.skipped_count) ?? 0;
      byTool.set(tool, bucket);
      continue;
    }

    const outcome = normOutcome(rec.outcome ?? rec.ok);
    const bucket = byTool.get(tool) ?? { calls: 0, ok: 0, failed: 0, empty: 0, skipped: 0 };
    bucket.calls += 1;
    if (outcome === "ok") bucket.ok += 1;
    else if (outcome === "failed") bucket.failed += 1;
    else if (outcome === "empty") bucket.empty += 1;
    else if (outcome === "skipped") bucket.skipped += 1;
    byTool.set(tool, bucket);
  }

  return byTool;
}

function loadRun(path) {
  const text = readFileSync(path, "utf8");
  const { records } = parseCsv(text);
  return {
    path,
    summary: extractSummary(records),
    tools: aggregateTools(records),
  };
}

function printToolDelta(baseline, candidate) {
  const tools = new Set([...baseline.tools.keys(), ...candidate.tools.keys()]);
  const rows = [];

  for (const tool of [...tools].sort()) {
    const b = baseline.tools.get(tool) ?? { calls: 0, ok: 0, failed: 0, empty: 0, skipped: 0 };
    const c = candidate.tools.get(tool) ?? { calls: 0, ok: 0, failed: 0, empty: 0, skipped: 0 };
    const bRate = successRate(b);
    const cRate = successRate(c);
    rows.push({
      tool,
      bCalls: b.calls,
      cCalls: c.calls,
      bRate,
      cRate,
      delta: bRate != null && cRate != null ? cRate - bRate : null,
    });
  }

  console.log("\n=== Tool success rate delta (ok / (ok+failed)) ===");
  console.log(
    pad("tool", 28),
    pad("base calls", 11),
    pad("cand calls", 11),
    pad("base ok%", 10),
    pad("cand ok%", 10),
    pad("delta", 8),
  );
  console.log("-".repeat(82));

  for (const r of rows) {
    if (r.bCalls === 0 && r.cCalls === 0) continue;
    console.log(
      pad(r.tool, 28),
      pad(String(r.bCalls), 11),
      pad(String(r.cCalls), 11),
      pad(pct(r.bRate), 10),
      pad(pct(r.cRate), 10),
      pad(deltaPct(r.bRate, r.cRate), 8),
    );
  }

  const bTotals = [...baseline.tools.values()].reduce(
    (a, s) => ({ ok: a.ok + s.ok, failed: a.failed + s.failed, calls: a.calls + s.calls }),
    { ok: 0, failed: 0, calls: 0 },
  );
  const cTotals = [...candidate.tools.values()].reduce(
    (a, s) => ({ ok: a.ok + s.ok, failed: a.failed + s.failed, calls: a.calls + s.calls }),
    { ok: 0, failed: 0, calls: 0 },
  );

  console.log("-".repeat(82));
  console.log(
    pad("TOTAL", 28),
    pad(String(bTotals.calls), 11),
    pad(String(cTotals.calls), 11),
    pad(pct(successRate(bTotals)), 10),
    pad(pct(successRate(cTotals)), 10),
    pad(deltaPct(successRate(bTotals), successRate(cTotals)), 8),
  );
}

function printArtifactMetrics(baseline, candidate) {
  console.log("\n=== Artifact / run metrics ===");
  const keys = ["artifact_count", "avg_confidence", "unique_kinds", "tool_calls", "duration_ms"];
  console.log(pad("metric", 22), pad("baseline", 14), pad("candidate", 14), pad("delta", 14));
  console.log("-".repeat(66));

  for (const key of keys) {
    const b = baseline.summary?.[key] ?? null;
    const c = candidate.summary?.[key] ?? null;
    let delta = "n/a";
    if (b != null && c != null) {
      if (key === "duration_ms") delta = `${((c - b) / 1000).toFixed(1)}s`;
      else if (key === "avg_confidence") delta = `${(c - b).toFixed(1)}`;
      else delta = String(c - b);
    }
    console.log(
      pad(key, 22),
      pad(b == null ? "n/a" : String(b), 14),
      pad(c == null ? "n/a" : String(c), 14),
      pad(delta, 14),
    );
  }

  if (!baseline.summary && !candidate.summary) {
    console.log("(no summary row found — add record_type=summary with artifact_count, avg_confidence, …)");
  }
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function main() {
  const baselinePath = process.argv[2];
  const candidatePath = process.argv[3];
  if (!baselinePath || !candidatePath) {
    console.error("Usage: node scripts/compare-scan-runs.mjs <baseline.csv> <candidate.csv>");
    process.exit(2);
  }

  const baseline = loadRun(baselinePath);
  const candidate = loadRun(candidatePath);

  console.log("Baseline:", baseline.path);
  console.log("Candidate:", candidate.path);

  printToolDelta(baseline, candidate);
  printArtifactMetrics(baseline, candidate);
}

main();
