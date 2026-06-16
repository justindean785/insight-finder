/**
 * tools/recording.ts — Auto-extracted MIRROR. The LIVE definitions run inline in
 * ../index.ts (record_artifacts / record_artifact) — that is authoritative.
 * Source classification, confidence caps, and status derivation are owned by
 * ../source-classification.ts + ../confidence.ts (single source of truth); both
 * the live path and this mirror call them, so they never diverge. Add imports
 * manually when running this file directly.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

export const record_artifacts = tool({
  description:
    "Save a BATCH of discovered intelligence items. Strict kinds (pick one): " + STRICT_KINDS.join(", ") + ". " +
    "Do NOT use 'other' — pick the most specific kind, or use 'weak_lead' with metadata.reason. " +
    "Confidence is automatically CAPPED by source class server-side: breach-only ≤60, two-breach ≤65, username_sweep-only ≤45, social_profile_passive ≤40, ai_summary ≤55. " +
    "Setting confidence ≥90 only works when the artifact has corroboration from a court_record + independent_public/news source. " +
    "Each artifact may include metadata.{status, cluster_id, reason_for_confidence, reason_not_confirmed, contradictions, next_verification_step}. status enum: new|verified|probable|needs_review|contradicted|excluded|exhausted|manual_review_required.",
  inputSchema: z.object({
    // Tolerant input: some models emit `artifacts` as a JSON string
    // (or fenced code block). Parse it back into an array.
    artifacts: z.preprocess((raw) => {
      const parseMaybe = (v: unknown): unknown => {
        if (typeof v !== "string") return v;
        const s = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        try { return JSON.parse(s); } catch { /* fall through */ }
        const a = s.indexOf("["); const b = s.lastIndexOf("]");
        if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
        return v;
      };
      let v: unknown = parseMaybe(raw);
      if (v && !Array.isArray(v) && typeof v === "object") v = [v];
      return v;
    }, z.array(
        z.object({
          kind: z.string().describe("Pick the most specific kind. Primary: email|phone|ip|username|domain|subdomain|avatar|breach|address|name|social|organization|case|legal_record|infrastructure|financial_claim|event|source_person|risk_note. Use 'other' ONLY as a last resort. Common reclass: company/firm names → organization; 'United States v. X' → case; DRE/court records → legal_record; crm./portal./ledger./staging. hosts → subdomain; DNS/MX/SPF/CDN summaries → infrastructure; reporter/journalist → source_person; real-estate / donation summaries → financial_claim. Unknown kinds are coerced to 'other'."),
          value: z.string(),
          confidence: z.number().min(0).max(100).optional(),
          source: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(200)),
  }),
  execute: async ({ artifacts }) => {
    const accepted: Array<{ index: number; kind: string; value: string }> = [];
    const rejected: Array<{ index: number; reason: string; kind: string; value: string }> = [];
    const rows: Array<Record<string, unknown>> = [];
    artifacts.forEach((a, i) => {
      // Infer strict kind from value patterns (LAPD → law_enforcement_unit,
      // People v X → court_case, wallet hex → crypto_wallet, etc.).
      const inferred = inferKind(a.kind, a.value);
      const v = validateArtifact(inferred.kind, a.value);
      if (!v.ok) {
        rejected.push({ index: i, reason: v.reason, kind: a.kind, value: a.value });
        return;
      }
      // Apply conservative confidence caps based on source class.
      const aMeta = (a.metadata ?? {}) as Record<string, unknown>;
      const cap = applyEvidenceCaps({
        rawConfidence: a.confidence ?? 50,
        sources: [a.source ?? "", ...((aMeta.sources as unknown[]) ?? [])].filter(Boolean) as string[],
      });
      // Required-fields envelope. Status is DERIVED (deriveStatus) so it can never
      // contradict reason_not_confirmed — mirrors the live record_artifacts.
      const resolvedReasonNotConfirmed =
        (typeof aMeta.reason_not_confirmed === "string" ? aMeta.reason_not_confirmed : null) ??
        cap.reason_not_confirmed ?? null;
      const meta: Record<string, unknown> = {
        ...(a.metadata ?? {}),
        ...(v.metaPatch ?? {}),
        ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
        source_category: cap.source_classes,
        query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: aMeta }),
        status: coerceCoherentStatus(
          deriveStatus({
            requested: typeof aMeta.status === "string" ? aMeta.status : null,
            reasonNotConfirmed: resolvedReasonNotConfirmed,
            sourceClasses: cap.source_classes,
            contradictions: Array.isArray(aMeta.contradictions) ? aMeta.contradictions : [],
            deadEnd: looksDeadEnd(aMeta),
          }),
          resolvedReasonNotConfirmed,
        ),
        cluster_id: aMeta.cluster_id ?? null,
        reason_for_confidence: cap.reason_for_confidence,
        reason_not_confirmed: resolvedReasonNotConfirmed,
        contradictions: aMeta.contradictions ?? [],
        next_verification_step: aMeta.next_verification_step ?? null,
        confidence_cap_applied: cap.cap,
      };
      rows.push({
        thread_id: threadId,
        user_id: userId,
        kind: v.kind,
        value: v.value,
        confidence: cap.confidence,
        source: a.source ?? null,
        metadata: meta,
      });
      accepted.push({ index: i, kind: v.kind, value: v.value });
    });
    if (rows.length === 0) {
      return { ok: false, count: 0, accepted, rejected, hint: "All items failed validation — re-check kinds/values against the rules in the tool description." };
    }
    const safeRows = scrubArtifactRows(rows);
    let insertedRows = safeRows;
    const { error } = await supabase.from("artifacts").insert(safeRows);
    if (error) {
      // Bulk insert failed — fall back to per-row inserts so a single
      // bad row doesn't lose the whole batch of evidence.
      console.warn("[record_artifacts] bulk insert failed, retrying per-row:", error.message);
      const surviving: typeof safeRows = [];
      const perRowErrors: Array<{ index: number; error: string }> = [];
      for (let i = 0; i < safeRows.length; i++) {
        const { error: rowErr } = await supabase.from("artifacts").insert(safeRows[i]);
        if (rowErr) {
          perRowErrors.push({ index: i, error: rowErr.message });
        } else {
          surviving.push(safeRows[i]);
        }
      }
      if (surviving.length === 0) {
        return { ok: false, error: error.message, per_row_errors: perRowErrors, count: 0, accepted: [], rejected };
      }
      insertedRows = surviving;
    }
    const safeRowsForFollowup = insertedRows;
    const flagged = safeRows.filter((r) => (r.metadata as Record<string, unknown> | null)?.minor_warning).length;
    bumpArtifacts(safeRowsForFollowup.length, safeRowsForFollowup.map((r) => String(r.kind)));
    // Collision detection: for any phone/email/address just inserted,
    // check if the same normalized value is already linked to a
    // different cluster_id or different name in this thread. Record a
    // contradiction artifact instead of silently merging clusters.
    try {
      const collisionKinds = new Set(["phone", "email", "address"]);
      const candidates = safeRowsForFollowup.filter((r) => collisionKinds.has(String(r.kind)));
      for (const r of candidates) {
        const { data: peers } = await supabase
          .from("artifacts")
          .select("value,kind,source,metadata")
          .eq("thread_id", threadId)
          .eq("kind", String(r.kind))
          .eq("value", String(r.value));
        const sources = new Set<string>();
        const clusters = new Set<string>();
        for (const p of (peers ?? []) as Array<{ source?: unknown; metadata?: Record<string, unknown> | null }>) {
          if (p.source) sources.add(String(p.source));
          const cid = (p.metadata ?? {}).cluster_id;
          if (cid) clusters.add(String(cid));
        }
        if (sources.size >= 3 || clusters.size >= 2) {
          await supabase.from("artifacts").insert({
            thread_id: threadId,
            user_id: userId,
            kind: "contradiction",
            value: `${r.kind}:${r.value}`,
            confidence: 40,
            source: "collision_detector",
            metadata: {
              collision_value: r.value,
              collision_kind: r.kind,
              sources: Array.from(sources),
              clusters: Array.from(clusters),
              severity: clusters.size >= 2 ? "high" : "medium",
              status: "needs_review",
            },
          });
        }
      }
    } catch (e) { console.warn("[collision_detect]", (e as Error).message); }
    // Auto-recall: for every high-value artifact just recorded, fan-out a
    // memory lookup so the orchestrator never burns fresh quota on a
    // value we already learned about in a previous investigation.
    const HIGH_VALUE = new Set(["email", "username", "domain", "wallet", "phone", "name"]);
    const recallSubjects = Array.from(
      new Set(
        safeRows
          .filter((r) => HIGH_VALUE.has(String(r.kind)))
          .map((r) => String(r.value).trim().toLowerCase())
          .filter(Boolean),
      ),
    ).slice(0, 12);
    let memory_hits: Array<{ subject: string; count: number; memories: unknown[] }> = [];
    if (recallSubjects.length > 0) {
      try {
        const recalled = await Promise.all(
          recallSubjects.map(async (subj) => {
            const { data } = await supabase
              .from("agent_memory")
              .select("id,kind,subject,subject_kind,related_values,content,confidence,hit_count")
              .eq("user_id", userId)
              .or(`subject.eq.${subj},related_values.cs.{${subj}}`)
              .order("confidence", { ascending: false })
              .limit(5);
            return { subject: subj, count: data?.length ?? 0, memories: data ?? [] };
          }),
        );
        memory_hits = recalled.filter((r) => r.count > 0);
        const allIds = memory_hits.flatMap((h) => (h.memories as Array<{ id?: unknown }>).map((m) => m.id));
        if (allIds.length > 0) {
          supabase.rpc("bump_memory_hits", { _ids: allIds }).then(() => {}, () => {});
        }
      } catch (e) {
        console.warn("[record_artifacts] auto memory_recall failed:", e);
      }
    }
    // ---- Chain-of-custody: append one append-only evidence row per
    // accepted artifact. Serial (not parallel) because append_evidence
    // reads MAX(seq) per thread and would race under Promise.all.
    // Per-row try/catch so a single bad row doesn't break the hash chain
    // for the rest of the batch.
    let evidence_appended = 0;
    for (const r of safeRowsForFollowup) {
      try {
        const meta = (r.metadata as Record<string, unknown> | null) ?? {};
        const conf = typeof r.confidence === "number" ? (r.confidence as number) : null;
        const declared = String(meta.classification ?? "").toLowerCase();
        const classification =
          declared === "hard" || declared === "soft"
            ? declared
            : (conf ?? 0) >= 85
            ? "hard"
            : "soft";
        const sourceUrl =
          meta.source_url ||
          meta.url ||
          meta.profile_url ||
          meta.archived_url ||
          null;
        const snapshot = JSON.stringify(meta).slice(0, 1500);
        const { error: evErr } = await supabase.rpc("append_evidence", {
          _thread_id: threadId,
          _artifact_id: null,
          _tool_name: (r.source as string) ?? "agent",
          _source: (r.source as string) ?? null,
          _source_url: typeof sourceUrl === "string" ? sourceUrl : null,
          _classification: classification,
          _confidence: conf,
          _kind: String(r.kind),
          _value: String(r.value),
          _content_snapshot: snapshot,
          _metadata: meta,
        });
        if (!evErr) {
          evidence_appended++;
          // Fire-and-forget archive
          if (archiveEnabled && typeof sourceUrl === "string") {
            archiveAttachment(supabase, threadId, userId, sourceUrl).then(async (arch) => {
              if (!arch) return;
              await supabase
                .from("evidence_log")
                .update({
                  archive_storage_path: arch.path,
                  archive_sha256: arch.sha256,
                  archive_bytes: arch.bytes,
                  archive_content_type: arch.content_type,
                })
                .eq("thread_id", threadId)
                .eq("value", String(r.value))
                .eq("kind", String(r.kind))
                .is("archive_storage_path", null);
            }).catch((e) => console.warn("[archive] post-evidence:", (e as Error).message));
          }
        } else console.warn("[record_artifacts] append_evidence:", evErr.message);
      } catch (e) {
        console.warn("[record_artifacts] chain-of-custody row failed:", (e as Error)?.message ?? e);
      }
    }
    return {
      ok: true,
      count: safeRowsForFollowup.length,
      accepted,
      rejected,
      minor_safety_flags: flagged,
      evidence_appended,
      ...(memory_hits.length > 0
        ? {
            memory_hits,
            memory_hint:
              "Prior memory found for some of the artifacts you just recorded. Read `memory_hits` — incorporate confirmed connections/lessons and cite them as [MEMORY] in the final report. Do NOT re-investigate values already covered.",
          }
        : {}),
    };
  },
}),

export const record_artifact = tool({
  description:
    "Backwards-compatible shim. PREFER record_artifacts with an array. This wraps a single item into a one-element batch.",
  inputSchema: z.object({
    kind: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(100).optional(),
    source: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  execute: async ({ kind, value, confidence, source, metadata }) => {
    const inferred = inferKind(kind, value);
    const v = validateArtifact(inferred.kind, value);
    if (!v.ok) return { ok: false, rejected: true, reason: v.reason };
    const inMeta = (metadata ?? {}) as Record<string, unknown>;
    const cap = applyEvidenceCaps({
      rawConfidence: confidence ?? 50,
      sources: [source ?? "", ...((inMeta.sources as unknown[]) ?? [])].filter(Boolean) as string[],
    });
    const resolvedReasonNotConfirmed =
      (typeof inMeta.reason_not_confirmed === "string" ? inMeta.reason_not_confirmed : null) ??
      cap.reason_not_confirmed ?? null;
    const enrichedMeta = {
      ...(metadata ?? {}),
      ...(v.metaPatch ?? {}),
      ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
      source_category: cap.source_classes,
      query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: inMeta }),
      status: coerceCoherentStatus(
        deriveStatus({
          requested: typeof inMeta.status === "string" ? inMeta.status : null,
          reasonNotConfirmed: resolvedReasonNotConfirmed,
          sourceClasses: cap.source_classes,
          contradictions: Array.isArray(inMeta.contradictions) ? inMeta.contradictions : [],
          deadEnd: looksDeadEnd(inMeta),
        }),
        resolvedReasonNotConfirmed,
      ),
      cluster_id: inMeta.cluster_id ?? null,
      reason_for_confidence: cap.reason_for_confidence,
      reason_not_confirmed: resolvedReasonNotConfirmed,
      contradictions: inMeta.contradictions ?? [],
      next_verification_step: inMeta.next_verification_step ?? null,
      confidence_cap_applied: cap.cap,
    };
    const row = scrubArtifactRow({
      thread_id: threadId,
      user_id: userId,
      kind: v.kind,
      value: v.value,
      confidence: cap.confidence,
      source: source ?? null,
      metadata: enrichedMeta,
    });
    const { error } = await supabase.from("artifacts").insert([row]);
    if (error) return { ok: false, error: error.message };
    bumpArtifacts(1, [String(row.kind)]);
    const minor = (row.metadata as Record<string, unknown> | null)?.minor_warning === true;
    // Chain-of-custody append
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const conf = typeof row.confidence === "number" ? (row.confidence as number) : null;
    const declared = String(meta.classification ?? "").toLowerCase();
    const classification =
      declared === "hard" || declared === "soft"
        ? declared
        : (conf ?? 0) >= 85
        ? "hard"
        : "soft";
    const sourceUrl =
      meta.source_url || meta.url || meta.profile_url || meta.archived_url || null;
    await supabase.rpc("append_evidence", {
      _thread_id: threadId,
      _artifact_id: null,
      _tool_name: (row.source as string) ?? "agent",
      _source: (row.source as string) ?? null,
      _source_url: typeof sourceUrl === "string" ? sourceUrl : null,
      _classification: classification,
      _confidence: conf,
      _kind: String(row.kind),
      _value: String(row.value),
      _content_snapshot: JSON.stringify(meta).slice(0, 1500),
      _metadata: meta,
    }).then(() => {}, (e: unknown) => console.warn("[record_artifact] append_evidence:", e));
    return { ok: true, kind: row.kind, value: row.value, ...(minor ? { minor_safety_flag: true } : {}) };
  },
}),

export const record_evidence = tool({
  description:
    "Append one tamper-evident row to the investigation's chain-of-custody log. Use for high-stakes findings that need provenance (a Hard claim with an archived URL, a court/government record, a verified breach hit). Each call appends a hashed row whose chain_hash depends on the prior row — the UI can verify the whole chain. Classification: 'hard' = official record or first-party verified source. 'soft' = social/inferred/pattern-match.",
  inputSchema: z.object({
    classification: z.enum(["hard", "soft"]),
    kind: z.string().describe("artifact kind this evidence relates to (email/phone/ip/username/domain/breach/name/other)"),
    value: z.string(),
    source: z.string().describe("tool or human-readable provider name, e.g. 'hunter.io', 'archive.org', 'whois'"),
    source_url: z.string().url().optional().describe("Canonical or archived URL of the evidence — prefer archive.org / archive.is link"),
    confidence: z.number().min(0).max(100).optional(),
    notes: z.string().max(2000).optional().describe("Free-text collection notes / extraction context"),
    metadata: z.record(z.unknown()).optional(),
  }),
  execute: async ({ classification, kind, value, source, source_url, confidence, notes, metadata }) => {
    const meta = { ...(metadata ?? {}), ...(notes ? { notes } : {}) };
    const { data, error } = await supabase.rpc("append_evidence", {
      _thread_id: threadId,
      _artifact_id: null,
      _tool_name: source,
      _source: source,
      _source_url: source_url ?? null,
      _classification: classification,
      _confidence: confidence ?? null,
      _kind: kind,
      _value: value,
      _content_snapshot: JSON.stringify(meta).slice(0, 1500),
      _metadata: meta,
    });
    if (error) return { ok: false, error: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    let archived: unknown = undefined;
    if (archiveEnabled && source_url) {
      const arch = await archiveAttachment(supabase, threadId, userId, source_url);
      if (arch && row?.id) {
        await supabase
          .from("evidence_log")
          .update({
            archive_storage_path: arch.path,
            archive_sha256: arch.sha256,
            archive_bytes: arch.bytes,
            archive_content_type: arch.content_type,
          })
          .eq("id", row.id);
        archived = { sha256: arch.sha256, bytes: arch.bytes };
      }
    }
    return { ok: true, id: row?.id, seq: row?.seq, chain_hash: row?.chain_hash, ...(archived ? { archived } : {}) };
  },
}),

