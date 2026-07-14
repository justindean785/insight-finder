export interface NormalizedArtifactValue {
  displayValue: string;
  normalizedValue: string;
}

export function normalizeArtifactValue(kind: string, value: string): NormalizedArtifactValue | null {
  const displayValue = value;
  const workingValue = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!workingValue) return null;

  const k = kind.trim().toLowerCase();

  if (k === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workingValue)) return null;
    return { displayValue, normalizedValue: workingValue.toLowerCase() };
  }

  if (k === "username") {
    if (workingValue.startsWith("@@")) return null;
    const normalizedValue = workingValue.replace(/^@/, "").toLowerCase();
    return normalizedValue ? { displayValue, normalizedValue } : null;
  }

  if (k === "phone") return normalizeE164(workingValue, displayValue);
  if (k === "domain" || k === "subdomain") return normalizeDomain(workingValue, displayValue);
  if (k === "ip") return normalizeIp(workingValue, displayValue);
  if (k === "social_profile" || k === "url") return normalizeUrl(workingValue, displayValue);
  if (k === "hash" || k === "crypto_wallet") return normalizeHashOrWallet(k, workingValue, displayValue);

  return { displayValue, normalizedValue: workingValue.toLocaleLowerCase("en-US") };
}

function normalizeE164(value: string, displayValue: string): NormalizedArtifactValue | null {
  if (!value.startsWith("+")) return null;
  const digits = value.slice(1).replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return { displayValue, normalizedValue: `+${digits}` };
}

function normalizeDomain(value: string, displayValue: string): NormalizedArtifactValue | null {
  const raw = value.replace(/\.$/, "").toLowerCase();
  try {
    const hostname = new URL(`http://${raw}`).hostname.replace(/\.$/, "");
    return hostname ? { displayValue, normalizedValue: hostname } : null;
  } catch {
    return null;
  }
}

function normalizeUrl(value: string, displayValue: string): NormalizedArtifactValue | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    return { displayValue, normalizedValue: url.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

function normalizeIp(value: string, displayValue: string): NormalizedArtifactValue | null {
  const ipv4 = normalizeIpv4(value);
  if (ipv4) return { displayValue, normalizedValue: ipv4 };
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, "");
    return hostname ? { displayValue, normalizedValue: hostname.toLowerCase() } : null;
  } catch {
    return null;
  }
}

function normalizeIpv4(value: string): string | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split(".");
  if (octets.some((octet) => (octet.length > 1 && octet.startsWith("0")) || Number(octet) > 255)) return null;
  return octets.map(Number).join(".");
}

function normalizeHashOrWallet(kind: string, value: string, displayValue: string): NormalizedArtifactValue {
  const normalizedValue =
    /^0x[0-9a-f]+$/i.test(value) || (kind === "hash" && /^[0-9a-f]+$/i.test(value))
      ? value.toLowerCase()
      : value;
  return { displayValue, normalizedValue };
}
