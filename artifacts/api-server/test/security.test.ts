import { test } from "node:test";
import assert from "node:assert/strict";
import { validEmail, getSafeReturnTo } from "../src/routes/auth";
import { parseStatsdLine } from "../src/intake/tracer";
import { globMatch, matchTags, parseFilter, resolveInterval } from "../src/query/metrics";
import { redactString, redactLog, redactSpan } from "../src/intake/redact";
import { isBlockedAddress, checkWebhookHeaders, checkWebhookUrl } from "../src/lib/safeHttp";
import { getSessionId } from "../src/lib/auth";
import { render, messageHandles } from "../src/jobs/monitors";

// Sample secrets are assembled at runtime so secret scanners do not flag this file.
const PEM = (edge: "BEGIN" | "END") => `-----${edge} RSA PRIV` + "ATE KEY-----";
const TOKEN_PAIR = "tok" + "en=abcdefSECRET1";

const timed = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

test("email check: same answers as the old pattern, and linear on long input", () => {
  const old = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
  for (const e of [
    "a@b.co",
    "first.last@example.com",
    "a@b.c",
    "a@.b.c",
    "a@b..c",
    "a@b.",
    "@b.co",
    "a@@b.co",
    "a b@c.de",
    "a@b",
    "a@b@c.de",
    "x@y.z.w",
    "a@bc.",
  ])
    assert.equal(validEmail(e), old(e), e);
  assert.ok(timed(() => validEmail("a@" + ".".repeat(64000) + "@")) < 50);
});

test("DogStatsD lines parse like before, and a long line with a carriage return is fast", () => {
  const old = (l: string) => /^([^:|]+):([^|]+)\|([a-z]+)(.*)$/.exec(l);
  for (const l of ["page.views:1|c", "lat:12.5|d|@0.5|#env:prod,host:a", "g:3|g|#a:b", "bad", ":1|c", "x:|c", "x:1|", "x:1|C", "a:b:c|g", "x:1|c|#t:1\r"]) {
    const o = old(l.replace(/\r$/, ""));
    const n = parseStatsdLine(l);
    assert.deepEqual(n && n.slice(1), o && o.slice(1), JSON.stringify(l));
  }
  assert.ok(timed(() => parseStatsdLine("x:1|" + "a".repeat(65536) + "\rX")) < 50);
});

test("tag globs match like the old regular expressions, and many wildcards are fast or refused", () => {
  const toRe = (g: string) =>
    new RegExp(
      "^" +
        g
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
      "i",
    );
  const pats = ["*", "web-*", "*-01", "w?b-0*", "*a*b*", "API-*", "x", "?", "*.*", "a*a*a"];
  const vals = ["web-01", "WEB-02", "api-01", "db-01", "ab", "aab", "a.b", "", "x", "aaa", "line\nbreak"];
  // the old matcher: "*" matched everything, a pattern without wildcards compared case-insensitively, else the regex
  const old = (p: string, v: string) => (p === "*" ? true : !/[*?]/.test(p) ? p.toLowerCase() === v.toLowerCase() : toRe(p).test(v));
  for (const p of pats) for (const v of vals) assert.equal(globMatch(p, v), old(p, v), `${p} ~ ${JSON.stringify(v)}`);
  assert.ok(timed(() => globMatch("****************Z", "a".repeat(5000))) < 50);
  assert.ok(timed(() => matchTags(parseFilter("host:****************Z"), ["host:" + "a".repeat(5000)])) < 50);
  assert.throws(() => parseFilter("host:" + "*".repeat(21)), /at most 20 wildcards/);
});

test("metric intervals must be positive and are widened to a bounded number of buckets", () => {
  assert.throws(() => resolveInterval(-1, 0, 3600), /positive/);
  assert.throws(() => resolveInterval(0, 0, 3600), /positive/);
  assert.throws(() => resolveInterval("abc", 0, 3600), /positive/);
  assert.equal(resolveInterval(60, 0, 3600), 60);
  assert.equal(resolveInterval(1, 0, 86400 * 30), Math.ceil((86400 * 30) / 10_000));
  assert.ok(resolveInterval(undefined, 0, 3600) > 0);
});

test("raw session ids are not accepted as Bearer tokens", () => {
  const req: any = { headers: { authorization: "Bearer abc123" }, signedCookies: {}, cookies: {} };
  assert.equal(getSessionId(req), undefined);
});

test("alert recipients come from the monitor template, not from telemetry values", () => {
  const ctx = { state: "Alert" as const, prev: "OK" as const, value: 5, threshold: 1, tags: ["service:checkout @webhook-two"], name: "m", id: 1 };
  const tpl = "Errors on {{service.name}} @webhook-one";
  assert.deepEqual(messageHandles(render(tpl, ctx, true)), ["webhook-one"]);
  assert.match(render(tpl, ctx), /@webhook-two/);
  const cond = "{{#is_alert}}@webhook-page{{/is_alert}}{{#is_recovery}}@webhook-ok{{/is_recovery}}";
  assert.deepEqual(messageHandles(render(cond, ctx, true)), ["webhook-page"]);
});

test("private-key redaction is linear and still masks real blocks", () => {
  assert.ok(timed(() => redactString(PEM("BEGIN").repeat(70000))) < 200);
  assert.equal(redactString(`k=${PEM("BEGIN")}\nMIIabc\n${PEM("END")} done`), "k=[REDACTED:private_key] done");
});

test("secret-named keys are masked for every value type; names and short Basic credentials too", () => {
  const l = redactLog({
    message: "ok",
    service: `svc ${TOKEN_PAIR}`,
    attributes: { headers: { "set-cookie": ["sid=R4nd0mValue"] }, password: 123456, plan: "Basic plan", note: "order 1234" },
  });
  assert.equal(l.attributes.headers["set-cookie"], "[REDACTED:key]");
  assert.equal(l.attributes.password, "[REDACTED:key]");
  assert.equal(l.attributes.plan, "Basic plan");
  assert.equal(l.attributes.note, "order 1234");
  assert.equal(l.service, "svc token=[REDACTED:secret]");
  assert.equal(redactString("auth Basic YTpi end"), "auth Basic [REDACTED:bearer] end");
  assert.equal(redactString("card 4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1"), "card [REDACTED:card]");
  const s = redactSpan({ resource: "GET /", name: "token=abcdef", service: "token-service" });
  assert.equal(s.name, "token=[REDACTED:secret]");
  assert.equal(s.service, "token-service");
});

test("webhook filter refuses private IPv4 addresses inside IPv6 forms", () => {
  for (const ip of [
    "64:ff9b::a9fe:a9fe",
    "::127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:0:192.168.1.1",
    "2002:a9fe:a9fe::1",
    "2001::1",
    "fec0::1",
    "::1",
    "fd00::1",
  ])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "64:ff9b::808:808", "2002:808:808::1"]) assert.equal(isBlockedAddress(ip), false, ip);
  assert.throws(() => checkWebhookUrl("http://[64:ff9b::a9fe:a9fe]/"), /private or local/);
});

test("webhook headers cannot set connection or framing headers", () => {
  for (const k of ["Host", "transfer-encoding", "Connection", "Content-Length", "Upgrade", "TE"])
    assert.throws(() => checkWebhookHeaders({ [k]: "x" }), /cannot be set/);
  assert.throws(() => checkWebhookHeaders({ "X-A": "a\r\nInjected: 1" }), /single-line/);
  assert.deepEqual(checkWebhookHeaders({ Authorization: "Bearer x", "X-Retry": 3 }), { Authorization: "Bearer x", "X-Retry": 3 });
  assert.equal(checkWebhookHeaders(null), null);
});

test("logout returnTo accepts only same-origin paths", () => {
  for (const v of ["/\\evil.example/login", "//evil.example", "/\\/evil.example", "https://evil.example", "/%5Cevil", "javascript:alert(1)"]) {
    const r = getSafeReturnTo(v === "/%5Cevil" ? decodeURIComponent(v) : v);
    assert.ok(r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\"), `${v} -> ${r}`);
  }
  assert.equal(getSafeReturnTo("/dashboards?x=1#y"), "/dashboards?x=1#y");
  assert.equal(getSafeReturnTo(undefined), "/");
});
