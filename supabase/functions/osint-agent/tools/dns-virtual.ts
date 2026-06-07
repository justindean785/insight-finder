/**
 * dns-virtual.ts — pure, runtime-agnostic DNS virtual-type logic.
 *
 * Shared between the Deno `dns_records` tool (infrastructure.ts) and the Vitest
 * suite (src/test/dns-virtual.test.ts). MUST stay free of `npm:`/`Deno.`/`node:`
 * imports so both runtimes can load it.
 *
 * Background: the agent kept passing "SPF" to the DNS tool, but SPF (RR type 99)
 * was deprecated by RFC 7208 — there is no SPF record type, only TXT records
 * starting with `v=spf1`. The old enum rejected "SPF" and crashed the tool call.
 * Virtual types map agent-friendly aliases onto real TXT queries with a host
 * mutation and a content-prefix filter.
 */

/** Real DNS resource record types per IANA. */
export const REAL_DNS_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA"] as const;
export type RealDnsType = (typeof REAL_DNS_TYPES)[number];

/** Virtual record types — aliases that internally resolve to TXT queries. */
export const VIRTUAL_DNS_TYPES = ["SPF", "DKIM", "DMARC", "BIMI"] as const;
export type VirtualDnsType = (typeof VIRTUAL_DNS_TYPES)[number];

export const DNS_TYPES = [...REAL_DNS_TYPES, ...VIRTUAL_DNS_TYPES] as const;
export type DnsType = (typeof DNS_TYPES)[number];

/**
 * How virtual types map to real queries.
 * - `hostPrefix` mutates the queried host (DMARC lives at _dmarc.<host>)
 * - `txtPrefix` is the case-insensitive substring filter applied to TXT results
 */
export const VIRTUAL_TYPE_MAP: Record<
  VirtualDnsType,
  { realType: "TXT"; hostPrefix?: string; txtPrefix: string }
> = {
  SPF: { realType: "TXT", txtPrefix: "v=spf1" },
  DKIM: { realType: "TXT", txtPrefix: "v=DKIM1" }, // host needs a selector — see resolveVirtualHost
  DMARC: { realType: "TXT", hostPrefix: "_dmarc", txtPrefix: "v=DMARC1" },
  BIMI: { realType: "TXT", hostPrefix: "default._bimi", txtPrefix: "v=BIMI1" },
};

export function isVirtualType(t: DnsType): t is VirtualDnsType {
  return (VIRTUAL_DNS_TYPES as readonly string[]).includes(t as string);
}

/**
 * Mutate the queried host for a virtual type.
 * DKIM requires a selector → `<selector>._domainkey.<host>`; throws without one.
 */
export function resolveVirtualHost(t: VirtualDnsType, host: string, dkimSelector?: string): string {
  if (t === "DKIM") {
    if (!dkimSelector) throw new Error("dkimSelector is required when types includes 'DKIM'");
    return `${dkimSelector}._domainkey.${host}`;
  }
  const { hostPrefix } = VIRTUAL_TYPE_MAP[t];
  return hostPrefix ? `${hostPrefix}.${host}` : host;
}

/**
 * Normalize DoH TXT answers (strip surrounding quotes, join split chunks) and
 * keep only records whose content starts with the virtual type's prefix.
 */
export function filterTxtByPrefix(records: string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  return records
    .map((r) => r.replace(/^"|"$/g, "").replace(/"\s*"/g, ""))
    .filter((r) => r.toLowerCase().startsWith(p));
}
