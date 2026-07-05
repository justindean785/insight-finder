// dork-verify.ts — fetch document text and score dork hit relevance (#8 Phase 1).

import { fetchRetry } from "./fetch_retry.ts";
import { scoreDorkRelevance, type DorkRelevance } from "./dork-relevance.ts";

const UA = "Mozilla/5.0 (compatible; InsightFinder-OSINT/1.0)";

/** Fetch URL body text. PDFs are decoded as latin1 so embedded strings remain searchable. */
export async function fetchUrlText(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetchRetry(
      url,
      {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal,
      },
      { timeoutMs: 5000, retries: 1 },
    );
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    const isPdf = ct.includes("application/pdf") || /\.pdf(?:[?#]|$)/i.test(url);
    if (isPdf) {
      const buf = await r.arrayBuffer();
      return new TextDecoder("latin1").decode(buf);
    }
    return await r.text();
  } catch {
    return null;
  }
}

export interface DorkVerifyResult extends DorkRelevance {
  content_verified: boolean;
  textFetched: boolean;
}

/** Fetch a dork document hit and score its relevance to the subject. */
export async function verifyDorkDocumentHit(input: {
  url: string;
  seed: string;
  subjectName?: string;
  subjectCity?: string;
  signal?: AbortSignal;
}): Promise<DorkVerifyResult> {
  const text = await fetchUrlText(input.url, input.signal);
  const scored = scoreDorkRelevance({
    text,
    seed: input.seed,
    subjectName: input.subjectName,
    subjectCity: input.subjectCity,
    url: input.url,
    requireVerification: true,
  });
  return {
    ...scored,
    content_verified: text != null && scored.relevance > 0,
    textFetched: text != null,
  };
}
