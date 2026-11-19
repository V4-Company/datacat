import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { mcpRouter, mcpParseErrors } from "../src/routes/mcp";
import { handleMcpMessage, negotiateVersion } from "../src/lib/mcp";
import { TOOLS, capOutput, checkArgs, downsample, loopbackApi, loopbackBase, traceTree, MAX_OUTPUT_CHARS, type FetchLike } from "../src/lib/mcpTools";
import { MCP_INTERNAL_HEADERS, internalCredentialHeaders, isReadOnlyRequest } from "../src/lib/mcpInternal";
import { newMcpToken, type McpTokenStore } from "../src/lib/mcpTokens";

// The real authMiddleware needs the database; this one sets the same request fields from fixed test credentials.
function fakeAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.get("x-test-session")) {
    req.sessionUser = { id: 1 } as Request["sessionUser"];
    req.orgId = 1;
  }
  if (!req.orgId && req.get("dd-api-key") === "api-good" && req.get("dd-application-key") === "app-good") {
    req.orgId = 1;
    req.viaKeys = true;
  }
  next();
}

/** Loopback stub: records each API call and answers from `routes` by method + path. */
const calls: { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown }[] = [];
let routes: Record<string, (body: unknown) => { status?: number; json: unknown }> = {};
const stubFetch: FetchLike = async (url, init) => {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const method = init?.method ?? "GET";
  calls.push({ method, path: u.pathname, query: u.searchParams, headers: new Headers(init?.headers), body });
  const route = routes[`${method} ${u.pathname}`];
  const out = route ? route(body) : { status: 404, json: { errors: ["Not found"] } };
  return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
};

/** Personal MCP tokens: org 2's member u2 owns GOOD; REVOKED is revoked; MOVED's creator now belongs to org 3; GONE's creator was deleted. */
const GOOD = newMcpToken();
const REVOKED = newMcpToken();
const MOVED = newMcpToken();
const GONE = newMcpToken();
const tokenRows = new Map([
  [GOOD, { id: 1, orgId: 2, userId: "u2", revoked: false }],
  [REVOKED, { id: 2, orgId: 2, userId: "u2", revoked: true }],
  [MOVED, { id: 3, orgId: 2, userId: "u3", revoked: false }],
  [GONE, { id: 4, orgId: 2, userId: "deleted", revoked: false }],
]);
const memberships = new Map([
  ["u2", 2],
  ["u3", 3],
]);
const tokens: McpTokenStore = {
  list: async () => [],
  create: async () => {
    throw new Error("not used");
  },
  revoke: async () => false,
  find: async (token) => tokenRows.get(token) ?? null,
  userOrg: async (userId) => memberships.get(userId) ?? null,
  touch: async () => undefined,
};

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", fakeAuth, mcpRouter({ base: "http://datacat.test", fetch: stubFetch, tokens }));
  app.use("/api/mcp", mcpParseErrors);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const KEYS = { "dd-api-key": "api-good", "dd-application-key": "app-good" };
async function post(body: unknown, headers: Record<string, string> = KEYS) {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, res, text, json: text ? JSON.parse(text) : null };
}
let nextId = 1;
const rpc = (method: string, params?: unknown, headers?: Record<string, string>) => post({ jsonrpc: "2.0", id: nextId++, method, params }, headers);
async function callTool(name: string, args: unknown) {
  const r = await rpc("tools/call", { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  return r.json.result as { content: { type: string; text: string }[]; isError: boolean };
}

test("initialize: echoes a supported protocol version, else offers the latest; JSON response, no session", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(r.res.headers.get("mcp-session-id"), null);
  assert.equal(r.json.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.json.result.capabilities, { tools: {} });
  assert.equal(r.json.result.serverInfo.name, "datacat");
  assert.match(r.json.result.instructions, /now-15m/);
  assert.equal((await rpc("initialize", { protocolVersion: "2024-11-05" })).json.result.protocolVersion, "2024-11-05");
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, "2025-06-18");
  assert.equal(negotiateVersion(undefined), "2025-06-18");
  assert.deepEqual((await rpc("ping")).json.result, {});
});

test("tools/list: read-only tools with object schemas that refuse unknown arguments", async () => {
  const r = await rpc("tools/list");
  const tools = r.json.result.tools as { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[];
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "list_services",
      "get_service",
      "search_spans",
      "get_trace",
      "query_metrics",
      "search_metrics",
      "get_metric_tags",
      "search_logs",
      "aggregate_logs",
      "list_monitors",
      "list_dashboards",
      "get_dashboard",
    ],
  );
  for (const t of tools) {
    assert.ok(t.description.length > 20 && t.description.length < 600, t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(t.annotations.readOnlyHint, true);
  }
});

test("notifications and client responses get 202 with an empty body", async () => {
  const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(n.status, 202);
  assert.equal(n.text, "");
  const c = await post({ jsonrpc: "2.0", id: 9, result: {} });
  assert.equal(c.status, 202);
});

test("JSON-RPC errors: unknown method, unknown tool, parse error, invalid message, batch", async () => {
  const unknown = await rpc("resources/list");
  assert.equal(unknown.json.error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "drop_tables", arguments: {} })).json.error.code, -32602);
  const parse = await post("{not json");
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);
  assert.equal(parse.json.id, null);
  assert.equal((await post({ id: 1, method: "ping" })).json.error.code, -32600);
  assert.equal((await post({ jsonrpc: "2.0", id: {}, method: "ping" })).json.error.code, -32600);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping", params: [1] })).json.error.code, -32600);
  const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
  const version = await rpc("ping", undefined, { ...KEYS, "mcp-protocol-version": "1999-01-01" });
  assert.equal(version.status, 400);
});

test("GET and DELETE are 405 with Allow: POST", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${base}/api/mcp`, { method, headers: KEYS });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
  }
});

test("auth: keys required; no credentials 401, wrong keys 403, cookie session alone 401", async () => {
  const none = await rpc("ping", undefined, {});
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, -32600);
  assert.equal((await rpc("ping", undefined, { "dd-api-key": "api-good", "dd-application-key": "nope" })).status, 403);
  assert.equal((await rpc("ping", undefined, { "dd-api-key": "api-good" })).status, 403);
  assert.equal((await rpc("ping", undefined, { "x-test-session": "1" })).status, 401);
  assert.equal((await rpc("tools/list", undefined, {})).status, 401);
});

test("auth: personal MCP token as Authorization: Bearer; revoked, unknown and moved or removed members' tokens are 403", async () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  routes = { "GET /api/v1/monitor": () => ({ json: [] }) };
  calls.length = 0;
  const ok = await rpc("tools/call", { name: "list_monitors", arguments: {} }, bearer(GOOD));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.result.isError, false);
  assert.equal(calls[0].headers.get(MCP_INTERNAL_HEADERS.org), "2", "tools run in the token's organization");
  assert.equal(calls[0].headers.get("authorization"), null, "the token is not forwarded");
  for (const t of [REVOKED, MOVED, GONE, newMcpToken(), "not-a-token", ""]) {
    const r = await rpc("ping", undefined, bearer(t));
    assert.equal(r.status, 403, t);
    assert.equal(r.json.error.code, -32600);
    assert.match(r.json.error.message, /invalid or revoked MCP token/);
  }
  assert.equal((await rpc("ping", undefined, { ...bearer(GOOD), "x-test-session": "1" })).status, 200, "the token decides, not the cookie");
  assert.equal((await rpc("ping", undefined, { authorization: "Basic dXNlcjpwYXNz" })).status, 401);
  const evil = await rpc("ping", undefined, { ...bearer(GOOD), origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.match(evil.json.error.message, /origin/);
});

test("Origin: another site is refused; DataCat's own origin and no origin are accepted", async () => {
  const evil = await rpc("ping", undefined, { ...KEYS, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal((await rpc("ping", undefined, { ...KEYS, origin: base })).status, 200);
  assert.equal((await rpc("ping")).status, 200);
});

test("argument errors are tool results with isError, and no API call is made", async () => {
  calls.length = 0;
  const cases: [string, unknown, RegExp][] = [
    ["query_metrics", {}, /'query' is required/],
    ["query_metrics", { query: 5 }, /'query' must be a string/],
    ["search_logs", { limit: 1000 }, /between 1 and 200/],
    ["search_logs", { limit: 2.5 }, /integer/],
    ["search_logs", { sort: "sideways" }, /one of: desc, asc/],
    ["search_logs", { querry: "x" }, /Unknown argument 'querry'/],
    ["search_logs", { from: "yesterday" }, /Invalid time: yesterday/],
    ["search_logs", { from: "now", to: "now-1h" }, /'from' must be before 'to'/],
    ["search_logs", { from: true }, /string or a number/],
    ["aggregate_logs", { group_by: ["a", "b", "c"] }, /at most 2/],
    ["aggregate_logs", { group_by: "service" }, /must be a list/],
    ["get_trace", { trace_id: "../../v1/monitor" }, /invalid format/],
    ["get_dashboard", { id: "a/b" }, /invalid format/],
    ["list_monitors", "x", /must be an object/],
  ];
  for (const [name, args, re] of cases) {
    const r = await callTool(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, re);
  }
  assert.equal(calls.filter((c) => c.path !== "/api/ui/logs/search").length, 0);
  assert.throws(() => checkArgs(TOOLS[0].inputSchema, [1]), /object/);
});

test("time arguments: date math, ISO 8601 and epoch milliseconds reach the API as unix seconds", async () => {
  routes = { "POST /api/ui/logs/search": () => ({ json: { logs: [], total: 0, total_capped: false } }) };
  calls.length = 0;
  const now = Math.floor(Date.now() / 1000);
  await callTool("search_logs", { from: "now-15m" });
  await callTool("search_logs", { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" });
  await callTool("search_logs", { from: 1767225600000, to: 1767229200000 });
  await callTool("search_logs", {});
  const bodies = calls.map((c) => c.body as { from: number; to: number; limit: number; query: string });
  assert.equal(bodies[0].to - bodies[0].from, 900);
  assert.ok(Math.abs(bodies[0].to - now) <= 2);
  assert.deepEqual([bodies[1].from, bodies[1].to], [1767225600, 1767229200]);
  assert.deepEqual([bodies[2].from, bodies[2].to], [1767225600, 1767229200]);
  assert.equal(bodies[3].to - bodies[3].from, 3600);
  assert.equal(bodies[3].limit, 50);
  assert.equal(bodies[3].query, "*");
});

test("query_metrics: calls the metrics API with the internal read-only credential and summarizes each series", async () => {
  const points = Array.from({ length: 120 }, (_, i) => [1767225600000 + i * 60000, i + 1]);
  routes = {
    "POST /api/ui/metrics/query": () => ({
      json: {
        interval: 60,
        series: [
          { group: ["resource_name:GET /a"], pointlist: points },
          { group: [], pointlist: [] },
        ],
      },
    }),
  };
  calls.length = 0;
  const q = "sum:trace.web.request.hits{service:web} by {resource_name}.as_count()";
  const r = await callTool("query_metrics", { query: q, from: "now-2h", include_points: true });
  assert.equal(r.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("dd-api-key"), null, "the caller's keys are not forwarded");
  assert.equal(calls[0].headers.get("dd-application-key"), null);
  assert.equal(calls[0].headers.get(MCP_INTERNAL_HEADERS.secret), internalCredentialHeaders(1)[MCP_INTERNAL_HEADERS.secret]);
  assert.equal(calls[0].headers.get(MCP_INTERNAL_HEADERS.org), "1");
  assert.equal(calls[0].headers.get("cookie"), null);
  assert.deepEqual((calls[0].body as { queries: unknown }).queries, [{ name: "a", query: q }]);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.series_total, 2);
  const [s, empty] = out.series;
  assert.equal(s.group, "resource_name:GET /a");
  assert.deepEqual([s.points, s.min, s.avg, s.max, s.last], [120, 1, 60.5, 120, 120]);
  assert.equal(s.pointlist.length, 60);
  assert.deepEqual(s.pointlist[0], ["2026-01-01T00:00:00.000Z", 1.5]);
  assert.deepEqual([empty.group, empty.points, empty.last], ["*", 0, null]);
  assert.equal(
    downsample([
      [1, 1],
      [2, 2],
    ]).length,
    2,
  );
});

test("API errors and timeouts are tool errors with the API's message", async () => {
  routes = { "GET /api/v1/dashboard/abc-def-ghi": () => ({ status: 404, json: { errors: ["Dashboard not found"] } }) };
  const r = await callTool("get_dashboard", { id: "abc-def-ghi" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404: Dashboard not found/);
  const hang: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const api = loopbackApi({ base: "http://datacat.test", orgId: 1, fetch: hang, timeoutMs: 20 });
  const t = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_monitors", arguments: {} } }, api);
  const result = (t.body as { result: { isError: boolean; content: { text: string }[] } }).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not answer within 0 s/);
});

test("output is capped with a note on how to narrow the query", async () => {
  assert.equal(capOutput("short"), "short");
  const cut = capOutput("x".repeat(100), 10);
  assert.ok(cut.startsWith("x".repeat(10) + "\n"));
  assert.match(cut, /truncated at 10 of 100 characters: narrow the query/);
  routes = {
    "POST /api/ui/logs/search": () => ({
      json: {
        logs: Array.from({ length: 200 }, (_, i) => ({ id: i, ts: 1767225600000, status: "info", service: "web", message: "m".repeat(2000) })),
        total: 10000,
        total_capped: true,
      },
    }),
  };
  const r = await callTool("search_logs", { limit: 200 });
  const text = r.content[0].text;
  assert.ok(text.length < MAX_OUTPUT_CHARS + 300);
  assert.match(text, /output truncated/);
  assert.match(text, /"total":"10000\+"/);
  assert.ok(!text.includes("m".repeat(501)), "messages are cut at 500 characters");
});

test("get_trace prints spans as a tree by parent_id", () => {
  const ms = 1e6;
  const span = (id: string, parent: string, service: string, start: number, dur: number, error = 0) => ({
    span_id: id,
    parent_id: parent,
    service,
    name: "op",
    resource: `r${id}`,
    start: 1767225600000 * ms + start * ms,
    duration: dur * ms,
    error,
  });
  const text = traceTree(
    "abc",
    [span("1", "0", "web", 0, 100), span("2", "1", "api", 10, 50), span("3", "2", "db", 20, 5, 1), span("4", "99", "orphan", 30, 1)],
    [],
  );
  const lines = text.split("\n");
  assert.match(lines[0], /trace abc: 4 spans, 4 services .* 100 ms, 1 with errors/);
  assert.match(lines[1], /^- web op "r1" 100 ms @\+0 ms span_id=1$/);
  assert.match(lines[2], /^ {2}- api op "r2" 50 ms @\+10 ms/);
  assert.match(lines[3], /^ {4}- db op "r3" 5 ms @\+20 ms ERROR/);
  assert.match(lines[4], /^- orphan/);
});

test("the loopback base is this process's PORT on 127.0.0.1", () => {
  assert.equal(loopbackBase({}), "http://127.0.0.1:3000");
  assert.equal(loopbackBase({ PORT: "8080" }), "http://127.0.0.1:8080");
});

test("every POST the tools make is one the internal credential accepts as read-only", async () => {
  routes = {
    "POST /api/ui/apm/spans": () => ({ json: { spans: [], total: 0 } }),
    "POST /api/ui/metrics/query": () => ({ json: { series: [] } }),
    "POST /api/ui/logs/search": () => ({ json: { logs: [], total: 0 } }),
    "POST /api/v2/logs/analytics/aggregate": () => ({ json: { data: { buckets: [] } } }),
  };
  calls.length = 0;
  await callTool("search_spans", {});
  await callTool("query_metrics", { query: "avg:system.cpu.user{*}" });
  await callTool("search_logs", {});
  await callTool("aggregate_logs", {});
  const posts = calls.filter((c) => c.method === "POST").map((c) => c.path.replace(/^\/api/, ""));
  assert.equal(new Set(posts).size, 4);
  for (const p of posts) assert.ok(isReadOnlyRequest("POST", p), p);
});
