/**
 * Job-listing URL checks. QualiTrail's server never fetches the URL itself: TinyFish does, from its own network.
 * These checks are a first line that keeps obviously non-public targets from ever being sent to the provider,
 * and a last line that rejects a RESULT whose final URL is not a public web address.
 *
 * Boundary (documented in the handoff): rejecting a final_url only discards the result; it cannot stop a redirect
 * that already happened at the provider. TinyFish documents that it rejects private IPs, localhost and cloud
 * metadata endpoints both for submitted URLs (`invalid_url`) and for redirect targets (`invalid_redirect_url`).
 */
import { isIP } from "node:net";

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".onion", ".arpa"];

function v4ToNumber(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}
const inV4 = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((v4ToNumber(ip) & mask) >>> 0) === ((v4ToNumber(base) & mask) >>> 0);
};
const V4_PRIVATE = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
];

/** Expand an IPv6 address to 8 groups of 16 bits. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  // Embedded IPv4 tail (e.g. ::ffff:10.0.0.1).
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4ToNumber(tail[1]);
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - r.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...r];
  if (all.length !== 8) return null;
  const nums = all.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  if (kind === 4) return !V4_PRIVATE.some((c) => inV4(ip, c));
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped / translated / compatible: judge the embedded IPv4.
  if ((g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPublicAddress(v4);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 can embed private IPv4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return (g[0] & 0xe000) === 0x2000; // 2000::/3 global unicast
}

/** Syntax-only checks; no network. */
export function checkUrlSyntax(raw: string): UrlCheck {
  const input = raw.trim();
  if (input.length > 2048) return { ok: false, reason: "That link is too long." };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "That doesn't look like a web link. It should start with https://" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Only http and https links can be imported." };
  if (u.username || u.password) return { ok: false, reason: "Links that contain a username or password can't be imported." };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, reason: "Links to unusual ports can't be imported." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!isPublicAddress(literal)) return { ok: false, reason: "That address is not a public website." };
  } else {
    if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return { ok: false, reason: "That address is not a public website." };
    }
    if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: "That address is not a public website." };
  }
  u.hash = "";
  return { ok: true, url: u.toString(), host };
}

export type Resolver = (host: string) => Promise<string[]>;

/** Syntax plus DNS: every address the name resolves to (IPv4 and IPv6) must be public. */
export async function checkPublicUrl(raw: string, resolve: Resolver): Promise<UrlCheck> {
  const s = checkUrlSyntax(raw);
  if (!s.ok) return s;
  const literal = s.host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return s;
  let addrs: string[];
  try {
    addrs = await resolve(s.host);
  } catch {
    return { ok: false, reason: "That website's address couldn't be found. Check the link." };
  }
  if (addrs.length === 0) return { ok: false, reason: "That website's address couldn't be found. Check the link." };
  if (!addrs.every(isPublicAddress)) return { ok: false, reason: "That address is not a public website." };
  return s;
}

/** Real resolver: all A and AAAA records. */
export const systemResolver: Resolver = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};
