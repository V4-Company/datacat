import { db, usersTable, invitesTable, orgsTable } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { clearSession, createSession, getSessionId, setSessionCookie, hashPassword, verifyPassword, type SessionData } from "../lib/auth";
import { getOrigin } from "../lib/config";
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

router.get("/auth/user", async (req: Request, res: Response) => {
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  res.json({
    user: req.authUser ?? null,
    signedIn: !!req.sessionUser,
    restricted: !!req.sessionUser && !req.authUser,
    email: req.sessionUser?.email ?? null,
    setupRequired: !existing,
    setupTokenRequired: !existing,
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
  const key = req.ip ?? "unknown";
  const now = Date.now();
  for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
  attempts.set(key, entry);
  if (++entry.count > 20) {
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
async function signIn(res: Response, user: SessionData["user"]) {
  const sid = await createSession({
    kind: "local",
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
    },
  });
  setSessionCookie(res, sid);
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

export default router;
