import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import {
  MAX_MCP_TOKENS_PER_USER,
  bearerToken,
  mcpTokenName,
  newMcpToken,
  orgForMcpToken,
  type McpTokenOwner,
  type McpTokenRow,
  type McpTokenStore,
} from "../src/lib/mcpTokens";
import { MCP_INTERNAL_HEADERS, internalCredentialHeaders, internalOrgId, isReadOnlyRequest } from "../src/lib/mcpInternal";
import { mcpTokensRouter } from "../src/routes/mcpTokens";
import { authMiddleware, requireAdmin, requireAdminOrKeys, requireOrg } from "../src/middlewares/authMiddleware";
import { orgKeyList } from "../src/routes/resources";
import { TOOLS } from "../src/lib/mcpTools";

/** In-memory api_keys rows of kind mcp, plus each user's current organization. */
class FakeStore implements McpTokenStore {
  rows: (McpTokenRow & { key: string; userId: string; orgId: number; revoked: boolean })[] = [];
  members = new Map<string, number>();
  touched: number[] = [];

  /** Ids differ between stores because orgForMcpToken throttles last_used_at writes per token id, process-wide. */
  constructor(private nextId = 1) {}

  async list(owner: McpTokenOwner) {
    return this.rows
      .filter((r) => r.userId === owner.userId && r.orgId === owner.orgId && !r.revoked)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  }
  async create(owner: McpTokenOwner, name: string, token: string) {
    const row = { id: this.nextId++, name, key: token, userId: owner.userId, orgId: owner.orgId, revoked: false, createdAt: new Date(), lastUsedAt: null };
    this.rows.push(row);
    return row;
  }
  async revoke(owner: McpTokenOwner, id: number) {
    const row = this.rows.find((r) => r.id === id && r.userId === owner.userId && r.orgId === owner.orgId && !r.revoked);
    if (!row) return false;
    row.revoked = true;
    return true;
  }
  async find(token: string) {
    const row = this.rows.find((r) => r.key === token);
    return row ? { id: row.id, orgId: row.orgId, userId: row.userId, revoked: row.revoked } : null;
  }
  async userOrg(userId: string) {
    return this.members.get(userId) ?? null;
  }
  async touch(id: number) {
    this.touched.push(id);
  }
}

const store = new FakeStore();

// The real authMiddleware needs the database for sessions and keys; this one sets the same request fields from test headers.
function fakeAuth(req: Request, _res: Response, next: NextFunction) {
  const user = req.get("x-test-user");
  if (user) {
    const orgId = Number(req.get("x-test-org") ?? 1);
    const profile = { id: user, email: `${user}@example.com`, firstName: null, lastName: null, profileImageUrl: null };
    req.sessionUser = profile;
    req.authUser = { ...profile, orgId, orgName: "Org", role: req.get("x-test-role") ?? "member" };
    req.orgId = orgId;
  }
  if (req.get("x-test-keys")) {
    req.orgId = 1;
    req.viaKeys = true;
  }
  if (req.get("x-test-mcp")) {
    req.orgId = 1;
    req.viaMcp = true;
  }
  next();
}

/** Real authMiddleware with routes guarded the way resources.ts and telemetry.ts guard them. */
function guardedRoutes(): Router {
  const r = Router();
  const echo = (req: Request, res: Response) =>
    res.json({ orgId: req.orgId ?? null, viaMcp: !!req.viaMcp, viaKeys: !!req.viaKeys, sawSecret: req.get(MCP_INTERNAL_HEADERS.secret) ?? null });
  r.get("/ui/read", requireOrg, echo);
  r.post("/ui/logs/search", requireOrg, echo);
  r.post("/v1/dashboard", requireOrg, echo);
  r.delete("/v1/dashboard/:id", requireOrg, echo);
  r.get("/ui/admin-only", requireOrg, requireAdmin, echo);
  r.get("/v1/integration/webhooks/configuration/webhooks", requireAdminOrKeys, echo);
  r.post("/v1/integration/webhooks/configuration/webhooks", requireAdminOrKeys, echo);
  r.use(mcpTokensRouter(store));
  return r;
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", fakeAuth, mcpTokensRouter(store));
  app.use("/real", authMiddleware, guardedRoutes());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}
const as = (user: string, org = 1) => ({ "x-test-user": user, "x-test-org": String(org) });

test("tokens: create returns the value once, list never returns it, newest first", async () => {
  const a = await call("POST", "/api/ui/mcp/tokens", as("alice"), { name: "  Laptop  " });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(Object.keys(a.json).sort(), ["created_at", "id", "name", "token"]);
  assert.equal(a.json.name, "Laptop");
  assert.match(a.json.token, /^dcmcp_[0-9a-f]{48}$/);
  assert.ok(a.json.token.length <= 64);
  assert.ok(!Number.isNaN(Date.parse(a.json.created_at)));
  const b = await call("POST", "/api/ui/mcp/tokens", as("alice"), {});
  assert.equal(b.json.name, "MCP token");

  const list = await call("GET", "/api/ui/mcp/tokens", as("alice"));
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.tokens.map((t: { id: number }) => t.id),
    [b.json.id, a.json.id],
  );
  assert.deepEqual(Object.keys(list.json.tokens[0]).sort(), ["created_at", "id", "last_used_at", "name"]);
  assert.equal(list.json.tokens[0].last_used_at, null);
  assert.ok(!list.text.includes(a.json.token) && !list.text.includes(b.json.token), "token values are never listed");
  assert.ok(!list.text.includes("dcmcp_"));
});

test("tokens: each user sees and revokes only their own", async () => {
  const mine = await call("POST", "/api/ui/mcp/tokens", as("bob"), { name: "bob" });
  assert.equal((await call("GET", "/api/ui/mcp/tokens", as("carol"))).json.tokens.length, 0);
  assert.equal((await call("GET", "/api/ui/mcp/tokens", as("bob", 2))).json.tokens.length, 0, "same user id in another org");
  const foreign = await call("DELETE", `/api/ui/mcp/tokens/${mine.json.id}`, as("carol"));
  assert.equal(foreign.status, 404);
  assert.equal((await call("DELETE", `/api/ui/mcp/tokens/${mine.json.id}`, as("bob"))).json.ok, true);
  assert.equal((await call("DELETE", `/api/ui/mcp/tokens/${mine.json.id}`, as("bob"))).status, 404, "already revoked");
  assert.equal((await call("GET", "/api/ui/mcp/tokens", as("bob"))).json.tokens.length, 0);
  for (const id of ["abc", "1.5", "-1", "99999999999"]) assert.equal((await call("DELETE", `/api/ui/mcp/tokens/${id}`, as("bob"))).status, 404, id);
});

test("tokens: name is trimmed, 1-60 characters, defaults when blank", async () => {
  assert.equal(mcpTokenName(undefined), "MCP token");
  assert.equal(mcpTokenName(null), "MCP token");
  assert.equal(mcpTokenName("   "), "MCP token");
  assert.equal(mcpTokenName(" x "), "x");
  assert.equal(mcpTokenName("n".repeat(60)), "n".repeat(60));
  assert.throws(() => mcpTokenName("n".repeat(61)), /1-60 characters/);
  assert.throws(() => mcpTokenName(5), /must be a string/);
  assert.throws(() => mcpTokenName("a\nb"), /control characters/);
  const long = await call("POST", "/api/ui/mcp/tokens", as("dave"), { name: "n".repeat(61) });
  assert.equal(long.status, 400);
  assert.match(long.json.errors[0], /1-60 characters/);
  assert.equal((await call("POST", "/api/ui/mcp/tokens", as("dave"), { name: ["x"] })).status, 400);
  assert.equal((await call("GET", "/api/ui/mcp/tokens", as("dave"))).json.tokens.length, 0);
});

test("tokens: at most 10 active per user; revoking frees a slot", async () => {
  const ids: number[] = [];
  for (let i = 0; i < MAX_MCP_TOKENS_PER_USER; i++) ids.push((await call("POST", "/api/ui/mcp/tokens", as("erin"), { name: `t${i}` })).json.id);
  const over = await call("POST", "/api/ui/mcp/tokens", as("erin"), { name: "one more" });
  assert.equal(over.status, 400);
  assert.match(over.json.errors[0], /10 MCP tokens/);
  assert.equal((await call("POST", "/api/ui/mcp/tokens", as("frank"), {})).status, 200, "the cap is per user");
  await call("DELETE", `/api/ui/mcp/tokens/${ids[0]}`, as("erin"));
  assert.equal((await call("POST", "/api/ui/mcp/tokens", as("erin"), {})).status, 200);
});

test("tokens and info: signed-in users only, never key pairs, MCP calls or anonymous callers", async () => {
  for (const [method, path] of [
    ["GET", "/api/ui/mcp/tokens"],
    ["POST", "/api/ui/mcp/tokens"],
    ["DELETE", "/api/ui/mcp/tokens/1"],
    ["GET", "/api/ui/mcp/info"],
  ]) {
    assert.equal((await call(method, path, {}, method === "POST" ? {} : undefined)).status, 401, `${method} ${path} anonymous`);
    assert.equal((await call(method, path, { "x-test-keys": "1" }, method === "POST" ? {} : undefined)).status, 403, `${method} ${path} keys`);
    assert.equal((await call(method, path, { "x-test-mcp": "1" }, method === "POST" ? {} : undefined)).status, 403, `${method} ${path} mcp`);
  }
  const before = store.rows.length;
  await call("POST", "/api/ui/mcp/tokens", { "x-test-keys": "1" }, {});
  assert.equal(store.rows.length, before);
});

test("tokens: a cookie-session write from another origin is refused before anything else (real authMiddleware)", async () => {
  const r = await call("POST", "/real/ui/mcp/tokens", { cookie: "sid=abc", origin: "https://evil.example" }, {});
  assert.equal(r.status, 403);
  assert.match(r.text, /Invalid request origin/);
  const d = await call("DELETE", "/real/ui/mcp/tokens/1", { cookie: "sid=abc", "sec-fetch-site": "cross-site" });
  assert.equal(d.status, 403);
});

test("info: absolute MCP endpoint, server name and the tools/list names", async () => {
  const r = await call("GET", "/api/ui/mcp/info", as("alice"));
  assert.equal(r.status, 200);
  assert.equal(r.json.endpoint, `${base}/api/mcp`);
  assert.equal(r.json.server_name, "datacat");
  assert.deepEqual(
    r.json.tools,
    TOOLS.map((t) => ({ name: t.name, description: t.description })),
  );
});

test("bearer: parses Authorization: Bearer only", () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer dcmcp_x"), "dcmcp_x");
  assert.equal(bearerToken("bearer   dcmcp_x  "), "dcmcp_x");
  assert.equal(bearerToken("Bearer"), "");
});

test("bearer: valid tokens map to their org; unknown, malformed, revoked and removed-member tokens do not", async () => {
  const s = new FakeStore(1000);
  const owner = { userId: "u1", orgId: 1 };
  s.members.set("u1", 1);
  const good = await s.create(owner, "t", newMcpToken());
  assert.equal(await orgForMcpToken(good.key, s), 1);
  assert.equal(await orgForMcpToken(newMcpToken(), s), null, "unknown");
  assert.equal(await orgForMcpToken("dcmcp_short", s), null, "malformed");
  assert.equal(await orgForMcpToken("", s), null);

  const revoked = await s.create(owner, "t", newMcpToken());
  await s.revoke(owner, revoked.id);
  assert.equal(await orgForMcpToken(revoked.key, s), null, "revoked");

  const moved = await s.create({ userId: "u2", orgId: 1 }, "t", newMcpToken());
  s.members.set("u2", 2);
  assert.equal(await orgForMcpToken(moved.key, s), null, "creator now belongs to another org");

  const gone = await s.create({ userId: "u3", orgId: 1 }, "t", newMcpToken());
  assert.equal(await orgForMcpToken(gone.key, s), null, "creator deleted or removed from the org");
});

test("bearer: last_used_at is written at most once a minute per token", async () => {
  const s = new FakeStore(2000);
  s.members.set("u9", 3);
  const t = await s.create({ userId: "u9", orgId: 3 }, "t", newMcpToken());
  await orgForMcpToken(t.key, s);
  await orgForMcpToken(t.key, s);
  await orgForMcpToken(t.key, s);
  assert.deepEqual(s.touched, [t.id]);
});

test("internal credential: accepted only with the process secret, a valid org id and a loopback socket", () => {
  const h = internalCredentialHeaders(7);
  const secret = h[MCP_INTERNAL_HEADERS.secret];
  assert.equal(secret.length, 64);
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(internalOrgId({ secret, org: "7", remoteAddress: addr }), 7, addr);
  for (const addr of ["10.0.0.5", "::ffff:10.0.0.5", "192.168.1.127", "fe80::1", undefined])
    assert.equal(internalOrgId({ secret, org: "7", remoteAddress: addr }), null, String(addr));
  for (const bad of [undefined, "", "x".repeat(64), secret.slice(1), `${secret}0`])
    assert.equal(internalOrgId({ secret: bad, org: "7", remoteAddress: "127.0.0.1" }), null);
  for (const org of [undefined, "", "0", "-1", "1.5", "abc", "99999999999", "7 "])
    assert.equal(internalOrgId({ secret, org, remoteAddress: "127.0.0.1" }), null, String(org));
});

test("internal credential: GET and the tools' read-only POSTs only", () => {
  assert.equal(isReadOnlyRequest("GET", "/v1/monitor"), true);
  assert.equal(isReadOnlyRequest("HEAD", "/v1/monitor"), true);
  for (const p of ["/ui/apm/spans", "/ui/metrics/query", "/ui/logs/search", "/v2/logs/analytics/aggregate"])
    assert.equal(isReadOnlyRequest("POST", p), true, p);
  for (const [m, p] of [
    ["POST", "/v1/dashboard"],
    ["POST", "/v1/monitor"],
    ["POST", "/ui/org/sample-data"],
    ["POST", "/mcp"],
    ["PUT", "/v1/dashboard/x"],
    ["DELETE", "/v1/monitor/1"],
    ["PATCH", "/ui/org"],
    ["POST", "/UI/LOGS/SEARCH"],
    ["POST", "/ui/logs/search/"],
  ])
    assert.equal(isReadOnlyRequest(m, p), false, `${m} ${p}`);
});

test("internal credential through the real authMiddleware: org reads work, every write is refused", async () => {
  const h = internalCredentialHeaders(7);
  const read = await call("GET", "/real/ui/read", h);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json, { orgId: 7, viaMcp: true, viaKeys: false, sawSecret: null });
  assert.equal((await call("POST", "/real/ui/logs/search", h, {})).status, 200);

  for (const [method, path] of [
    ["POST", "/real/v1/dashboard"],
    ["DELETE", "/real/v1/dashboard/abc"],
    ["POST", "/real/v1/integration/webhooks/configuration/webhooks"],
  ]) {
    const r = await call(method, path, h, method === "POST" ? {} : undefined);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.text, /read-only/);
  }
  assert.equal((await call("GET", "/real/ui/admin-only", h)).status, 403, "requireAdmin");
  assert.equal((await call("GET", "/real/v1/integration/webhooks/configuration/webhooks", h)).status, 403, "requireAdminOrKeys");
  assert.equal((await call("GET", "/real/ui/mcp/tokens", h)).status, 403, "MCP calls cannot manage tokens");
});

test("internal credential with a wrong secret is stripped and grants nothing", async () => {
  const forged = { [MCP_INTERNAL_HEADERS.secret]: "0".repeat(64), [MCP_INTERNAL_HEADERS.org]: "7", "x-forwarded-for": "127.0.0.1" };
  const r = await call("GET", "/real/ui/read", forged);
  assert.equal(r.status, 401);
  const w = await call("POST", "/real/v1/dashboard", forged, {});
  assert.equal(w.status, 401);
});

test("org settings key list: MCP tokens only for admins, labeled, with the owner and never the value", () => {
  const at = new Date("2026-11-19T00:00:00Z");
  const rows = [
    { id: 1, orgId: 1, name: "api", key: "a".repeat(32), kind: "api", createdBy: "u1", revoked: false, lastUsedAt: null, createdAt: at },
    { id: 2, orgId: 1, name: "app", key: "b".repeat(40), kind: "app", createdBy: "u1", revoked: false, lastUsedAt: null, createdAt: at },
    { id: 3, orgId: 1, name: "laptop", key: `dcmcp_${"c".repeat(48)}`, kind: "mcp", createdBy: "u2", revoked: false, lastUsedAt: at, createdAt: at },
    { id: 4, orgId: 1, name: "old", key: `dcmcp_${"d".repeat(48)}`, kind: "mcp", createdBy: "u2", revoked: true, lastUsedAt: null, createdAt: at },
  ];
  const admin = orgKeyList(rows, true);
  assert.deepEqual(
    admin.map((k) => [k.id, k.kind]),
    [
      [1, "api"],
      [2, "app"],
      [3, "mcp"],
    ],
  );
  const mcp = admin.find((k) => k.kind === "mcp");
  assert.equal(mcp?.key, undefined);
  assert.equal(mcp?.created_by, "u2");
  assert.ok(!JSON.stringify(admin).includes("c".repeat(8)));
  assert.equal(admin[0].key, "a".repeat(32), "admins still see API keys");
  assert.deepEqual(
    orgKeyList(rows, false).map((k) => k.kind),
    ["api", "app"],
  );
});
