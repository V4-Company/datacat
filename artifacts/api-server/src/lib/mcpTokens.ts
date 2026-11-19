import { db, apiKeysTable, usersTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { HttpError } from "./http";
import { logger } from "./logger";
import { newKey } from "./org";

// Personal MCP tokens: read-only credentials for /api/mcp that any signed-in user creates for themselves. They are rows
// of api_keys with kind "mcp", so orgForApiKey (kind "api") and the application-key check (kind "app") never accept
// them. A token works only while it is not revoked and its creator is still a member of the token's organization.

export const MCP_TOKEN_KIND = "mcp";
export const MCP_TOKEN_PREFIX = "dcmcp_";
export const MAX_MCP_TOKENS_PER_USER = 10;
const DEFAULT_NAME = "MCP token";
const MAX_NAME_LENGTH = 60;
const TOKEN_SHAPE = /^dcmcp_[0-9a-f]{48}$/;
const TOUCH_INTERVAL_MS = 60_000;

export interface McpTokenOwner {
  userId: string;
  orgId: number;
}

export interface McpTokenRow {
  id: number;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface McpTokenMatch {
  id: number;
  orgId: number;
  userId: string | null;
  revoked: boolean;
}

/** Storage of personal MCP tokens; tests pass an in-memory one. */
export interface McpTokenStore {
  /** The owner's tokens that are not revoked, newest first. */
  list(owner: McpTokenOwner): Promise<McpTokenRow[]>;
  create(owner: McpTokenOwner, name: string, token: string): Promise<McpTokenRow>;
  /** Revokes one of the owner's active tokens; false when there is no such token. */
  revoke(owner: McpTokenOwner, id: number): Promise<boolean>;
  /** The MCP token with this value, revoked or not. */
  find(token: string): Promise<McpTokenMatch | null>;
  /** The user's current organization, or null when the user no longer exists or belongs to none. */
  userOrg(userId: string): Promise<number | null>;
  touch(id: number): Promise<void>;
}

export function newMcpToken(): string {
  return MCP_TOKEN_PREFIX + newKey(24);
}

/** The token name from a request body: trimmed, 1-60 characters, the default when missing or blank. */
export function mcpTokenName(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_NAME;
  if (typeof raw !== "string") throw new HttpError(400, "name must be a string");

  const name = raw.trim();
  if (!name) return DEFAULT_NAME;
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `name must be 1-${MAX_NAME_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "name cannot contain control characters");

  return name;
}

/** The credential of an `Authorization: Bearer <token>` header, or null for no header or another scheme. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^bearer(?:\s+(.*))?$/i.exec(header?.trim() ?? "");
  return match ? (match[1] ?? "").trim() : null;
}

const lastTouched = new Map<number, number>();

/** The organization a personal MCP token acts for, or null when the token is unknown, revoked or its creator left. */
export async function orgForMcpToken(token: string, store: McpTokenStore = dbMcpTokenStore): Promise<number | null> {
  if (!TOKEN_SHAPE.test(token)) return null;

  const match = await store.find(token);
  if (!match || match.revoked || !match.userId) return null;

  const memberOf = await store.userOrg(match.userId);
  if (memberOf !== match.orgId) return null;

  const now = Date.now();
  if (now - (lastTouched.get(match.id) ?? 0) >= TOUCH_INTERVAL_MS) {
    lastTouched.set(match.id, now);
    store.touch(match.id).catch((e) => logger.debug({ err: String(e) }, "mcp token last_used_at update failed"));
  }
  return match.orgId;
}

const ownerFilter = (owner: McpTokenOwner) =>
  and(eq(apiKeysTable.createdBy, owner.userId), eq(apiKeysTable.orgId, owner.orgId), eq(apiKeysTable.kind, MCP_TOKEN_KIND), eq(apiKeysTable.revoked, false));
const rowColumns = { id: apiKeysTable.id, name: apiKeysTable.name, createdAt: apiKeysTable.createdAt, lastUsedAt: apiKeysTable.lastUsedAt };

export const dbMcpTokenStore: McpTokenStore = {
  async list(owner) {
    return db.select(rowColumns).from(apiKeysTable).where(ownerFilter(owner)).orderBy(desc(apiKeysTable.createdAt), desc(apiKeysTable.id));
  },
  async create(owner, name, token) {
    const [row] = await db
      .insert(apiKeysTable)
      .values({ orgId: owner.orgId, name, key: token, kind: MCP_TOKEN_KIND, createdBy: owner.userId })
      .returning(rowColumns);
    return row;
  },
  async revoke(owner, id) {
    const revoked = await db
      .update(apiKeysTable)
      .set({ revoked: true })
      .where(and(eq(apiKeysTable.id, id), ownerFilter(owner)))
      .returning({ id: apiKeysTable.id });
    return revoked.length > 0;
  },
  async find(token) {
    const [row] = await db
      .select({ id: apiKeysTable.id, orgId: apiKeysTable.orgId, userId: apiKeysTable.createdBy, revoked: apiKeysTable.revoked })
      .from(apiKeysTable)
      .where(and(eq(apiKeysTable.key, token), eq(apiKeysTable.kind, MCP_TOKEN_KIND)));
    return row ?? null;
  },
  async userOrg(userId) {
    const [row] = await db.select({ orgId: usersTable.orgId }).from(usersTable).where(eq(usersTable.id, userId));
    return row?.orgId ?? null;
  },
  async touch(id) {
    await db.update(apiKeysTable).set({ lastUsedAt: new Date() }).where(eq(apiKeysTable.id, id));
  },
};
