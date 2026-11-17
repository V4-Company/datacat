import { type NextFunction, type Request, type Response } from "express";
import { clearSession, getSession, getSessionId, type SessionData } from "../lib/auth";
import { resolveMembership, orgForApiKey, type OrgUser } from "../lib/org";
import { getOrigin } from "../lib/config";
import { db, apiKeysTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      authUser?: OrgUser | null;
      sessionUser?: SessionData["user"] | null;
      orgId?: number;
      viaKeys?: boolean;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const sid = getSessionId(req);
    // Cookie sessions: a state-changing request must come from DataCat's own pages (SameSite=Lax cookies already stop
    // most cross-site requests; this also covers sibling subdomains).
    if (sid && !SAFE_METHODS.has(req.method)) {
      const origin = req.get("origin");
      if ((origin && origin !== getOrigin(req)) || req.get("sec-fetch-site") === "cross-site") {
        res.status(403).json({ errors: ["Invalid request origin"] });
        return;
      }
    }
    if (sid) {
      const session = await getSession(sid);
      // Only local-account sessions are valid; anything else is cleared.
      if (!session?.user?.id || (session.kind !== undefined && session.kind !== "local")) {
        await clearSession(res, sid);
      } else {
        req.sessionUser = session.user;
        req.authUser = await resolveMembership(session.user);
        if (req.authUser) req.orgId = req.authUser.orgId;
      }
    }
    // API + application key auth for the public API
    if (!req.orgId) {
      const apiKey = (req.headers["dd-api-key"] as string) || undefined;
      const appKey = (req.headers["dd-application-key"] as string) || undefined;
      if (apiKey && appKey) {
        const orgId = await orgForApiKey(apiKey);
        const [app] = await db
          .select()
          .from(apiKeysTable)
          .where(and(eq(apiKeysTable.key, appKey), eq(apiKeysTable.kind, "app"), eq(apiKeysTable.revoked, false)));
        if (orgId && app && app.orgId === orgId) {
          req.orgId = orgId;
          req.viaKeys = true;
        }
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// A request that presents keys which are wrong, revoked or from different organizations gets
// 403 Forbidden; a request with no credentials at all gets 401.
export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.orgId) {
    const triedKeys = !!(req.headers["dd-api-key"] || req.headers["dd-application-key"]);
    if (req.sessionUser || triedKeys) res.status(403).json({ errors: [req.sessionUser ? "Access restricted" : "Forbidden"] });
    else res.status(401).json({ errors: ["Unauthorized"] });
    return;
  }
  next();
}

/** Signed-in admins, or scripts using an API key + application key pair (application keys are created by admins). */
export function requireAdminOrKeys(req: Request, res: Response, next: NextFunction) {
  if (req.authUser?.role === "admin" || (!req.sessionUser && req.orgId && req.viaKeys)) {
    next();
    return;
  }
  res.status(403).json({ errors: ["Admin only"] });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser || req.authUser.role !== "admin") {
    res.status(403).json({ errors: ["Admin only"] });
    return;
  }
  next();
}
