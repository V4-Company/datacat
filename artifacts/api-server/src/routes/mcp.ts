import { Router, type NextFunction, type Request, type Response } from "express";
import { getOrigin } from "../lib/config";
import { handleMcpMessage, rpcError, JSONRPC, PROTOCOL_VERSIONS } from "../lib/mcp";
import { loopbackApi, loopbackBase, type FetchLike } from "../lib/mcpTools";
import { bearerToken, dbMcpTokenStore, orgForMcpToken, type McpTokenStore } from "../lib/mcpTokens";

// MCP server for AI assistants (Claude Code and other MCP clients): POST /api/mcp, read-only tools over this
// organization's telemetry (lib/mcpTools.ts). Callers authenticate with a personal MCP token or an API key +
// application key pair, never a cookie session, so a page in a browser cannot drive it with a signed-in user's cookies.

const MCP_PATH = "/mcp";

interface McpOptions {
  base?: string;
  fetch?: FetchLike;
  tokens?: McpTokenStore;
}

type Caller = { orgId: number } | { status: number; message: string };

/**
 * Who may call: a personal MCP token (Authorization: Bearer), or an API key + application key of one organization
 * (authMiddleware sets viaKeys). An invalid token or wrong keys are 403; no credentials, or only a cookie session, 401.
 */
async function caller(req: Request, tokens: McpTokenStore): Promise<Caller> {
  if (req.orgId && req.viaKeys) return { orgId: req.orgId };

  const bearer = bearerToken(req.get("authorization"));
  if (bearer !== null) {
    const orgId = await orgForMcpToken(bearer, tokens);
    return orgId ? { orgId } : { status: 403, message: "Forbidden: invalid or revoked MCP token" };
  }

  const triedKeys = !!(req.get("dd-api-key") || req.get("dd-application-key"));
  if (triedKeys && !req.sessionUser) return { status: 403, message: "Forbidden: invalid API key or application key" };
  return {
    status: 401,
    message: "Unauthorized: send Authorization: Bearer <MCP token>, or DD-API-KEY and DD-APPLICATION-KEY headers (cookie sessions are not accepted)",
  };
}

/** The MCP router. Tools reach the API at `base` (this process by default) with `fetch`; tests pass stubs. */
export function mcpRouter(opts: McpOptions = {}): Router {
  const router: Router = Router();
  router.post(MCP_PATH, (req, res) => answer(req, res, opts));
  // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
  router.all(MCP_PATH, (_req, res) => {
    res
      .set("Allow", "POST")
      .status(405)
      .json(rpcError(null, JSONRPC.INVALID_REQUEST, "Method not allowed: POST JSON-RPC messages to this endpoint"));
  });
  return router;
}

async function answer(req: Request, res: Response, opts: McpOptions) {
  // DNS rebinding protection (MCP transport spec): a browser request must come from DataCat's own origin.
  const origin = req.get("origin");
  if (origin && origin !== getOrigin(req)) {
    res.status(403).json(rpcError(null, JSONRPC.INVALID_REQUEST, "Invalid request origin"));
    return;
  }

  const who = await caller(req, opts.tokens ?? dbMcpTokenStore);
  if ("status" in who) {
    res.status(who.status).json(rpcError(null, JSONRPC.INVALID_REQUEST, who.message));
    return;
  }

  const version = req.get("mcp-protocol-version");
  if (version && !PROTOCOL_VERSIONS.some((v) => v === version)) {
    res.status(400).json(rpcError(null, JSONRPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version.slice(0, 40)}`));
    return;
  }

  if (req.body === undefined) {
    res.status(400).json(rpcError(null, JSONRPC.PARSE_ERROR, "Parse error: send one JSON-RPC message with Content-Type: application/json"));
    return;
  }

  const api = loopbackApi({ base: opts.base ?? loopbackBase(), orgId: who.orgId, fetch: opts.fetch });
  const reply = await handleMcpMessage(req.body, api);
  if (!reply.body) {
    res.status(reply.status).end();
    return;
  }
  res.status(reply.status).json(reply.body);
}

/**
 * Malformed JSON is rejected by the app-wide JSON parser before routing; answer it as a JSON-RPC parse error instead of
 * the generic 500, and without logging the body.
 */
export function mcpParseErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  const parseFailed = !!err && typeof err === "object" && (err as { type?: unknown }).type === "entity.parse.failed";
  if (!parseFailed) {
    next(err);
    return;
  }
  res.status(400).json(rpcError(null, JSONRPC.PARSE_ERROR, "Parse error: invalid JSON"));
}

export default mcpRouter();
