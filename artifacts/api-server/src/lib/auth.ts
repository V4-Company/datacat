import crypto from "crypto";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Request, type Response } from "express";
import { promisify } from "node:util";
import { secureCookies } from "./config";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

export interface SessionData {
  user: AuthUser;
  kind?: "local";
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }
  return row.sess as unknown as SessionData;
}

export async function updateSession(sid: string, data: SessionData): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ sess: data as unknown as Record<string, unknown>, expire: new Date(Date.now() + SESSION_TTL) })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Sessions come only from the (signed) cookie; the raw session id is never accepted as a token.
export function getSessionId(req: Request): string | undefined {
  return process.env.SESSION_SECRET ? req.signedCookies?.[SESSION_COOKIE] || undefined : req.cookies?.[SESSION_COOKIE];
}

export function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: secureCookies,
    signed: !!process.env.SESSION_SECRET,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

const scrypt = promisify(crypto.scrypt);
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !hex || hex.length !== 128) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(actual, Buffer.from(hex, "hex"));
}
