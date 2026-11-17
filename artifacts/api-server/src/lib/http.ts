import type { Request, Response } from "express";
import { logger } from "./logger";

/** An error whose message is safe to show the caller, with its HTTP status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Route wrapper. Our own validation errors (HttpError, or a plain Error thrown by request parsing) answer 4xx with
 * their message. Database errors never reach the caller: invalid input caught by the database is a generic 400, and
 * anything else is logged and answered with a generic 500.
 */
const NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "UND_ERR_SOCKET"]);
/**
 * True for a temporary storage failure (database or ClickHouse unavailable, connection or server error), which intake
 * answers with 503 so agents retry. PostgreSQL data errors (classes 22 and 23) are the payload's fault, not storage's.
 */
export function isStorageError(err: any, depth = 0): boolean {
  if (!err || depth > 3) return false;
  const code = typeof err.code === "string" ? err.code : "";
  const msg = String(err.message ?? "");
  if (/^[0-9A-Z]{5}$/.test(code)) return !/^2[23]/.test(code);
  if (NET_CODES.has(code) || /^ClickHouse[: ]/.test(msg) || msg === "fetch failed") return true;
  if (/Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(msg)) return true;
  return isStorageError(err.cause, depth + 1);
}

export const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: any) => {
    if (res.headersSent) return;
    if (e instanceof HttpError) {
      res.status(e.status).json({ errors: [e.message] });
      return;
    }
    const pgCode = typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
    const fromDb = pgCode !== null || /^ClickHouse:/.test(String(e?.message ?? ""));
    if (pgCode?.startsWith("22")) {
      res.status(400).json({ errors: ["Invalid value in request"] });
      return;
    }
    if (fromDb) {
      logger.error({ err: e, path: req.path }, "query failed");
      res.status(500).json({ errors: ["Internal error"] });
      return;
    }
    res.status(400).json({ errors: [String(e?.message ?? e)] });
  });
};

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 };

/**
 * A point in time as the public API accepts it: seconds or milliseconds since the epoch (number or numeric string),
 * ISO 8601, or date math ("now", "now-15m", "now-1h", "now-7d"). Returns unix seconds; throws a 400 otherwise.
 */
export function parseTime(v: unknown, fallback: number, now = Math.floor(Date.now() / 1000)): number {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, `Invalid time: ${String(v)}`);
    return Math.floor(Math.abs(n) > 1e11 ? n / 1000 : n);
  }
  const s = String(v).trim();
  const m = /^now(?:\s*([+-])\s*(\d+)\s*(mo|s|m|h|d|w))?$/.exec(s);
  if (m) return m[1] ? now + (m[1] === "-" ? -1 : 1) * Number(m[2]) * UNIT[m[3]] : now;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `Invalid time: ${s}`);
  return Math.floor(t / 1000);
}

/** Time range from a request's query string or body (from/to); defaults to the last hour. */
export function rangeOf(src: Record<string, unknown>, defaultSpan = 3600): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000);
  const to = parseTime(src.to, now, now);
  const from = parseTime(src.from, to - defaultSpan, now);
  if (from > to) throw new HttpError(400, "'from' must be before 'to'");
  return { from, to };
}

/** Page size: a positive integer up to max (default when absent). */
export function pageLimit(v: unknown, def: number, max: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid page limit: ${String(v)}`);
  return Math.min(n, max);
}

/** Opaque pagination cursor holding the sort key of the last row returned. */
export function encodeCursor(key: (string | number)[]): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}
export function decodeCursor(c: unknown): (string | number)[] | null {
  if (c === undefined || c === null || c === "") return null;
  try {
    const v = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2) return v;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Invalid page cursor");
}

/** Absolute URL of the same request with page[cursor] replaced, for links.next. */
export function nextLink(req: Request, cursor: string): string {
  const u = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
  u.searchParams.set("page[cursor]", cursor);
  return u.toString();
}
