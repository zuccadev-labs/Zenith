/**
 * @module @zenith/core/net
 *
 * Direcciones IP: análisis de IPv4/IPv6 y CIDR, pertenencia a listas y si una dirección es pública.
 * Lo comparten la política de API keys (`security/api-keys/policy.ts`) y la protección SSRF de las
 * peticiones salientes (`security/outbound-http.ts`).
 */

type Parsed = { v: 4 | 6; bits: bigint };

function parseIPv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p.startsWith("0"))) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseIPv6(input: string): bigint | null {
  let s = input;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split("::").length > 2) return null;
  // An embedded IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const tail: number[] = [];
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(cut + 1));
    if (v4 === null) return null;
    tail.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    s = s.slice(0, cut + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const compressed = s.includes("::");
  const [head, rest = ""] = compressed ? s.split("::") : [s];
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const h = groups(head), r = groups(rest);
  if ([...h, ...r].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const known = h.length + r.length + tail.length;
  if (compressed ? known > 7 : known !== 8) return null;
  const all = [
    ...h.map((g) => parseInt(g, 16)),
    ...Array<number>(8 - known).fill(0),
    ...r.map((g) => parseInt(g, 16)),
    ...tail,
  ];
  return all.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}

/** An address as a number; IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4. */
export function parseIp(s: string): Parsed | null {
  const v4 = parseIPv4(s);
  if (v4 !== null) return { v: 4, bits: v4 };
  const v6 = parseIPv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, bits: v6 & 0xffffffffn };
  return { v: 6, bits: v6 };
}

/** `203.0.113.7`, `198.51.100.0/24`, `2001:db8::/32`… → network and prefix length; null if invalid. */
export function parseCidr(entry: string): { v: 4 | 6; network: bigint; prefix: number } | null {
  const [addr, len, extra] = entry.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const prefix = len === undefined ? width : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return { v: ip.v, network: ip.bits & mask, prefix };
}

/** Whether `ip` falls in any entry of `allowlist`. An unparseable `ip` never matches. */
export function ipAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  const parsed = ip ? parseIp(ip) : null;
  if (!parsed) return false;
  for (const entry of allowlist) {
    const net = parseCidr(entry);
    if (!net || net.v !== parsed.v) continue;
    const width = net.v === 4 ? 32 : 128;
    const mask = net.prefix === 0
      ? 0n
      : ((1n << BigInt(net.prefix)) - 1n) << BigInt(width - net.prefix);
    if ((parsed.bits & mask) === net.network) return true;
  }
  return false;
}

/**
 * Rangos que no son Internet pública (IANA IPv4/IPv6 Special-Purpose Address Registries): una
 * petición saliente nunca debe llegar a ellos (SSRF, OWASP API7:2023). Incluye los metadatos de nube
 * (169.254.169.254, fd00:ec2::254) por estar en link-local y ULA.
 */
export const NON_PUBLIC_RANGES: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

/** Si `ip` es una dirección de Internet pública. Una dirección inválida no lo es. */
export function isPublicAddress(ip: string): boolean {
  return parseIp(ip) !== null && !ipAllowed(ip, NON_PUBLIC_RANGES);
}
