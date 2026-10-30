import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { PolicyError } from "@career-agent/domain";

export interface UrlPolicy {
  /** Allowed hostnames. "example.com" matches exactly; ".example.com" matches subdomains only. Empty = any public host. */
  allowedHosts?: readonly string[];
  /** Allow private/loopback destinations (local fixture servers in tests only). */
  allowPrivateNetwork?: boolean;
  /** Allow plain http (only meaningful together with allowPrivateNetwork for local fixtures). */
  allowHttp?: boolean;
  allowedPorts?: readonly number[];
}

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv6");
}

const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
  ".corp",
];

export function isPublicIp(address: string): boolean {
  let addr = address.replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped?.[1]) addr = mapped[1];
  const family = isIP(addr);
  if (family === 0) return false;
  return !NON_PUBLIC.check(addr, family === 4 ? "ipv4" : "ipv6");
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    return rule.startsWith(".") ? host.endsWith(rule) && host.length > rule.length : host === rule;
  });
}

/** Synchronous structural check. Throws PolicyError; returns the parsed URL. */
export function checkUrl(raw: string | URL, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PolicyError("Invalid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp)) {
    throw new PolicyError(`URL scheme ${url.protocol} is not allowed.`);
  }
  if (url.username || url.password)
    throw new PolicyError("URLs with embedded credentials are not allowed.");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const ports = policy.allowedPorts ?? [443, 80];
  if (!ports.includes(port)) throw new PolicyError(`Port ${port} is not allowed.`);

  if (!policy.allowPrivateNetwork) {
    if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 && !isPublicIp(host)) {
      throw new PolicyError("Destination address is not public.");
    }
    if (
      host === "localhost" ||
      !host.includes(".") ||
      PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))
    ) {
      throw new PolicyError("Destination host is not public.");
    }
  }
  if (
    policy.allowedHosts &&
    policy.allowedHosts.length > 0 &&
    !hostAllowed(host, policy.allowedHosts)
  ) {
    throw new PolicyError(`Host ${host} is not on the allowlist.`);
  }
  return url;
}

export type LookupAll = (host: string) => Promise<readonly { address: string }[]>;

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, order: "verbatim" });

/**
 * Structural check plus DNS resolution: every resolved address must be public (SSRF / DNS-rebinding defence).
 * Callers must re-run this for every redirect hop and connect to the vetted address.
 */
export async function assertSafeDestination(
  raw: string | URL,
  policy: UrlPolicy = {},
  lookup: LookupAll = defaultLookup,
): Promise<{ url: URL; addresses: string[] }> {
  const url = checkUrl(raw, policy);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return { url, addresses: [host] };
  const results = await lookup(host);
  const addresses = results.map((r) => r.address);
  if (addresses.length === 0) throw new PolicyError("Host did not resolve.");
  if (!policy.allowPrivateNetwork && addresses.some((a) => !isPublicIp(a))) {
    throw new PolicyError("Host resolves to a non-public address.");
  }
  return { url, addresses };
}

/** Same-origin check used for browser navigation and redirect policies. */
export function sameOrigin(a: string | URL, b: string | URL): boolean {
  return new URL(a).origin === new URL(b).origin;
}
