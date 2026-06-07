/**
 * Outbound-URL safety classification, shared by the dashboard config-patch
 * validator and the embedder factory. Used to block SSRF (OWASP API7): a
 * write-capable request must not be able to point outbound HTTP calls
 * (embedder baseURL / host) at internal, loopback, or cloud-metadata
 * addresses, nor at non-http(s) schemes.
 *
 * Configured custom endpoints use a more conservative policy: unless the
 * caller has explicitly opted into operator-controlled internal hosts, allow
 * only explicit public IP literals. That avoids DNS-rebinding gaps for
 * SDK/fetch clients where this repo cannot pin a resolved IP through the
 * outbound connection. Provider-specific official DNS allowances live in their
 * provider-specific classifiers.
 */
export type OutboundUrlVerdict = "ok" | "invalid-scheme" | "internal";
export type ConfiguredOutboundUrlVerdict = OutboundUrlVerdict | "dns-hostname";
export type OpenAIBaseUrlVerdict = "ok" | "invalid-scheme" | "not-official";
export type OutboundHttpUrlRejectionReason = "invalid-scheme" | "userinfo" | "query-or-fragment";

interface Ipv4Cidr {
  base: number;
  prefix: number;
}

interface Ipv6Cidr {
  base: number[];
  prefix: number;
}

const GLOBAL_IPV4_EXCEPTIONS = [
  ipv4Cidr("192.0.0.9", 32),
  ipv4Cidr("192.0.0.10", 32),
];

const NON_GLOBAL_IPV4_RANGES = [
  ipv4Cidr("0.0.0.0", 8),
  ipv4Cidr("10.0.0.0", 8),
  ipv4Cidr("100.64.0.0", 10),
  ipv4Cidr("127.0.0.0", 8),
  ipv4Cidr("169.254.0.0", 16),
  ipv4Cidr("172.16.0.0", 12),
  ipv4Cidr("192.0.0.0", 24),
  ipv4Cidr("192.0.2.0", 24),
  ipv4Cidr("192.88.99.0", 24),
  ipv4Cidr("192.168.0.0", 16),
  ipv4Cidr("198.18.0.0", 15),
  ipv4Cidr("198.51.100.0", 24),
  ipv4Cidr("203.0.113.0", 24),
  ipv4Cidr("224.0.0.0", 4),
  ipv4Cidr("240.0.0.0", 4),
];

const GLOBAL_IPV6_EXCEPTIONS = [
  ipv6Cidr("2001:1::1", 128),
  ipv6Cidr("2001:1::2", 128),
  ipv6Cidr("2001:1::3", 128),
  ipv6Cidr("2001:3::", 32),
  ipv6Cidr("2001:4:112::", 48),
  ipv6Cidr("2001:20::", 28),
  ipv6Cidr("2001:30::", 28),
];

const GLOBAL_UNICAST_IPV6_RANGE = ipv6Cidr("2000::", 3);

const NON_GLOBAL_IPV6_RANGES = [
  ipv6Cidr("::", 128),
  ipv6Cidr("::1", 128),
  ipv6Cidr("::ffff:0:0", 96),
  ipv6Cidr("64:ff9b:1::", 48),
  ipv6Cidr("100::", 64),
  ipv6Cidr("100:0:0:1::", 64),
  ipv6Cidr("2001::", 23),
  ipv6Cidr("2001::", 32),
  ipv6Cidr("2001:2::", 48),
  ipv6Cidr("2001:db8::", 32),
  ipv6Cidr("2002::", 16),
  ipv6Cidr("3fff::", 20),
  ipv6Cidr("5f00::", 16),
  ipv6Cidr("fc00::", 7),
  ipv6Cidr("fe80::", 10),
  ipv6Cidr("fec0::", 10),
  ipv6Cidr("ff00::", 8),
];

const WELL_KNOWN_NAT64_PREFIX = ipv6Cidr("64:ff9b::", 96);
const RFC6052_NSP_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
const KNOWN_NON_HTTP_SCHEMES = new Set([
  "data",
  "file",
  "ftp",
  "ftps",
  "mailto",
  "ssh",
  "telnet",
  "ws",
  "wss",
]);

export function classifyOutboundUrl(raw: string): OutboundUrlVerdict {
  const parsed = parseOutboundHttpUrl(raw);
  if (!parsed) {
    return "invalid-scheme";
  }
  if (isInternalHost(parsed.hostname)) return "internal";
  return "ok";
}

export function classifyConfiguredOutboundUrl(raw: string): ConfiguredOutboundUrlVerdict {
  const parsed = parseOutboundHttpUrl(raw);
  if (!parsed) return "invalid-scheme";

  if (isInternalHost(parsed.hostname)) return "internal";

  const hostname = normalizeHostname(parsed.hostname);
  if (isIpLiteral(hostname)) return isPublicIpLiteral(hostname) ? "ok" : "internal";
  return "dns-hostname";
}

export function classifyOpenAIBaseUrl(raw: string): OpenAIBaseUrlVerdict {
  const parsed = parseExplicitHttpUrl(raw);
  if (!parsed) return "invalid-scheme";
  return parsed.protocol === "https:" &&
    normalizeHostname(parsed.hostname) === "api.openai.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    (parsed.pathname === "/v1" || parsed.pathname === "/v1/") &&
    parsed.search === "" &&
    parsed.hash === ""
    ? "ok"
    : "not-official";
}

export function normalizeOutboundHttpUrl(raw: string): string | null {
  const parsed = parseOutboundHttpUrl(raw);
  if (!parsed) return null;
  return parsed.href;
}

export function getOutboundHttpUrlRejectionReason(raw: string): OutboundHttpUrlRejectionReason | null {
  const result = inspectOutboundHttpUrl(raw);
  return result.ok ? null : result.reason;
}

function parseOutboundHttpUrl(raw: string): URL | null {
  const result = inspectOutboundHttpUrl(raw);
  return result.ok ? result.parsed : null;
}

function inspectOutboundHttpUrl(raw: string): { ok: true; parsed: URL } | { ok: false; reason: OutboundHttpUrlRejectionReason } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid-scheme" };

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const hasHttpScheme = scheme === "http" || scheme === "https";
    if (hasHttpScheme && !/^https?:\/\//i.test(trimmed)) return { ok: false, reason: "invalid-scheme" };
    if (!hasHttpScheme && !isBareAuthorityWithPort(trimmed, scheme)) return { ok: false, reason: "invalid-scheme" };
  }

  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "invalid-scheme" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, reason: "userinfo" };
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      return { ok: false, reason: "query-or-fragment" };
    }
    return { ok: true, parsed };
  } catch {
    return { ok: false, reason: "invalid-scheme" };
  }
}

function isBareAuthorityWithPort(raw: string, schemePrefix: string): boolean {
  if (KNOWN_NON_HTTP_SCHEMES.has(schemePrefix)) {
    return false;
  }
  const authority = raw.split(/[/?#]/, 1)[0]!;
  return /^[A-Za-z0-9.-]+:\d{1,5}$/.test(authority);
}

/**
 * True when the hostname is localhost or a non-global literal IP: loopback,
 * link-local, private, CGNAT, metadata, documentation, benchmarking,
 * multicast, deprecated site-local, reserved, or similar special-use space.
 */
export function isInternalHost(hostname: string): boolean {
  let host = normalizeHostname(hostname);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (host.includes(":")) {
    const words = parseIpv6Words(host);
    if (!words) return false;
    return !isGlobalIpv6(words);
  }

  return isIpv4Literal(host) ? !isGlobalIpv4(host) : false;
}

export function isPublicIpLiteral(hostname: string): boolean {
  let host = normalizeHostname(hostname);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIpv4Literal(host)) return isGlobalIpv4(host);
  const words = parseIpv6Words(host);
  if (!words) return false;
  return isGlobalIpv6(words);
}

function parseExplicitHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isIpLiteral(hostname: string): boolean {
  let host = normalizeHostname(hostname);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return isIpv4Literal(host) || parseIpv6Words(host) !== null;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  while (host.endsWith(".") && host.length > 1) {
    host = host.slice(0, -1);
  }
  return host;
}

function isGlobalIpv4(host: string): boolean {
  const value = parseIpv4Number(host);
  if (value === null) return false;
  if (GLOBAL_IPV4_EXCEPTIONS.some((range) => ipv4InCidr(value, range))) return true;
  return !NON_GLOBAL_IPV4_RANGES.some((range) => ipv4InCidr(value, range));
}

function isIpv4Literal(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(match && match.slice(1, 5).every((value) => Number(value) <= 255));
}

function isGlobalIpv6(words: number[]): boolean {
  if (GLOBAL_IPV6_EXCEPTIONS.some((range) => ipv6InCidr(words, range))) return true;
  if (NON_GLOBAL_IPV6_RANGES.some((range) => ipv6InCidr(words, range))) return false;

  const nat64Mapped = ipv4FromWellKnownNat64Ipv6(words);
  if (nat64Mapped) return isGlobalIpv4(nat64Mapped);
  if (!ipv6InCidr(words, GLOBAL_UNICAST_IPV6_RANGE)) return false;

  const rfc6052Mapped = ipv4FromRfc6052Ipv6(words);
  if (rfc6052Mapped) return isGlobalIpv4(rfc6052Mapped);
  return true;
}

function parseIpv6Words(input: string): number[] | null {
  let host = input.toLowerCase();
  const zoneIndex = host.indexOf("%");
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);

  const lastColon = host.lastIndexOf(":");
  if (lastColon >= 0 && host.includes(".")) {
    const ipv4 = host.slice(lastColon + 1);
    if (!isIpv4Literal(ipv4)) return null;
    const octets = ipv4.split(".").map((value) => Number(value));
    host = `${host.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = parseIpv6Side(doubleColonParts[0]!);
  const right = doubleColonParts.length === 2 ? parseIpv6Side(doubleColonParts[1]!) : [];
  if (!left || !right) return null;

  if (doubleColonParts.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroFill = 8 - left.length - right.length;
  if (zeroFill < 1) return null;
  return [...left, ...Array.from({ length: zeroFill }, () => 0), ...right];
}

function parseIpv6Side(value: string): number[] | null {
  if (value.length === 0) return [];
  const words: number[] = [];
  for (const part of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function ipv4Cidr(base: string, prefix: number): Ipv4Cidr {
  const parsed = parseIpv4Number(base);
  if (parsed === null) throw new Error(`invalid IPv4 CIDR base: ${base}`);
  return { base: parsed, prefix };
}

function parseIpv4Number(host: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1, 5).map((value) => Number(value));
  if (octets.some((value) => value > 255)) return null;
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256) + octets[3]!;
}

function ipv4InCidr(value: number, range: Ipv4Cidr): boolean {
  const size = 2 ** (32 - range.prefix);
  return Math.floor(value / size) === Math.floor(range.base / size);
}

function ipv6Cidr(base: string, prefix: number): Ipv6Cidr {
  const words = parseIpv6Words(base);
  if (!words) throw new Error(`invalid IPv6 CIDR base: ${base}`);
  return { base: words, prefix };
}

function ipv6InCidr(words: number[], range: Ipv6Cidr): boolean {
  const fullWords = Math.floor(range.prefix / 16);
  const remainingBits = range.prefix % 16;
  for (let index = 0; index < fullWords; index += 1) {
    if (words[index] !== range.base[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (words[fullWords]! & mask) === (range.base[fullWords]! & mask);
}

function ipv4FromRfc6052Ipv6(words: number[]): string | null {
  if (words.length !== 8) return null;
  const bytes = ipv6WordsToBytes(words);

  for (const prefixLength of RFC6052_NSP_PREFIX_LENGTHS) {
    const embedded = extractRfc6052Ipv4(bytes, prefixLength);
    if (embedded) return embedded;
  }

  return null;
}

function ipv4FromWellKnownNat64Ipv6(words: number[]): string | null {
  if (words.length !== 8 || !ipv6InCidr(words, WELL_KNOWN_NAT64_PREFIX)) return null;
  return ipv6WordsToBytes(words).slice(12, 16).join(".");
}

function ipv6WordsToBytes(words: number[]): number[] {
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function extractRfc6052Ipv4(bytes: number[], prefixLength: number): string | null {
  const bits: number[] = [];
  let position = prefixLength;

  while (bits.length < 32) {
    if (position === 64) {
      if (bytes[8] !== 0) return null;
      position = 72;
      continue;
    }
    if (position >= 128) return null;
    bits.push(readBit(bytes, position));
    position += 1;
  }

  if (prefixLength <= 64 && bytes[8] !== 0) return null;
  if (position === 64) position = 72;
  for (let suffixPosition = position; suffixPosition < 128; suffixPosition += 1) {
    if (readBit(bytes, suffixPosition) !== 0) return null;
  }

  if (bits.every((bit) => bit === 0)) return null;

  return [
    bitsToByte(bits, 0),
    bitsToByte(bits, 8),
    bitsToByte(bits, 16),
    bitsToByte(bits, 24),
  ].join(".");
}

function readBit(bytes: number[], position: number): number {
  return (bytes[Math.floor(position / 8)]! >> (7 - (position % 8))) & 1;
}

function bitsToByte(bits: number[], offset: number): number {
  let value = 0;
  for (let index = offset; index < offset + 8; index += 1) {
    value = (value << 1) | bits[index]!;
  }
  return value;
}
