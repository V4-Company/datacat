import { logger } from "./logger";
import crypto from "crypto";
import { db, orgsTable, usersTable, apiKeysTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { AuthUser } from "./auth";

export function newKey(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

export interface OrgUser extends AuthUser {
  orgId: number;
  orgName: string;
  role: string;
}

/** The user's organization and role, or null when the account is not a member of one. */
export async function resolveMembership(user: AuthUser): Promise<OrgUser | null> {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  if (!row?.orgId) return null;
  const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, row.orgId));
  return { ...user, orgId: row.orgId, orgName: org?.name ?? "Org", role: row.role };
}

const keyCache = new Map<string, { orgId: number; kind: string; at: number }>();

export async function orgForApiKey(key: string | undefined | null): Promise<number | null> {
  if (!key) return null;
  const c = keyCache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.orgId;
  const [row] = await db
    .select()
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.key, key), eq(apiKeysTable.kind, "api"), eq(apiKeysTable.revoked, false)));
  if (!row) return null;
  keyCache.set(key, { orgId: row.orgId, kind: row.kind, at: Date.now() });
  db.update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, row.id))
    .catch((e) => logger.debug({ err: String(e) }, "api key last_used_at update failed"));
  return row.orgId;
}

export function invalidateKey(key: string) {
  keyCache.delete(key);
}
