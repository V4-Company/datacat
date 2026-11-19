import crypto, { type KeyObject } from "node:crypto";

// Single sign-on with an OpenID Connect provider (Google by default): the authorization code flow with PKCE, a nonce
// and a state bound to the browser by an encrypted cookie. ID tokens are verified here with node:crypto (RS256 only),
// so no JOSE dependency is needed. Nothing in this module touches the database; routes/auth.ts does the sign-in.

/** Roles a DataCat account can have. */
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  allowedDomains: string[];
  defaultRole: Role;
  label: string;
  orgId: number | null;
  /** Refuse ID tokens without a hosted-domain (`hd`) claim, i.e. Google accounts that are not Workspace accounts. */
  requireHostedDomain: boolean;
}

/** Error codes the login page knows how to explain (sent as /login?error=<code>). */
export type OidcErrorCode =
  "oidc_failed" | "oidc_state_mismatch" | "oidc_domain_not_allowed" | "oidc_email_unverified" | "oidc_setup_required" | "oidc_cancelled" | "oidc_misconfigured";

/** A refused sign-in. The message is for the server log only; the browser only ever sees the code. */
export class OidcError extends Error {
  constructor(
    public code: OidcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$/;

function httpsOrLocal(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} must be a valid URL`);
  }
  const local = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error(`${what} must be an https:// URL`);
  return u;
}

/**
 * Reads the DATACAT_OIDC_* settings. Returns null when single sign-on is not configured and throws on a configuration
 * that is incomplete or unsafe, so the server refuses to start instead of opening sign-in to every account.
 */
export function loadOidcConfig(env: Record<string, string | undefined>): OidcConfig | null {
  const clientId = (env.DATACAT_OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (env.DATACAT_OIDC_CLIENT_SECRET ?? "").trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("Set both DATACAT_OIDC_CLIENT_ID and DATACAT_OIDC_CLIENT_SECRET to enable single sign-on");
  const domains = (env.DATACAT_OIDC_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!domains.length)
    throw new Error("DATACAT_OIDC_ALLOWED_DOMAINS is required when single sign-on is enabled, e.g. DATACAT_OIDC_ALLOWED_DOMAINS=example.com");
  for (const d of domains) if (!DOMAIN.test(d)) throw new Error(`DATACAT_OIDC_ALLOWED_DOMAINS: "${d}" is not a domain name (no wildcards)`);
  const issuer = (env.DATACAT_OIDC_ISSUER ?? "").trim().replace(/\/+$/, "") || GOOGLE_ISSUER;
  httpsOrLocal(issuer, "DATACAT_OIDC_ISSUER");
  const role = (env.DATACAT_OIDC_DEFAULT_ROLE ?? "").trim().toLowerCase() || "member";
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`DATACAT_OIDC_DEFAULT_ROLE must be one of: ${ROLES.join(", ")}`);
  const label = (env.DATACAT_OIDC_LABEL ?? "").trim() || "Google";
  if (label.length > 50) throw new Error("DATACAT_OIDC_LABEL must be at most 50 characters");
  const rawOrg = (env.DATACAT_OIDC_ORG_ID ?? "").trim();
  if (rawOrg && !/^[1-9]\d{0,9}$/.test(rawOrg)) throw new Error("DATACAT_OIDC_ORG_ID must be an organization id (a positive integer)");
  // A consumer Google account can be registered with any address, including one at your domain, and Google reports it
  // as verified; only Workspace accounts carry `hd`. So with Google, `hd` is required unless explicitly turned off.
  const rawHd = (env.DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN ?? "").trim().toLowerCase();
  if (rawHd && !["true", "false", "1", "0"].includes(rawHd)) throw new Error("DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN must be true, false, 1 or 0");
  const requireHostedDomain = rawHd ? rawHd === "true" || rawHd === "1" : issuer === GOOGLE_ISSUER;
  return {
    clientId,
    clientSecret,
    issuer,
    allowedDomains: [...new Set(domains)],
    defaultRole: role as Role,
    label,
    orgId: rawOrg ? Number(rawOrg) : null,
    requireHostedDomain,
  };
}

// ---------- Login state cookie ----------

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** Expiry, milliseconds since the epoch. */
  exp: number;
}

export const STATE_TTL_MS = 10 * 60 * 1000;

const b64url = (b: Buffer) => b.toString("base64url");
const random = (bytes = 32) => b64url(crypto.randomBytes(bytes));

/** PKCE S256 challenge for a code verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

export function newLoginState(returnTo: string, now = Date.now()): LoginState {
  return { state: random(), nonce: random(), verifier: random(), returnTo, exp: now + STATE_TTL_MS };
}

/** AES-256-GCM key for the state cookie, derived from SESSION_SECRET (random per process when it is unset). */
export function stateKey(secret: string | undefined): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret || crypto.randomBytes(32), "", "datacat-oidc-state", 32));
}

/** Encrypts and authenticates the login state, so the browser can neither read nor alter it. */
export function sealState(s: LoginState, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(s), "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** The login state from a cookie, or null when it is missing, altered, malformed or expired. */
export function openState(sealed: unknown, key: Buffer, now = Date.now()): LoginState | null {
  if (typeof sealed !== "string" || sealed.length > 4096) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const s = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    if (typeof s?.state !== "string" || typeof s.nonce !== "string" || typeof s.verifier !== "string" || typeof s.returnTo !== "string") return null;
    if (typeof s.exp !== "number" || s.exp < now) return null;
    return s as LoginState;
  } catch {
    return null;
  }
}

export function sameString(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- ID token verification ----------

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  /** Accepted `iss` values. */
  issuers: string[];
  clientId: string;
  nonce: string;
  /** Public key for a key id from the provider's JWKS (null when unknown). */
  getKey: (kid: string | undefined) => Promise<KeyObject | null>;
  /** Unix seconds; defaults to the current time. */
  now?: number;
  /** Allowed clock difference with the provider, in seconds. */
  skew?: number;
}

function decodePart(part: string): any {
  const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  return v;
}

/** Verifies an RS256-signed ID token (signature, iss, aud/azp, exp/iat/nbf, nonce) and returns its claims. */
export async function verifyIdToken(token: string, o: VerifyOptions): Promise<IdTokenClaims> {
  const fail = (why: string): never => {
    throw new OidcError("oidc_failed", `ID token rejected: ${why}`);
  };
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail("malformed");
  let header: any;
  let claims: any;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return fail("malformed");
  }
  // Only RS256: refusing everything else also refuses "none" and HMAC algorithm-confusion tokens.
  if (header.alg !== "RS256") fail(`unsupported algorithm ${String(header.alg)}`);
  if (header.crit !== undefined) fail("unsupported critical header");
  const key = await o.getKey(typeof header.kid === "string" ? header.kid : undefined);
  if (!key) fail("signing key not found");
  const signed = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key!, Buffer.from(parts[2], "base64url"));
  if (!signed) fail("bad signature");

  const now = o.now ?? Math.floor(Date.now() / 1000);
  const skew = o.skew ?? 60;
  if (typeof claims.iss !== "string" || !o.issuers.includes(claims.iss)) fail("wrong issuer");
  const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!aud.includes(o.clientId)) fail("wrong audience");
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== o.clientId) fail("wrong authorized party");
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) fail("expired");
  if (typeof claims.iat !== "number" || claims.iat - skew > now) fail("issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > now)) fail("not yet valid");
  if (!sameString(claims.nonce, o.nonce)) fail("nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub) fail("missing subject");
  return claims as IdTokenClaims;
}

export interface OidcProfile {
  email: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Decides whether verified claims may sign in: the email must be verified, its domain must be in the allowlist and,
 * when the provider states a hosted domain (`hd`, Google Workspace), that must be allowed too; with
 * requireHostedDomain, a token without `hd` is refused. Domains match exactly and case-insensitively; subdomains are
 * not included.
 */
export function authorizeClaims(claims: IdTokenClaims, config: Pick<OidcConfig, "allowedDomains" | "requireHostedDomain">): OidcProfile {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || email.length > 254) throw new OidcError("oidc_failed", "ID token has no usable email claim");
  if (claims.email_verified !== true) throw new OidcError("oidc_email_unverified", "email address is not verified by the provider");
  const allowed = new Set(config.allowedDomains.map((d) => d.toLowerCase()));
  const domain = email.slice(at + 1);
  if (!allowed.has(domain)) throw new OidcError("oidc_domain_not_allowed", `email domain ${domain} is not allowed`);
  if (config.requireHostedDomain && (claims.hd === undefined || claims.hd === null || claims.hd === ""))
    throw new OidcError(
      "oidc_domain_not_allowed",
      "hosted domain (hd) claim is required (DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN) but missing: not a Google Workspace account",
    );
  if (claims.hd !== undefined && (typeof claims.hd !== "string" || !allowed.has(claims.hd.toLowerCase())))
    throw new OidcError("oidc_domain_not_allowed", `hosted domain ${String(claims.hd)} is not allowed`);
  const picture = text(claims.picture, 1000);
  return {
    email,
    firstName: text(claims.given_name) ?? text(claims.name) ?? email.slice(0, at),
    lastName: text(claims.family_name),
    profileImageUrl: picture && /^https:\/\//i.test(picture) ? picture : null,
  };
}

// ---------- Provider (discovery, JWKS, token endpoint) ----------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface ProviderOptions {
  fetch?: FetchLike;
  /** How long discovery and keys are cached (default one hour). */
  cacheMs?: number;
  /** Minimum interval between key refreshes caused by an unknown key id (default one minute). */
  refreshMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * One configured OpenID provider. Outbound calls go to the operator-configured issuer only (never a URL from a
 * request), so they use plain fetch rather than the webhook client in safeHttp.ts, which refuses private addresses
 * that a self-hosted identity provider may legitimately use.
 */
export class OidcProvider {
  private readonly fetch: FetchLike;
  private readonly cacheMs: number;
  private readonly refreshMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private discovery: { doc: Discovery; at: number } | null = null;
  private keys: { byKid: Map<string, KeyObject>; all: KeyObject[]; at: number } | null = null;
  private keysPending: Promise<void> | null = null;

  constructor(
    readonly config: OidcConfig,
    opts: ProviderOptions = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.cacheMs = opts.cacheMs ?? 60 * 60 * 1000;
    this.refreshMs = opts.refreshMs ?? 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Accepted `iss` values: the discovered issuer (Google also issues tokens with the scheme-less form). */
  issuers(doc: Discovery): string[] {
    return doc.issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, "accounts.google.com"] : [doc.issuer];
  }

  private async getJson(url: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      // OAuth error responses carry only an error code and description, never tokens.
      const detail =
        body && typeof body.error === "string" ? `: ${body.error}${typeof body.error_description === "string" ? ` (${body.error_description})` : ""}` : "";
      throw new OidcError("oidc_failed", `${new URL(url).origin}${new URL(url).pathname} answered HTTP ${res.status}${detail}`);
    }
    if (!body || typeof body !== "object") throw new OidcError("oidc_failed", `${new URL(url).origin}${new URL(url).pathname} did not return JSON`);
    return body;
  }

  async getDiscovery(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < this.cacheMs) return this.discovery.doc;
    const doc = await this.getJson(`${this.config.issuer}/.well-known/openid-configuration`);
    if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== this.config.issuer)
      throw new OidcError("oidc_misconfigured", `discovery issuer ${String(doc.issuer)} does not match DATACAT_OIDC_ISSUER ${this.config.issuer}`);
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      try {
        httpsOrLocal(String(doc[k]), k);
      } catch (e) {
        throw new OidcError("oidc_misconfigured", `discovery document: ${(e as Error).message}`);
      }
    }
    this.discovery = { doc, at: this.now() };
    return doc;
  }

  private async loadKeys(): Promise<void> {
    const { jwks_uri } = await this.getDiscovery();
    const jwks = await this.getJson(jwks_uri);
    const byKid = new Map<string, KeyObject>();
    const all: KeyObject[] = [];
    for (const jwk of Array.isArray(jwks.keys) ? jwks.keys : []) {
      if (jwk?.kty !== "RSA" || (jwk.use !== undefined && jwk.use !== "sig") || (jwk.alg !== undefined && jwk.alg !== "RS256")) continue;
      try {
        const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
        all.push(key);
        if (typeof jwk.kid === "string") byKid.set(jwk.kid, key);
      } catch {
        /* skip malformed keys */
      }
    }
    this.keys = { byKid, all, at: this.now() };
  }

  /** Signing key by id, from cached keys; an unknown id refetches the key set (rate-limited) to follow rotation. */
  async getKey(kid: string | undefined): Promise<KeyObject | null> {
    const find = () => {
      if (!this.keys) return null;
      if (kid !== undefined) return this.keys.byKid.get(kid) ?? null;
      return this.keys.all.length === 1 ? this.keys.all[0] : null;
    };
    const stale = !this.keys || this.now() - this.keys.at >= this.cacheMs;
    const canRefresh = !this.keys || this.now() - this.keys.at >= this.refreshMs;
    if (stale || (!find() && canRefresh)) {
      this.keysPending ??= this.loadKeys().finally(() => (this.keysPending = null));
      await this.keysPending;
    }
    return find();
  }

  /** The provider's authorization URL for a new login state. */
  async authorizationUrl(s: LoginState, redirectUri: string): Promise<string> {
    const doc = await this.getDiscovery();
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.config.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", s.state);
    u.searchParams.set("nonce", s.nonce);
    u.searchParams.set("code_challenge", pkceChallenge(s.verifier));
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("prompt", "select_account");
    // Google's hosted-domain hint only narrows the account chooser; the hd claim is verified after sign-in.
    if (this.config.allowedDomains.length === 1) u.searchParams.set("hd", this.config.allowedDomains[0]);
    return u.toString();
  }

  /** Exchanges an authorization code and returns the verified ID token claims. */
  async exchangeCode(code: string, s: LoginState, redirectUri: string): Promise<IdTokenClaims> {
    const doc = await this.getDiscovery();
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: s.verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const methods = doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (methods.includes("client_secret_basic") || !methods.includes("client_secret_post")) {
      // RFC 6749 section 2.3.1: form-encode the id and secret before Basic encoding.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(this.config.clientId)}:${enc(this.config.clientSecret)}`).toString("base64")}`;
    } else {
      form.set("client_id", this.config.clientId);
      form.set("client_secret", this.config.clientSecret);
    }
    const tokens = await this.getJson(doc.token_endpoint, { method: "POST", headers, body: form.toString() });
    if (typeof tokens.id_token !== "string") throw new OidcError("oidc_failed", "token response has no id_token");
    return this.verify(tokens.id_token, s.nonce);
  }

  async verify(idToken: string, nonce: string): Promise<IdTokenClaims> {
    const doc = await this.getDiscovery();
    return verifyIdToken(idToken, {
      issuers: this.issuers(doc),
      clientId: this.config.clientId,
      nonce,
      getKey: (kid) => this.getKey(kid),
      now: Math.floor(this.now() / 1000),
    });
  }
}
