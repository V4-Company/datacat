import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

// Outbound webhook delivery. By default, destinations on loopback, private, link-local (including cloud metadata
// endpoints) and other non-public addresses are refused, both for IP literals and for every address a hostname
// resolves to at connect time (so DNS rebinding cannot slip through). Redirects are not followed.
// DATACAT_ALLOW_PRIVATE_WEBHOOKS=true allows internal destinations, for receivers on your own network.
const allowPrivate = String(process.env.DATACAT_ALLOW_PRIVATE_WEBHOOKS ?? "false").toLowerCase() === "true";

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8],
] as const)
  blocked.addSubnet(a, p, "ipv6");

/** The 16 bytes of an IPv6 address (any textual form, including a trailing dotted IPv4), or null. */
function ipv6Bytes(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  let s = ip.split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const b = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g || "0", 16);
    return [n >> 8, n & 255];
  });
}

/** IPv4 address carried inside an IPv6 address (mapped, compatible, translated, NAT64 or 6to4), if any. */
export function embeddedIpv4(ip: string): string | null {
  const b = ipv6Bytes(ip);
  if (!b) return null;
  const dotted = (o: number) => b.slice(o, o + 4).join(".");
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return dotted(12); // ::ffff:a.b.c.d, ::a.b.c.d
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return dotted(12); // ::ffff:0:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return dotted(12); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return dotted(2); // 2002::/16 (6to4)
  return null;
}

export function isBlockedAddress(ip: string): boolean {
  if (allowPrivate) return false;
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return blocked.check(v4, "ipv4");
  }
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Throws when the URL is not an http(s) URL or points at a refused address literal. */
export function checkWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("URL must be a valid http(s) URL"), { status: 400 });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("URL must start with http(s)://"), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Put credentials in headers, not in the URL"), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host))
    throw Object.assign(new Error("Webhook URLs on private or local addresses are disabled (DATACAT_ALLOW_PRIVATE_WEBHOOKS)"), { status: 400 });
  if (!allowPrivate && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
    throw Object.assign(new Error("Webhook URLs on private or local addresses are disabled (DATACAT_ALLOW_PRIVATE_WEBHOOKS)"), { status: 400 });
  return u;
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return (callback as any)(Object.assign(new Error(`refused: ${hostname} resolves to a private or local address`), { code: "EBLOCKED" }));
    if ((options as any)?.all) return (callback as any)(null, list);
    (callback as any)(null, list[0].address, list[0].family);
  });
};

// Headers that control the connection or message framing; DataCat sets these itself.
const RESERVED_HEADERS = new Set(["host", "transfer-encoding", "connection", "content-length", "upgrade", "te", "keep-alive", "proxy-connection", "trailer"]);

/** Validates custom webhook headers: a JSON object of string values, without connection or framing headers. */
export function checkWebhookHeaders(h: unknown): Record<string, string> | null {
  if (h === null || h === undefined) return null;
  if (typeof h !== "object" || Array.isArray(h)) throw Object.assign(new Error("headers must be a JSON object"), { status: 400 });
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw Object.assign(new Error(`Invalid header name: ${k}`), { status: 400 });
    if (RESERVED_HEADERS.has(k.toLowerCase())) throw Object.assign(new Error(`The ${k} header cannot be set on a webhook`), { status: 400 });
    if ((typeof v !== "string" && typeof v !== "number") || /[\r\n]/.test(String(v)))
      throw Object.assign(new Error(`Header ${k} must be a single-line string`), { status: 400 });
  }
  return h as Record<string, string>;
}

/**
 * POSTs to a webhook. idleMs limits inactivity; totalMs limits the whole delivery, so a receiver that trickles bytes
 * cannot keep it open.
 */
export function postWebhook(raw: string, headers: Record<string, string>, body: string, idleMs = 10_000, totalMs = 15_000): Promise<{ status: number }> {
  const u = checkWebhookUrl(raw);
  const mod = u.protocol === "https:" ? https : http;
  const safeHeaders: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(headers)) if (!RESERVED_HEADERS.has(k.toLowerCase())) safeHeaders[k] = String(v);
  safeHeaders["content-length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: "POST", headers: safeHeaders, lookup: safeLookup, timeout: idleMs }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      res.on("error", reject);
      res.on("aborted", () => reject(Object.assign(new Error("response aborted"), { code: "ECONNRESET" })));
    });
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), totalMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });
}
