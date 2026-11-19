import { Router, type NextFunction, type Request, type Response } from "express";
import { getOrigin } from "../lib/config";
import { handleMcpMessage, rpcError, JSONRPC, PROTOCOL_VERSIONS } from "../lib/mcp";
import { loopbackApi, loopbackBase, type FetchLike } from "../lib/mcpTools";

// MCP server for AI assistants (Claude Code and other MCP clients): POST /api/mcp, read-only tools over this
// organization's telemetry (lib/mcpTools.ts). Only API key + application key callers are served, never cookie sessions,
// so a page in a browser cannot drive it with a signed-in user's cookies.

const MCP_PATH = "/mcp";

/**
 * Who may call: API key + application key of one organization (authMiddleware sets viaKeys). Wrong keys are 403;
 * no keys, or only a cookie session, are 401.
 */
function authFailure(req: Request): { status: number; message: string } | null {
  if (req.orgId && req.viaKeys) return null;
  const triedKeys = !!(req.get("dd-api-key") || req.get("dd-application-key"));
  if (triedKeys && !req.sessionUser) return { status: 403, message: "Forbidden: invalid API key or application key" };
  return { status: 401, message: "Unauthorized: send DD-API-KEY and DD-APPLICATION-KEY headers (cookie sessions are not accepted)" };
}

/** The MCP router. Tools reach the API at `base` (this process by default) with `fetch`; tests pass stubs. */
export function mcpRouter(opts: { base?: string; fetch?: FetchLike } = {}): Router {
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

async function answer(req: Request, res: Response, opts: { base?: string; fetch?: FetchLike }) {
  // DNS rebinding protection (MCP transport spec): a browser request must come from DataCat's own origin.
  const origin = req.get("origin");
  if (origin && origin !== getOrigin(req)) {
    res.status(403).json(rpcError(null, JSONRPC.INVALID_REQUEST, "Invalid request origin"));
    return;
  }

  const denied = authFailure(req);
  if (denied) {
    res.status(denied.status).json(rpcError(null, JSONRPC.INVALID_REQUEST, denied.message));
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

  const api = loopbackApi({
    base: opts.base ?? loopbackBase(),
    apiKey: String(req.get("dd-api-key")),
    appKey: String(req.get("dd-application-key")),
    fetch: opts.fetch,
  });
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
