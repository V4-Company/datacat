import { db, usersTable, invitesTable, orgsTable, type User } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { clearSession, createSession, getSessionId, setSessionCookie, hashPassword, verifyPassword, type SessionData } from "../lib/auth";
import { getOrigin, oidcConfig, secureCookies } from "../lib/config";
import { logger } from "../lib/logger";
import {
  OidcError,
  OidcProvider,
  STATE_TTL_MS,
  authorizeClaims,
  newLoginState,
  openState,
  sameString,
  sealState,
  stateKey,
  type OidcConfig,
  type OidcProfile,
} from "../lib/oidc";
import crypto from "node:crypto";

// First-run setup creates the first admin and always needs the setup token: DATACAT_SETUP_TOKEN if set, otherwise a
// random one printed in the server log at startup. Network location is not trusted (behind a reverse proxy every
// request looks local), so a server exposed to the internet cannot be claimed before its operator finishes setup.
const configuredSetupToken = process.env.DATACAT_SETUP_TOKEN ?? "";
const SETUP_TOKEN = configuredSetupToken || crypto.randomBytes(18).toString("base64url");
export const generatedSetupToken = configuredSetupToken ? null : SETUP_TOKEN;
function setupAllowed(req: Request) {
  const given = Buffer.from(String(req.body?.setupToken ?? ""));
  const want = Buffer.from(SETUP_TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const router: IRouter = Router();

// Only same-origin paths: parsed against a fixed origin so "//host", "/\\host" and similar forms are refused.
export function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const base = "http://datacat.invalid";
  try {
    const u = new URL(value, base);
    return u.origin === base ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

// Same accept/reject result as /^[^\s@]+@[^\s@]+\.[^\s@]+$/, in linear time and with the length checked first.
export function validEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;
  return email.slice(at + 2, -1).includes(".");
}

async function hasUsers(): Promise<boolean> {
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  return !!existing;
}

router.get("/auth/user", async (req: Request, res: Response) => {
  const setupDone = await hasUsers();
  res.json({
    user: req.authUser ?? null,
    signedIn: !!req.sessionUser,
    restricted: !!req.sessionUser && !req.authUser,
    email: req.sessionUser?.email ?? null,
    setupRequired: !setupDone,
    setupTokenRequired: !setupDone,
    oidc: { enabled: !!oidcConfig, label: oidcConfig?.label ?? "" },
  });
});

router.get("/logout", async (req: Request, res: Response) => {
  await clearSession(res, getSessionId(req));
  res.redirect(getSafeReturnTo(req.query.returnTo));
});

/**
 * Invite links: an admin invites an email; the invite carries a secret token. Opening the link
 * lets that person set a password and join the organization.
 */
router.get("/invite/:token", async (req: Request, res: Response) => {
  res.redirect(`/invite/${encodeURIComponent(String(req.params.token))}`);
});

router.get("/auth/invites/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const [inv] = token.length >= 24 ? await db.select().from(invitesTable).where(eq(invitesTable.token, token)) : [];
  if (!inv || inv.acceptedAt || Date.now() - inv.createdAt.getTime() > 30 * 86400 * 1000) {
    res.status(404).json({ error: "This invite is invalid, used, or expired. Ask your admin for a new one." });
    return;
  }
  res.json({ email: inv.email, role: inv.role });
});

// Bound password work and basic per-address throttling. Deployments should also rate-limit at their proxy.
const attempts = new Map<string, { count: number; until: number }>();
function tooManyAttempts(req: Request): boolean {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
  attempts.set(key, entry);
  return ++entry.count > 20;
}
router.use(["/auth/login", "/auth/setup", "/auth/invites"], (req, res, next) => {
  if (req.method !== "POST") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== getOrigin(req)) {
    res.status(403).json({ error: "Invalid request origin" });
    return;
  }
  if (tooManyAttempts(req)) {
    res.status(429).json({ error: "Too many attempts. Try again in a minute." });
    return;
  }
  next();
});
function credentials(req: Request) {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body?.password;
  if (!validEmail(email) || typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("Enter a valid email and a password of 12–256 characters");
  }
  return { email, password };
}
async function startSession(res: Response, user: SessionData["user"], kind: SessionData["kind"] = "local") {
  const sid = await createSession({
    kind,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
    },
  });
  setSessionCookie(res, sid);
}
async function signIn(res: Response, user: SessionData["user"]) {
  await startSession(res, user);
  res.json({ ok: true });
}
router.post("/auth/setup", async (req, res) => {
  if (!setupAllowed(req)) {
    res.status(403).json({
      error: "Enter the setup token. It is DATACAT_SETUP_TOKEN, or the token printed in the server log at startup.",
    });
    return;
  }
  let c;
  try {
    c = credentials(req);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const orgName = String(req.body?.orgName ?? "").trim();
  if (!orgName || orgName.length > 150) {
    res.status(400).json({ error: "Enter an organization name (up to 150 characters)" });
    return;
  }
  const passwordHash = await hashPassword(c.password);
  const user = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(386428101)`);
    const [exists] = await tx.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (exists) return null;
    const [org] = await tx.insert(orgsTable).values({ name: orgName }).returning();
    const [created] = await tx
      .insert(usersTable)
      .values({
        email: c.email,
        passwordHash,
        orgId: org.id,
        role: "admin",
        firstName: c.email.split("@")[0],
      })
      .returning();
    return created;
  });
  if (!user) {
    res.status(409).json({ error: "Setup is already complete. Sign in instead." });
    return;
  }
  await signIn(res, user);
});
router.post("/auth/login", async (req, res) => {
  let c;
  try {
    c = credentials(req);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${c.email}`);
  // Run scrypt even for unknown emails to avoid a trivial timing oracle.
  const dummy = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
  const valid = await verifyPassword(c.password, user?.passwordHash ?? dummy);
  if (!user?.passwordHash || !valid) {
    res.status(401).json({ error: "Incorrect email or password" });
    return;
  }
  await clearSession(res, getSessionId(req));
  await signIn(res, user);
});
router.post("/auth/invites/:token", async (req, res) => {
  let c;
  try {
    c = credentials(req);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const passwordHash = await hashPassword(c.password);
  const result = await db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitesTable)
      .where(eq(invitesTable.token, String(req.params.token)))
      .for("update");
    if (!inv || inv.acceptedAt || Date.now() - inv.createdAt.getTime() > 30 * 86400_000 || inv.email.toLowerCase() !== c.email)
      return { error: "Invite is invalid, used, or expired" };
    const [existing] = await tx
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${c.email}`);
    if (existing) return { error: "An account already exists for this email. Sign in or contact your admin." };
    const [user] = await tx
      .insert(usersTable)
      .values({
        email: c.email,
        passwordHash,
        orgId: inv.orgId,
        role: inv.role,
        firstName: c.email.split("@")[0],
      })
      .returning();
    await tx.update(invitesTable).set({ acceptedAt: new Date() }).where(eq(invitesTable.id, inv.id));
    return { user };
  });
  if (!result.user) {
    res.status(400).json({ error: result.error });
    return;
  }
  await clearSession(res, getSessionId(req));
  await signIn(res, result.user);
});
router.post("/auth/logout", async (req, res) => {
  await clearSession(res, getSessionId(req));
  res.json({ ok: true });
});

/**
 * Single sign-on with an OpenID Connect provider (DATACAT_OIDC_*). /auth/oidc/start sends the browser to the provider
 * with a fresh state, nonce and PKCE verifier kept in a short-lived encrypted cookie; the provider sends it back to
 * /auth/oidc/callback, a top-level GET (so the Origin check above, which covers POSTs, does not apply). Only verified
 * emails in DATACAT_OIDC_ALLOWED_DOMAINS sign in: an existing account with that email is signed in, otherwise one is
 * created in the configured organization with DATACAT_OIDC_DEFAULT_ROLE. First-run setup still needs the setup token.
 * Every failure redirects to /login?error=<code>; details go to the server log only.
 */
const oidc = oidcConfig ? new OidcProvider(oidcConfig) : null;
const OIDC_COOKIE = "datacat_oidc";
const OIDC_COOKIE_PATH = "/api/auth/oidc";
const oidcStateKey = stateKey(process.env.SESSION_SECRET);
const oidcRedirectUri = (req: Request) => `${getOrigin(req)}/api/auth/oidc/callback`;
const oidcCookieOptions = { httpOnly: true, secure: secureCookies, sameSite: "lax", path: OIDC_COOKIE_PATH } as const;

/** The organization new single sign-on users join, or null before first-run setup created one. */
async function oidcOrgId(config: OidcConfig): Promise<number | null> {
  if (config.orgId !== null) {
    const [org] = await db.select({ id: orgsTable.id }).from(orgsTable).where(eq(orgsTable.id, config.orgId));
    if (!org) throw new OidcError("oidc_misconfigured", `DATACAT_OIDC_ORG_ID=${config.orgId} is not an existing organization`);
    return org.id;
  }
  const orgs = await db.select({ id: orgsTable.id }).from(orgsTable).orderBy(asc(orgsTable.id)).limit(2);
  if (orgs.length > 1) throw new OidcError("oidc_misconfigured", "there is more than one organization; set DATACAT_OIDC_ORG_ID to the one new users join");
  return orgs[0]?.id ?? null;
}

/** Startup check: with single sign-on enabled, the organization new users join must be unambiguous. */
export async function checkOidcSetup(): Promise<void> {
  if (!oidcConfig) return;
  const [anyOrg] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (anyOrg) {
    try {
      await oidcOrgId(oidcConfig);
    } catch (e) {
      throw new Error(`Single sign-on: ${(e as Error).message}`);
    }
  }
  logger.info(
    {
      issuer: oidcConfig.issuer,
      allowedDomains: oidcConfig.allowedDomains,
      requireHostedDomain: oidcConfig.requireHostedDomain,
      defaultRole: oidcConfig.defaultRole,
    },
    "single sign-on (OIDC) enabled",
  );
}

/** The account for a verified, allowed profile: found by email (case-insensitive), or created. */
async function oidcUser(profile: OidcProfile, config: OidcConfig): Promise<{ user: User; created: boolean }> {
  const byEmail = async () =>
    (
      await db
        .select()
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${profile.email}`)
    )[0];
  const existing = await byEmail();
  if (existing) return { user: existing, created: false };
  const orgId = await oidcOrgId(config);
  if (orgId === null) throw new OidcError("oidc_setup_required", "first-run setup is not complete");
  const [created] = await db
    .insert(usersTable)
    .values({
      email: profile.email,
      passwordHash: null,
      orgId,
      role: config.defaultRole,
      firstName: profile.firstName,
      lastName: profile.lastName,
      profileImageUrl: profile.profileImageUrl,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { user: created, created: true };
  // Another sign-in for the same email created it first.
  const raced = await byEmail();
  if (!raced) throw new Error("could not create the account");
  return { user: raced, created: false };
}

function oidcRefused(res: Response, e: unknown) {
  const code = e instanceof OidcError ? e.code : "oidc_failed";
  if (e instanceof OidcError) logger.warn({ code }, `OIDC sign-in refused: ${e.message}`);
  else logger.error({ err: e }, "OIDC sign-in failed");
  res.redirect(`/login?error=${code}`);
}

router.get("/auth/oidc/start", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!oidc) {
    res.status(404).json({ error: "Single sign-on is not configured" });
    return;
  }
  try {
    if (!(await hasUsers())) throw new OidcError("oidc_setup_required", "first-run setup is not complete");
    // Coming back to the login (or an invite) page after signing in would show nothing useful.
    const returnTo = getSafeReturnTo(req.query.returnTo);
    const login = newLoginState(/^\/(login([/?#]|$)|invite\/)/.test(returnTo) ? "/" : returnTo);
    const url = await oidc.authorizationUrl(login, oidcRedirectUri(req));
    res.cookie(OIDC_COOKIE, sealState(login, oidcStateKey), { ...oidcCookieOptions, maxAge: STATE_TTL_MS });
    res.redirect(url);
  } catch (e) {
    oidcRefused(res, e);
  }
});

router.get("/auth/oidc/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!oidc) {
    res.status(404).json({ error: "Single sign-on is not configured" });
    return;
  }
  // The state is single-use: clear it whatever happens next.
  const login = openState(req.cookies?.[OIDC_COOKIE], oidcStateKey);
  res.clearCookie(OIDC_COOKIE, oidcCookieOptions);
  try {
    if (tooManyAttempts(req)) throw new OidcError("oidc_failed", "too many sign-in attempts from this address");
    if (!login) throw new OidcError("oidc_state_mismatch", "login state cookie is missing, expired or invalid");
    if (!sameString(req.query.state, login.state)) throw new OidcError("oidc_state_mismatch", "state does not match the login state cookie");
    const providerError = req.query.error;
    if (providerError !== undefined)
      throw new OidcError(
        providerError === "access_denied" ? "oidc_cancelled" : "oidc_failed",
        `provider returned error ${String(providerError).slice(0, 100)}`,
      );
    const code = req.query.code;
    if (typeof code !== "string" || !code || code.length > 4096) throw new OidcError("oidc_failed", "callback has no authorization code");
    if (!(await hasUsers())) throw new OidcError("oidc_setup_required", "first-run setup is not complete");
    const claims = await oidc.exchangeCode(code, login, oidcRedirectUri(req));
    const profile = authorizeClaims(claims, oidc.config);
    const { user, created } = await oidcUser(profile, oidc.config);
    await clearSession(res, getSessionId(req));
    await startSession(res, user, "oidc");
    logger.info({ userId: user.id, created }, "OIDC sign-in");
    res.redirect(login.returnTo);
  } catch (e) {
    oidcRefused(res, e);
  }
});

export default router;
