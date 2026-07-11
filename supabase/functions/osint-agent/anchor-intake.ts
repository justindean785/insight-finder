// anchor-intake.ts — READ the seed's primary profile + SERP BEFORE the breadth sweep.
//
// The failure this fixes (live @pjsmakka run): the orchestrator CONSTRUCTED the
// subject's Instagram URL from a web-search summary and recorded it as INFERRED —
// it never FETCHED and READ the anchor profile or the search-engine results page.
// A one-line Google search returns the identity, bio, and account network in the
// AI Overview instantly; the autonomous lane surfaced NONE of it and instead burned
// the run on a ~95-platform dev/technical handle-existence sweep (codeforces,
// hackthebox, hackerrank, anilist, slideshare, 500px…).
//
// This module mirrors attachment-intake.ts: it runs deterministically at intake,
// BEFORE the streamText loop, when the seed resolves to a profile/handle. It:
//   1. FETCHES + READS the primary social profile (SocialFetch structured lookup —
//      a DIRECT_PROFILE source, so the anchor records as a READ, never INFERRED),
//      parsing bio, display name, follower/following counts, and external links;
//   2. READS the search-engine results page (Perplexity Sonar — the same provider
//      minimax_web_search uses) for the handle and, once known, the display name,
//      mining the synthesized answer + citations for related/associated accounts and
//      an identity summary (the knowledge-panel / AI-overview equivalent);
//   3. records what it READ as lead-tier artifacts with real source attribution and
//      chain-of-custody-friendly provenance (read_from_profile / read_from_serp);
//   4. returns a summary the caller injects into the system prompt so the model
//      reasons over the anchor identity FIRST, and does not lead with the noise sweep.
//
// Best-effort: every failure is swallowed (it never blocks the investigation), and
// co-appearing accounts are recorded as RELATED entities (relationship_to_subject),
// never promoted to co-equal subjects and never discarded as noise.

import type { UIMessage } from "npm:ai@6";
import { fetchRetry } from "./env.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { scrubArtifactRows } from "./safety.ts";
import {
  type AnchorSeed,
  extractProfileEntities,
  parseSerpEntities,
  seedToHandle,
  foldHandle,
} from "./anchor-parse.ts";

export type { AnchorSeed } from "./anchor-parse.ts";

// Read keys at call time (not import-time consts) so enablement is decoupled from
// module-load order and tests can control them — mirrors attachment-intake.ts.
const socialfetchKey = (): string | undefined => Deno.env.get("SOCIALFETCH_API_KEY");
const perplexityKey = (): string | undefined => Deno.env.get("PERPLEXITY_API_KEY");

// Structured social platforms SocialFetch can read as a profile. Instagram is the
// primary target for this app's subjects; the SERP read covers everything else.
const PROFILE_READ_PLATFORM = "instagram";

export interface AnchorIntakeResult {
  ran: boolean;
  profile_read: boolean;
  serp_read: boolean;
  artifacts_inserted: number;
  /** Summary to inject into the system prompt. */
  summary: string;
}

interface IntakeDeps {
  // Structural PromiseLike shape (matches attachment-intake.ts) so the real
  // SupabaseClient — whose .insert() returns a thenable, not a plain Promise — fits.
  supabase: { from: (t: string) => { insert: (rows: unknown[]) => PromiseLike<{ error: { message?: string } | null }> } };
  userId: string;
  threadId: string;
  bumpArtifacts?: (n: number, kinds: string[]) => void;
}

const empty: AnchorIntakeResult = { ran: false, profile_read: false, serp_read: false, artifacts_inserted: 0, summary: "" };

// ---- Network reads -----------------------------------------------------------

async function readProfile(handle: string): Promise<Record<string, unknown> | null> {
  const key = socialfetchKey();
  if (!key) return null;
  try {
    const url = `https://api.socialfetch.dev/v1/${PROFILE_READ_PLATFORM}/profiles/${encodeURIComponent(handle)}`;
    const r = await fetchRetry(url, { headers: { "x-api-key": key } }, { retries: 1, timeoutMs: 15_000 });
    if (!r.ok && r.status !== 404) return null;
    const text = await r.text();
    let env: { data?: Record<string, unknown> | null };
    try { env = JSON.parse(text) as typeof env; } catch { return null; }
    const payload = (env?.data ?? null) as Record<string, unknown> | null;
    if (!payload) return null;
    const ls = typeof payload.lookupStatus === "string" ? payload.lookupStatus : null;
    // "private" still yields bio/followers/displayName — keep it. "not_found" is a
    // real negative (the handle isn't on this platform); return null so we don't
    // record a phantom profile.
    if (ls === "not_found") return null;
    return payload;
  } catch (e) {
    console.warn("[anchor-intake] profile read failed:", (e as Error).message);
    return null;
  }
}

async function readSerp(query: string, focus: string): Promise<{ answer: string; citations: string[] } | null> {
  const key = perplexityKey();
  if (!key) return null;
  try {
    const r = await fetchRetry("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are an OSINT web-search worker. Return a concise factual answer in bullet points. Identify the person/creator behind the handle: their display name, what they are known for, their bio, follower counts, external links, and any RELATED or associated accounts that appear alongside them. Prefer specific names, @handles, URLs, and identifiers. If nothing relevant is found, say so explicitly.",
          },
          { role: "user", content: `Focus: ${focus}\n\nQuery: ${query}` },
        ],
        max_tokens: 1200,
      }),
    }, { retries: 1, timeoutMs: 20_000 });
    if (!r.ok) return null;
    const data = await r.json() as {
      choices?: { message?: { content?: string } }[];
      citations?: string[];
      search_results?: { url?: string }[];
    };
    const answer = (data.choices?.[0]?.message?.content ?? "").trim();
    const citations = (data.citations ?? data.search_results?.map((s) => s.url ?? "").filter(Boolean) ?? [])
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
      .slice(0, 25);
    if (!answer && citations.length === 0) return null;
    return { answer, citations };
  } catch (e) {
    console.warn("[anchor-intake] serp read failed:", (e as Error).message);
    return null;
  }
}

// ---- Row builders ------------------------------------------------------------

function mkRow(
  deps: IntakeDeps,
  input: { kind: string; value: string; source: string; rawConfidence: number; metadata: Record<string, unknown> },
): Record<string, unknown> {
  const built = buildAutoRecordedRow(input);
  return { thread_id: deps.threadId, user_id: deps.userId, ...built };
}

/**
 * Read the seed's anchor profile + SERP before reasoning and record what was READ.
 * Never throws. Runs only for handle/profile-shaped seeds (username, social url).
 */
export async function runAnchorIntake(
  seed: AnchorSeed,
  deps: IntakeDeps,
  messages?: UIMessage[],
): Promise<AnchorIntakeResult> {
  try {
    const handle = seedToHandle(seed);
    const isPerson = seed.kind === "person" || seed.kind === "name";
    if (!handle && !isPerson) return empty;
    // `messages` is accepted for parity with runAttachmentIntake and future use
    // (e.g. honoring an inline handle correction); the anchor read keys off the
    // classified seed, so it is not consumed here.
    void messages;

    const rows: Array<Record<string, unknown>> = [];
    const summaryParts: string[] = [];
    let profileRead = false;
    let serpRead = false;

    // --- 1. Primary profile READ (handle seeds) --------------------------------
    let displayName: string | null = null;
    if (handle) {
      const payload = await readProfile(handle);
      if (payload) {
        const ent = extractProfileEntities(payload);
        displayName = ent.displayName;
        profileRead = true;
        const igUrl = `https://www.instagram.com/${handle}/`;
        // The anchor profile, recorded as a READ via a DIRECT_PROFILE source
        // (socialfetch_lookup) — never INFERRED. Carries the content we read.
        rows.push(mkRow(deps, {
          kind: "username",
          value: igUrl,
          source: "socialfetch_lookup",
          rawConfidence: 50,
          metadata: {
            platform: "instagram",
            handle,
            provenance: "read_from_profile",
            read: true,
            read_by: "socialfetch_lookup",
            source_url: igUrl,
            anchor: true,
            display_name: ent.displayName ?? undefined,
            bio: ent.bio ?? undefined,
            followers: ent.followers ?? undefined,
            following: ent.following ?? undefined,
            verified: ent.verified || undefined,
            external_links: ent.externalLinks.length ? ent.externalLinks : undefined,
          },
        }));
        // The profile's OWN display name (not a bio cross-link) — a lead identity.
        if (ent.displayName) {
          rows.push(mkRow(deps, {
            kind: "name",
            value: ent.displayName,
            source: "socialfetch_lookup",
            rawConfidence: 45,
            metadata: {
              platform: "instagram",
              provenance: "read_from_profile",
              read: true,
              display_name_of: handle,
              source_url: igUrl,
            },
          }));
        }
        // External links from the bio → domain/url leads.
        for (const link of ent.externalLinks.slice(0, 6)) {
          rows.push(mkRow(deps, {
            kind: "url",
            value: link,
            source: "socialfetch_lookup",
            rawConfidence: 40,
            metadata: { provenance: "read_from_profile", read: true, source_profile: handle, source_url: igUrl },
          }));
        }
        // Accounts @mentioned in the bio → RELATED entities, never subjects.
        for (const rel of ent.relatedHandles.slice(0, 10)) {
          rows.push(mkRow(deps, {
            kind: "username",
            value: rel,
            source: "socialfetch_lookup",
            rawConfidence: 30,
            metadata: {
              provenance: "read_from_profile",
              read: true,
              relationship_to_subject: "mentioned_in_seed_bio",
              related_entity: true,
              source_profile: handle,
              source_url: igUrl,
            },
          }));
        }
        summaryParts.push(
          `PRIMARY PROFILE READ (instagram/@${handle}${ent.verified ? " ✓" : ""}): ` +
          `display name "${ent.displayName ?? "?"}"; ` +
          `${ent.followers ?? "?"} followers / ${ent.following ?? "?"} following; ` +
          `bio: ${ent.bio ? `"${ent.bio.slice(0, 240)}"` : "none"}; ` +
          `external links: ${ent.externalLinks.join(", ") || "none"}; ` +
          `bio-mentioned accounts (RELATED, not the subject): ${ent.relatedHandles.join(", ") || "none"}.`,
        );
      }
    }

    // --- 2. SERP READ (handle first, then name+context if known) ---------------
    const serpQueries: Array<{ q: string; focus: string }> = [];
    if (handle) serpQueries.push({ q: `"${handle}" instagram social media profile identity`, focus: "identify the creator behind this handle and their related accounts" });
    if (displayName && handle) serpQueries.push({ q: `"${displayName}" "${handle}"`, focus: "corroborate the identity and find associated accounts / links" });
    if (!handle && isPerson) serpQueries.push({ q: `"${seed.raw}" social media profile`, focus: "identify this person and their public profiles" });

    const seedHandleForSerp = handle ?? foldHandle(seed.raw);
    for (const { q, focus } of serpQueries.slice(0, 2)) {
      const serp = await readSerp(q, focus);
      if (!serp) continue;
      serpRead = true;
      const ent = parseSerpEntities(serp.answer, serp.citations, seedHandleForSerp);
      // The identity summary the SERP READ (the AI-overview / knowledge-panel text).
      if (serp.answer) {
        rows.push(mkRow(deps, {
          kind: "weak_lead",
          value: `SERP identity summary for ${handle ? `@${handle}` : seed.raw}`,
          source: "minimax_web_search",
          rawConfidence: 45,
          metadata: {
            provenance: "read_from_serp",
            read: true,
            read_by: "minimax_web_search",
            identity_summary: serp.answer.slice(0, 1500),
            query: q,
            anchor: true,
          },
        }));
      }
      // The seed's OWN profile URL, corroborated by the SERP (second source class).
      if (ent.seedProfileUrl) {
        rows.push(mkRow(deps, {
          kind: "username",
          value: ent.seedProfileUrl,
          source: "minimax_web_search",
          rawConfidence: 45,
          metadata: { platform: "instagram", handle: seedHandleForSerp, provenance: "read_from_serp", read: true, source_url: ent.seedProfileUrl, anchor: true },
        }));
      }
      // Related/associated accounts co-appearing with the seed in the SERP →
      // RELATED entities with a relationship, never co-equal subjects, never noise.
      for (const rel of ent.relatedHandles.slice(0, 12)) {
        rows.push(mkRow(deps, {
          kind: "username",
          value: rel,
          source: "minimax_web_search",
          rawConfidence: 30,
          metadata: {
            provenance: "read_from_serp",
            read: true,
            relationship_to_subject: "co_appears_in_serp_with_seed",
            related_entity: true,
            source_seed: seedHandleForSerp,
          },
        }));
      }
      for (const link of ent.externalLinks.slice(0, 8)) {
        rows.push(mkRow(deps, {
          kind: "url",
          value: link,
          source: "minimax_web_search",
          rawConfidence: 30,
          metadata: { provenance: "read_from_serp", read: true, source_seed: seedHandleForSerp },
        }));
      }
      summaryParts.push(
        `SERP READ ("${q}"): ${serp.answer ? serp.answer.slice(0, 400) : "no answer"}` +
        (ent.relatedHandles.length ? ` | related accounts: ${ent.relatedHandles.slice(0, 12).join(", ")}` : ""),
      );
    }

    if (rows.length === 0) return { ...empty, ran: profileRead || serpRead, profile_read: profileRead, serp_read: serpRead };

    const safeRows = scrubArtifactRows(rows);
    let inserted = 0;
    const { error } = await deps.supabase.from("artifacts").insert(safeRows);
    if (!error) {
      inserted = safeRows.length;
      deps.bumpArtifacts?.(safeRows.length, safeRows.map((r) => String((r as { kind?: unknown }).kind)));
    } else {
      console.warn("[anchor-intake] insert failed:", error.message);
    }

    const summary =
      `\n\n## Anchor read (READ before the sweep)\n` +
      `The seed's primary profile and the search-engine results page were FETCHED and READ before reasoning; ` +
      `the identity below is established evidence, recorded with real source attribution (not inferred from a constructed URL). ` +
      `Corroborate and pivot on THIS first. Do NOT open the run with a broad dev/technical-platform handle-existence sweep ` +
      `(codeforces/hackthebox/hackerrank/anilist/slideshare/500px…) — those are low-value for a content-creator subject and ` +
      `must not outrank the anchor identity or be promoted above a weak lead without a content read confirming the same person.\n- ` +
      summaryParts.join("\n- ");

    return { ran: true, profile_read: profileRead, serp_read: serpRead, artifacts_inserted: inserted, summary };
  } catch (e) {
    console.warn("[anchor-intake] error:", (e as Error).message);
    return empty;
  }
}
