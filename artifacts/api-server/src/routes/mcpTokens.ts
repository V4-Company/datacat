import { Router, type NextFunction, type Request, type Response } from "express";
import { h, HttpError } from "../lib/http";
import { getOrigin } from "../lib/config";
import { logger } from "../lib/logger";
import { TOOLS } from "../lib/mcpTools";
import {
  MAX_MCP_TOKENS_PER_USER,
  dbMcpTokenStore,
  mcpTokenName,
  newMcpToken,
  type McpTokenOwner,
  type McpTokenRow,
  type McpTokenStore,
} from "../lib/mcpTokens";

// Personal MCP tokens (lib/mcpTokens.ts) for the signed-in user, and what an assistant needs to connect to /api/mcp.
// Cookie sessions only, any role: key pairs and MCP calls cannot list or create tokens. authMiddleware already refuses
// cookie-session writes from another origin.

/** Signed-in members only: authUser is set from a cookie session alone, never from keys or the MCP credential. */
function requireSignedInUser(req: Request, res: Response, next: NextFunction) {
  if (req.authUser) {
    next();
    return;
  }
  res.status(req.orgId ? 403 : 401).json({ errors: [req.orgId ? "Sign in to DataCat to manage MCP tokens" : "Unauthorized"] });
}

function ownerOf(req: Request): McpTokenOwner {
  const user = req.authUser!;
  return { userId: user.id, orgId: user.orgId };
}

function tokenId(v: unknown): number {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n > 2147483647) throw new HttpError(404, "Token not found");
  return n;
}

const tokenOut = (t: McpTokenRow) => ({ id: t.id, name: t.name, created_at: t.createdAt.toISOString(), last_used_at: t.lastUsedAt?.toISOString() ?? null });

export function mcpTokensRouter(store: McpTokenStore = dbMcpTokenStore): Router {
  const router: Router = Router();
  router.use("/ui/mcp", requireSignedInUser);

  router.get(
    "/ui/mcp/tokens",
    h(async (req, res) => {
      res.json({ tokens: (await store.list(ownerOf(req))).map(tokenOut) });
    }),
  );

  router.post(
    "/ui/mcp/tokens",
    h(async (req, res) => {
      const owner = ownerOf(req);
      const name = mcpTokenName(req.body?.name);

      const active = await store.list(owner);
      if (active.length >= MAX_MCP_TOKENS_PER_USER) {
        throw new HttpError(400, `You already have ${MAX_MCP_TOKENS_PER_USER} MCP tokens. Revoke one before creating another.`);
      }

      const token = newMcpToken();
      const row = await store.create(owner, name, token);
      logger.info({ tokenId: row.id, userId: owner.userId, orgId: owner.orgId }, "mcp token created");

      res.json({ id: row.id, name: row.name, created_at: row.createdAt.toISOString(), token });
    }),
  );

  router.delete(
    "/ui/mcp/tokens/:id",
    h(async (req, res) => {
      const owner = ownerOf(req);
      const id = tokenId(req.params.id);

      if (!(await store.revoke(owner, id))) throw new HttpError(404, "Token not found");
      logger.info({ tokenId: id, userId: owner.userId, orgId: owner.orgId }, "mcp token revoked");

      res.json({ ok: true });
    }),
  );

  router.get("/ui/mcp/info", (req, res) => {
    res.json({
      endpoint: `${getOrigin(req)}/api/mcp`,
      server_name: "datacat",
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    });
  });

  return router;
}

export default mcpTokensRouter();
