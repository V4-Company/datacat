import crypto from "node:crypto";
import type { Request } from "express";

// Credential the MCP tools (lib/mcpTools.ts) use to call this process's own API over loopback: a random secret made at
// startup, held only in memory, plus the organization the MCP caller was authenticated for. authMiddleware accepts it
// for reads only, so MCP is read-only whatever credential the MCP caller presented (an admin's key pair included).

export const MCP_INTERNAL_HEADERS = { secret: "x-datacat-mcp-internal", org: "x-datacat-mcp-org" } as const;

const SECRET = crypto.randomBytes(32);
const SECRET_HEX = SECRET.toString("hex");

/** POST routes the MCP tools call that only read (searches and queries with a JSON body). */
const READ_ONLY_POSTS = new Set(["/ui/apm/spans", "/ui/metrics/query", "/ui/logs/search", "/v2/logs/analytics/aggregate"]);

export function internalCredentialHeaders(orgId: number): Record<string, string> {
  return { [MCP_INTERNAL_HEADERS.secret]: SECRET_HEX, [MCP_INTERNAL_HEADERS.org]: String(orgId) };
}

/**
 * True for the socket's own peer address on the loopback interface. Takes the socket address, never req.ip, so
 * X-Forwarded-For cannot make a remote request look local.
 */
function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "::1" || !!addr?.startsWith("127.") || !!addr?.startsWith("::ffff:127.");
}

function secretMatches(given: string | undefined): boolean {
  const buf = Buffer.from(given ?? "", "hex");
  return given?.length === SECRET_HEX.length && buf.length === SECRET.length && crypto.timingSafeEqual(buf, SECRET);
}

/** The organization of a valid internal credential, or null. */
export function internalOrgId(c: { secret?: string; org?: string; remoteAddress?: string }): number | null {
  const orgId = Number(c.org);
  const validOrg = /^[1-9]\d{0,9}$/.test(c.org ?? "") && orgId <= 2147483647;
  return validOrg && isLoopbackAddress(c.remoteAddress) && secretMatches(c.secret) ? orgId : null;
}

/** GET and HEAD, or one of the read-only POSTs. Paths are relative to /api and compared exactly. */
export function isReadOnlyRequest(method: string, path: string): boolean {
  return method === "GET" || method === "HEAD" || (method === "POST" && READ_ONLY_POSTS.has(path));
}

/**
 * Reads and removes the internal credential headers, so nothing after authMiddleware sees them whether or not they
 * were valid. Returns the organization when the credential is valid, otherwise null.
 */
export function takeInternalCredential(req: Request): number | null {
  const secret = req.get(MCP_INTERNAL_HEADERS.secret);
  const org = req.get(MCP_INTERNAL_HEADERS.org);
  delete req.headers[MCP_INTERNAL_HEADERS.secret];
  delete req.headers[MCP_INTERNAL_HEADERS.org];

  return internalOrgId({ secret, org, remoteAddress: req.socket.remoteAddress });
}
