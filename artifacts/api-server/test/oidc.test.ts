import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  OidcError,
  OidcProvider,
  authorizeClaims,
  loadOidcConfig,
  newLoginState,
  openState,
  pkceChallenge,
  sealState,
  stateKey,
  type IdTokenClaims,
  type OidcConfig,
} from "../src/lib/oidc";

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "client-123.apps.example.test";
const NOW = 1_800_000_000;

const key1 = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const key2 = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (k: crypto.KeyPairKeyObjectResult, kid: string) => ({ ...k.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function sign(claims: Record<string, unknown>, opts: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}) {
  const head = enc({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? key1.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: "1234567890",
  iat: NOW - 10,
  exp: NOW + 3600,
  nonce: "the-nonce",
  email: "alice@v4company.com",
  email_verified: true,
  hd: "v4company.com",
  given_name: "Alice",
  family_name: "Doe",
  picture: "https://example.test/a.png",
  ...over,
});

const config: OidcConfig = {
  clientId: CLIENT_ID,
  clientSecret: "s3cret value",
  issuer: ISSUER,
  allowedDomains: ["v4company.com"],
  defaultRole: "member",
  label: "Google",
  orgId: null,
  requireHostedDomain: false,
};

/** A provider whose discovery, JWKS and token endpoints answer from memory; `calls` records requests by path. */
function mockProvider(
  opts: { keys?: () => object[]; tokenResponse?: (body: URLSearchParams, headers: Record<string, string>) => object; cfg?: Partial<OidcConfig> } = {},
) {
  const calls: { path: string; init?: RequestInit }[] = [];
  let now = NOW * 1000;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path === "/.well-known/openid-configuration")
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    if (path === "/jwks") return json({ keys: opts.keys ? opts.keys() : [jwk(key1, "k1")] });
    if (path === "/token") {
      const out = opts.tokenResponse?.(new URLSearchParams(String(init?.body)), init?.headers as Record<string, string>);
      return out ? json(out) : json({ error: "invalid_grant" }, 400);
    }
    return json({}, 404);
  };
  const provider = new OidcProvider({ ...config, ...opts.cfg }, { fetch, now: () => now });
  return { provider, calls, advance: (ms: number) => (now += ms) };
}

const rejects = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof OidcError && e.code === "oidc_failed" && re.test(e.message));

test("OIDC config: off by default, refuses to start without an allowlist or with unsafe values", () => {
  assert.equal(loadOidcConfig({}), null);
  const base = { DATACAT_OIDC_CLIENT_ID: "id", DATACAT_OIDC_CLIENT_SECRET: "secret" };
  assert.throws(() => loadOidcConfig(base), /DATACAT_OIDC_ALLOWED_DOMAINS is required/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: " , " }), /DATACAT_OIDC_ALLOWED_DOMAINS is required/);
  assert.throws(() => loadOidcConfig({ DATACAT_OIDC_CLIENT_ID: "id", DATACAT_OIDC_ALLOWED_DOMAINS: "a.com" }), /Set both/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: "*.example.com" }), /not a domain name/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: "*" }), /not a domain name/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: "a.com", DATACAT_OIDC_DEFAULT_ROLE: "owner" }), /must be one of: admin, member/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: "a.com", DATACAT_OIDC_ISSUER: "http://idp.example.com" }), /https/);
  assert.throws(() => loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: "a.com", DATACAT_OIDC_ORG_ID: "abc" }), /DATACAT_OIDC_ORG_ID/);
  assert.deepEqual(loadOidcConfig({ ...base, DATACAT_OIDC_ALLOWED_DOMAINS: " V4Company.com, @other.org ,v4company.com" }), {
    clientId: "id",
    clientSecret: "secret",
    issuer: "https://accounts.google.com",
    allowedDomains: ["v4company.com", "other.org"],
    defaultRole: "member",
    label: "Google",
    orgId: null,
    requireHostedDomain: true,
  });
  const custom = loadOidcConfig({
    ...base,
    DATACAT_OIDC_ALLOWED_DOMAINS: "a.com",
    DATACAT_OIDC_ISSUER: "https://login.example.com/realms/x/",
    DATACAT_OIDC_DEFAULT_ROLE: "Admin",
    DATACAT_OIDC_LABEL: "Okta",
    DATACAT_OIDC_ORG_ID: "7",
  });
  assert.equal(custom?.issuer, "https://login.example.com/realms/x");
  assert.equal(custom?.defaultRole, "admin");
  assert.equal(custom?.label, "Okta");
  assert.equal(custom?.orgId, 7);
  assert.equal(custom?.requireHostedDomain, false);
});

test("OIDC allowlist: exact, case-insensitive email domain; hd must also be allowed when present", () => {
  const allowed = { allowedDomains: ["v4company.com"], requireHostedDomain: true };
  const ok = authorizeClaims(claims({ email: "Alice@V4Company.COM", hd: "V4COMPANY.com" }) as IdTokenClaims, allowed);
  assert.deepEqual(ok, { email: "alice@v4company.com", firstName: "Alice", lastName: "Doe", profileImageUrl: "https://example.test/a.png" });
  // without requireHostedDomain (e.g. a non-Google provider), no hd claim is fine when the email domain is allowed
  assert.equal(authorizeClaims(claims({ hd: undefined }) as IdTokenClaims, { ...allowed, requireHostedDomain: false }).email, "alice@v4company.com");
  const refused = (over: Record<string, unknown>, code: string) =>
    assert.throws(
      () => authorizeClaims(claims(over) as IdTokenClaims, allowed),
      (e: unknown) => e instanceof OidcError && e.code === code,
      JSON.stringify(over),
    );
  refused({ email: "mallory@gmail.com", hd: undefined }, "oidc_domain_not_allowed");
  refused({ email: "bob@eng.v4company.com", hd: "eng.v4company.com" }, "oidc_domain_not_allowed"); // subdomain
  refused({ email: "bob@eng.v4company.com", hd: undefined }, "oidc_domain_not_allowed");
  refused({ email: "bob@evilv4company.com", hd: undefined }, "oidc_domain_not_allowed"); // look-alike suffix
  refused({ email: "bob@v4company.com.evil.test", hd: undefined }, "oidc_domain_not_allowed");
  refused({ hd: "other.com" }, "oidc_domain_not_allowed"); // allowed email, foreign hosted domain
  refused({ hd: 42 }, "oidc_domain_not_allowed");
  refused({ email_verified: false }, "oidc_email_unverified");
  refused({ email_verified: "true" }, "oidc_email_unverified");
  refused({ email_verified: undefined }, "oidc_email_unverified");
  refused({ email: undefined }, "oidc_failed");
  refused({ email: "a@b@v4company.com" }, "oidc_failed");
  refused({ hd: undefined }, "oidc_domain_not_allowed"); // hd required
  refused({ hd: "" }, "oidc_domain_not_allowed");
  // names fall back sensibly; non-https pictures are dropped
  const p = authorizeClaims(
    claims({ given_name: undefined, family_name: undefined, name: undefined, picture: "javascript:alert(1)" }) as IdTokenClaims,
    allowed,
  );
  assert.deepEqual([p.firstName, p.lastName, p.profileImageUrl], ["alice", null, null]);
});

test("OIDC hosted domain: required by default for Google only; DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN overrides it", () => {
  const base = { DATACAT_OIDC_CLIENT_ID: "id", DATACAT_OIDC_CLIENT_SECRET: "secret", DATACAT_OIDC_ALLOWED_DOMAINS: "v4company.com" };
  const load = (env: Record<string, string> = {}) => loadOidcConfig({ ...base, ...env })!;
  // a consumer Google account registered with a work address: verified email at an allowed domain, but no hd
  const consumer = claims({ iss: "https://accounts.google.com", hd: undefined }) as IdTokenClaims;
  const google = load();
  assert.equal(google.requireHostedDomain, true);
  assert.throws(
    () => authorizeClaims(consumer, google),
    (e: unknown) => e instanceof OidcError && e.code === "oidc_domain_not_allowed" && /hd\) claim is required/.test(e.message),
  );
  assert.equal(authorizeClaims(claims() as IdTokenClaims, google).email, "alice@v4company.com"); // Workspace account
  // other providers do not send hd: not required by default
  const other = load({ DATACAT_OIDC_ISSUER: "https://login.example.com/realms/main" });
  assert.equal(other.requireHostedDomain, false);
  assert.equal(authorizeClaims(claims({ hd: undefined }) as IdTokenClaims, other).email, "alice@v4company.com");
  // explicit values win in both directions
  for (const v of ["false", "0", " FALSE "])
    assert.equal(authorizeClaims(consumer, load({ DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN: v })).email, "alice@v4company.com", v);
  for (const v of ["true", "1", "True"])
    assert.equal(load({ DATACAT_OIDC_ISSUER: "https://login.example.com", DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN: v }).requireHostedDomain, true, v);
  assert.equal(load({ DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN: "" }).requireHostedDomain, true);
  for (const v of ["yes", "no", "on", "2", "truthy"])
    assert.throws(() => load({ DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN: v }), /DATACAT_OIDC_REQUIRE_HOSTED_DOMAIN must be true, false, 1 or 0/, v);
});

test("OIDC ID token: a valid token is accepted, including Google's scheme-less issuer", async () => {
  const { provider } = mockProvider();
  const c = await provider.verify(sign(claims()), "the-nonce");
  assert.equal(c.email, "alice@v4company.com");
  assert.equal(c.sub, "1234567890");
  // multiple audiences are fine when azp is this client
  await provider.verify(sign(claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID })), "the-nonce");
  // small clock skew is tolerated
  await provider.verify(sign(claims({ iat: NOW + 30, exp: NOW - 30 })), "the-nonce");

  const fetchGoogle = (url: string, init?: RequestInit) =>
    url.endsWith("/.well-known/openid-configuration")
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: "https://accounts.google.com",
              authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
              token_endpoint: "https://oauth2.googleapis.com/token",
              jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
            }),
          ),
        )
      : Promise.resolve(new Response(JSON.stringify({ keys: [jwk(key1, "k1")] })));
  const g = new OidcProvider({ ...config, issuer: "https://accounts.google.com" }, { fetch: fetchGoogle, now: () => NOW * 1000 });
  for (const iss of ["https://accounts.google.com", "accounts.google.com"]) assert.equal((await g.verify(sign(claims({ iss })), "the-nonce")).iss, iss);
  await rejects(g.verify(sign(claims({ iss: "http://accounts.google.com" })), "the-nonce"), /wrong issuer/);
});

test("OIDC ID token: bad signature, wrong iss/aud/azp, expiry, nonce and algorithm are rejected", async () => {
  const { provider } = mockProvider();
  const nonce = "the-nonce";
  await rejects(provider.verify(sign(claims(), { key: key2.privateKey }), nonce), /bad signature/);
  const [h, , s] = sign(claims()).split(".");
  await rejects(provider.verify(`${h}.${enc(claims({ email: "ceo@v4company.com" }))}.${s}`, nonce), /bad signature/);
  await rejects(provider.verify(sign(claims({ iss: "https://evil.example.test" })), nonce), /wrong issuer/);
  await rejects(provider.verify(sign(claims({ iss: undefined })), nonce), /wrong issuer/);
  await rejects(provider.verify(sign(claims({ aud: "someone-else" })), nonce), /wrong audience/);
  await rejects(provider.verify(sign(claims({ aud: ["someone-else", "another"] })), nonce), /wrong audience/);
  await rejects(provider.verify(sign(claims({ aud: [CLIENT_ID, "other"], azp: undefined })), nonce), /authorized party/);
  await rejects(provider.verify(sign(claims({ azp: "other" })), nonce), /authorized party/);
  await rejects(provider.verify(sign(claims({ exp: NOW - 120 })), nonce), /expired/);
  await rejects(provider.verify(sign(claims({ exp: undefined })), nonce), /expired/);
  await rejects(provider.verify(sign(claims({ iat: NOW + 600 })), nonce), /future/);
  await rejects(provider.verify(sign(claims({ nbf: NOW + 600 })), nonce), /not yet valid/);
  await rejects(provider.verify(sign(claims()), "another-nonce"), /nonce mismatch/);
  await rejects(provider.verify(sign(claims({ nonce: undefined })), nonce), /nonce mismatch/);
  await rejects(provider.verify(sign(claims(), { kid: "unknown" }), nonce), /key not found/);
  // "none" and HMAC tokens are refused before any key is used
  await rejects(provider.verify(`${enc({ alg: "none" })}.${enc(claims())}.`, nonce), /malformed|unsupported algorithm/);
  await rejects(provider.verify(`${enc({ alg: "none", kid: "k1" })}.${enc(claims())}.AA`, nonce), /unsupported algorithm none/);
  const hs = (() => {
    const head = enc({ alg: "HS256", kid: "k1" });
    const body = enc(claims());
    return `${head}.${body}.${crypto.createHmac("sha256", "x").update(`${head}.${body}`).digest("base64url")}`;
  })();
  await rejects(provider.verify(hs, nonce), /unsupported algorithm HS256/);
  await rejects(provider.verify("not-a-jwt", nonce), /malformed/);
  await rejects(provider.verify(`${enc([1])}.${enc(claims())}.AA`, nonce), /malformed/);
});

test("OIDC keys: cached, refetched on an unknown kid (rate-limited) and after the cache expires", async () => {
  let keys = [jwk(key1, "k1")];
  const { provider, calls, advance } = mockProvider({ keys: () => keys });
  const jwksCalls = () => calls.filter((c) => c.path === "/jwks").length;
  await provider.verify(sign(claims()), "the-nonce");
  await provider.verify(sign(claims()), "the-nonce");
  assert.equal(jwksCalls(), 1);
  assert.equal(calls.filter((c) => c.path === "/.well-known/openid-configuration").length, 1);
  // the provider rotates keys: an unknown kid is refetched once a minute at most
  keys = [jwk(key1, "k1"), jwk(key2, "k2")];
  await rejects(provider.verify(sign(claims(), { key: key2.privateKey, kid: "k2" }), "the-nonce"), /key not found/);
  assert.equal(jwksCalls(), 1);
  advance(61_000);
  await provider.verify(sign(claims(), { key: key2.privateKey, kid: "k2" }), "the-nonce");
  assert.equal(jwksCalls(), 2);
  await rejects(provider.verify(sign(claims(), { kid: "k3" }), "the-nonce"), /key not found/);
  assert.equal(jwksCalls(), 2);
  // after the cache lifetime, keys (and discovery) are fetched again
  advance(60 * 60 * 1000);
  await provider.verify(sign(claims({ iat: NOW + 3660, exp: NOW + 7200 })), "the-nonce");
  assert.equal(jwksCalls(), 3);
  // keys that are not RSA signing keys are ignored
  const odd = mockProvider({ keys: () => [{ ...jwk(key1, "k1"), use: "enc" }] });
  await rejects(odd.provider.verify(sign(claims()), "the-nonce"), /key not found/);
});

test("OIDC authorization URL: PKCE S256, nonce, state, scopes and a hosted-domain hint for one domain", async () => {
  const { provider } = mockProvider();
  const login = newLoginState("/dashboards", NOW * 1000);
  const u = new URL(await provider.authorizationUrl(login, "https://datacat.example.test/api/auth/oidc/callback"));
  assert.equal(u.origin + u.pathname, `${ISSUER}/authorize`);
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.response_type, "code");
  assert.equal(p.client_id, CLIENT_ID);
  assert.equal(p.redirect_uri, "https://datacat.example.test/api/auth/oidc/callback");
  assert.equal(p.scope, "openid email profile");
  assert.equal(p.prompt, "select_account");
  assert.equal(p.state, login.state);
  assert.equal(p.nonce, login.nonce);
  assert.equal(p.code_challenge_method, "S256");
  assert.equal(p.code_challenge, crypto.createHash("sha256").update(login.verifier).digest("base64url"));
  assert.equal(p.code_challenge, pkceChallenge(login.verifier));
  assert.equal(p.hd, "v4company.com");
  assert.ok(!u.searchParams.has("client_secret"));
  // RFC 7636 test vector
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const two = mockProvider({ cfg: { allowedDomains: ["a.com", "b.com"] } });
  assert.ok(!new URL(await two.provider.authorizationUrl(login, "https://x.test/cb")).searchParams.has("hd"));
});

test("OIDC code exchange: sends the verifier and client credentials, verifies the returned ID token", async () => {
  const login = newLoginState("/", NOW * 1000);
  let sent: { body: URLSearchParams; headers: Record<string, string> } | null = null;
  const { provider } = mockProvider({
    tokenResponse: (body, headers) => {
      sent = { body, headers };
      return body.get("code") === "good-code" ? { access_token: "at", token_type: "Bearer", id_token: sign(claims({ nonce: login.nonce })) } : null!;
    },
  });
  const c = await provider.exchangeCode("good-code", login, "https://datacat.example.test/api/auth/oidc/callback");
  assert.equal(c.email, "alice@v4company.com");
  assert.ok(sent);
  const { body, headers } = sent as { body: URLSearchParams; headers: Record<string, string> };
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code_verifier"), login.verifier);
  assert.equal(body.get("redirect_uri"), "https://datacat.example.test/api/auth/oidc/callback");
  assert.equal(body.get("client_secret"), null);
  assert.equal(headers.authorization, `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:s3cret+value`).toString("base64")}`);
  // provider errors are reported without the response body's tokens; a token for another login's nonce is refused
  await assert.rejects(
    provider.exchangeCode("bad-code", login, "https://x.test/cb"),
    (e: unknown) => e instanceof OidcError && /HTTP 400: invalid_grant/.test(e.message),
  );
  const other = newLoginState("/", NOW * 1000);
  await rejects(provider.exchangeCode("good-code", other, "https://x.test/cb"), /nonce mismatch/);
});

test("OIDC discovery must name the configured issuer", async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({ issuer: "https://evil.example.test", authorization_endpoint: "https://e/a", token_endpoint: "https://e/t", jwks_uri: "https://e/k" }),
    );
  const p = new OidcProvider(config, { fetch });
  await assert.rejects(p.authorizationUrl(newLoginState("/"), "https://x.test/cb"), (e: unknown) => e instanceof OidcError && e.code === "oidc_misconfigured");
});

test("OIDC state cookie: encrypted, tamper-proof and short-lived", () => {
  const key = stateKey("a".repeat(32));
  const login = newLoginState("/logs?q=1", NOW * 1000);
  const sealed = sealState(login, key);
  for (const secret of [login.state, login.nonce, login.verifier, "/logs"])
    assert.ok(!sealed.includes(secret) && !Buffer.from(sealed, "base64url").toString("latin1").includes(secret));
  assert.deepEqual(openState(sealed, key, NOW * 1000), login);
  // flipping any byte, a different SESSION_SECRET, expiry and junk all fail closed
  const raw = Buffer.from(sealed, "base64url");
  for (const i of [0, 13, 30, raw.length - 1]) {
    const t = Buffer.from(raw);
    t[i] ^= 1;
    assert.equal(openState(t.toString("base64url"), key, NOW * 1000), null, `byte ${i}`);
  }
  assert.equal(openState(sealed, stateKey("b".repeat(32)), NOW * 1000), null);
  assert.equal(openState(sealed, key, NOW * 1000 + 10 * 60 * 1000 + 1), null);
  for (const junk of [undefined, "", "abc", 42, "x".repeat(5000)]) assert.equal(openState(junk, key, NOW * 1000), null);
});
