import crypto from "crypto";
import { writeMetrics, writeLogs, writeSpans, touchHost, markTopLevel, type PointIn, type LogIn, type SpanIn } from "../intake/store";
import { logger } from "../lib/logger";

/**
 * Sample data: simulates a small fleet (4 hosts, 3 services) through the same ingestion path the agent
 * uses, so invited testers can explore every product before installing an agent.
 */
const running = new Map<number, NodeJS.Timeout>();
const HOSTS = [
  { name: "web-01", role: "web", az: "us-east-1a" },
  { name: "web-02", role: "web", az: "us-east-1b" },
  { name: "api-01", role: "api", az: "us-east-1a" },
  { name: "db-01", role: "db", az: "us-east-1c" },
];
const ROUTES = [
  { svc: "storefront", res: "GET /", base: 40 },
  { svc: "storefront", res: "GET /products", base: 70 },
  { svc: "checkout-api", res: "POST /checkout", base: 180, err: 0.08 },
  { svc: "checkout-api", res: "GET /cart", base: 35 },
];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const id = () => BigInt.asUintN(63, crypto.randomBytes(8).readBigUInt64BE()).toString();

async function tick(orgId: number, t0: number, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const phase = (now - t0) / 600;
  const series: PointIn[] = [];
  for (const [i, h] of HOSTS.entries()) {
    const tags = [`env:sample`, `role:${h.role}`, `availability-zone:${h.az}`];
    const cpuUser = Math.max(1, (h.role === "db" ? 55 : 25) + 15 * Math.sin(phase + i) + rnd(-5, 5));
    series.push(
      { metric: "system.cpu.user", host: h.name, tags, type: "gauge", points: [[now, cpuUser]] },
      { metric: "system.cpu.system", host: h.name, tags, type: "gauge", points: [[now, cpuUser * 0.3]] },
      { metric: "system.cpu.iowait", host: h.name, tags, type: "gauge", points: [[now, h.role === "db" ? rnd(2, 8) : rnd(0, 1)]] },
      { metric: "system.cpu.idle", host: h.name, tags, type: "gauge", points: [[now, 100 - cpuUser * 1.3]] },
      { metric: "system.load.1", host: h.name, tags, type: "gauge", points: [[now, cpuUser / 20 + rnd(0, 0.5)]] },
      { metric: "system.load.5", host: h.name, tags, type: "gauge", points: [[now, cpuUser / 22]] },
      { metric: "system.load.15", host: h.name, tags, type: "gauge", points: [[now, cpuUser / 25]] },
      { metric: "system.mem.usable", host: h.name, tags, type: "gauge", points: [[now, rnd(3e9, 5e9)]] },
      { metric: "system.mem.pct_usable", host: h.name, tags, type: "gauge", points: [[now, rnd(0.35, 0.6)]] },
      { metric: "system.disk.in_use", host: h.name, tags: [...tags, "device:/dev/sda1"], type: "gauge", points: [[now, h.role === "db" ? 0.71 : 0.42]] },
      { metric: "system.net.bytes_rcvd", host: h.name, tags, type: "gauge", points: [[now, rnd(1e5, 8e5)]] },
      { metric: "system.net.bytes_sent", host: h.name, tags, type: "gauge", points: [[now, rnd(1e5, 6e5)]] },
    );
  }
  await writeMetrics(orgId, series);
  const logs: LogIn[] = [];
  const spans: SpanIn[] = [];
  const reqs = Math.floor(rnd(15, 30));
  for (let k = 0; k < reqs; k++) {
    const r = ROUTES[Math.floor(Math.random() * ROUTES.length)];
    const host = r.svc === "storefront" ? HOSTS[Math.floor(Math.random() * 2)].name : "api-01";
    const traceId = id(),
      rootId = id();
    const startNs = (nowMs - Math.floor(rnd(0, 14000))) * 1e6;
    const err = Math.random() < (r.err ?? 0.01);
    const dur = (r.base + rnd(0, r.base)) * (err ? 2 : 1) * 1e6;
    const dbDur = dur * rnd(0.2, 0.5);
    const meta = {
      "http.method": r.res.split(" ")[0],
      "http.url": r.res.split(" ")[1],
      "http.status_code": err ? "500" : "200",
      env: "sample",
      ...(err ? { "error.type": "TimeoutError", "error.message": "payment gateway timed out after 2000ms" } : {}),
    };
    const s: SpanIn[] = [
      {
        traceId,
        spanId: rootId,
        parentId: "0",
        service: r.svc,
        name: "http.request",
        resource: r.res,
        type: "web",
        env: "sample",
        host,
        start: startNs,
        duration: dur,
        error: err ? 1 : 0,
        meta,
        metrics: {},
      },
      {
        traceId,
        spanId: id(),
        parentId: rootId,
        service: "postgres",
        name: "postgresql.query",
        resource: r.svc === "storefront" ? "SELECT * FROM products WHERE active = ?" : "UPDATE carts SET status = ? WHERE id = ?",
        type: "sql",
        env: "sample",
        host: "db-01",
        start: startNs + dur * 0.2,
        duration: dbDur,
        error: 0,
        meta: { "db.system": "postgresql", env: "sample" },
        metrics: {},
      },
    ];
    if (r.svc === "checkout-api")
      s.push({
        traceId,
        spanId: id(),
        parentId: rootId,
        service: "payments",
        name: "http.request",
        resource: "POST /charge",
        type: "http",
        env: "sample",
        host: "api-01",
        start: startNs + dur * 0.5,
        duration: dur * 0.4,
        error: err ? 1 : 0,
        meta: { "http.status_code": err ? "504" : "200", env: "sample" },
        metrics: {},
      });
    markTopLevel(s);
    spans.push(...s);
    logs.push({
      ts: Math.floor(startNs / 1e6) + Math.floor(dur / 1e6),
      status: err ? "error" : "info",
      service: r.svc,
      host,
      source: "nodejs",
      message: err ? `${r.res} failed: payment gateway timed out after 2000ms` : `${r.res} ${meta["http.status_code"]} ${Math.round(dur / 1e6)}ms`,
      tags: ["env:sample", `version:1.4.${Math.floor(phase) % 3}`],
      attributes: {
        http: { method: meta["http.method"], url: meta["http.url"], status_code: Number(meta["http.status_code"]) },
        duration: Math.round(dur),
        dd: { trace_id: traceId },
      },
      traceId,
    });
  }
  if (Math.random() < 0.3)
    logs.push({
      ts: nowMs,
      status: "warn",
      service: "postgres",
      host: "db-01",
      source: "postgresql",
      message: "checkpoints are occurring too frequently (24 seconds apart)",
      tags: ["env:sample"],
      attributes: {},
    });
  await writeLogs(orgId, logs);
  await writeSpans(orgId, spans);
}

const starting = new Map<number, Promise<{ until: number }>>();
/** Starts sample data for an organization; a second call while one is starting returns the same result. */
export function startSampleData(orgId: number, minutes = 60): Promise<{ until: number }> {
  const cur = starting.get(orgId);
  if (cur) return cur;
  const p = startSampleDataNow(orgId, minutes).finally(() => starting.delete(orgId));
  starting.set(orgId, p);
  return p;
}

async function startSampleDataNow(orgId: number, minutes: number) {
  stopSampleData(orgId);
  for (const h of HOSTS)
    await touchHost(
      orgId,
      h.name,
      {
        os: "linux",
        platform: "linux",
        agentVersion: "7.56.2 (sample)",
        tags: [`env:sample`, `role:${h.role}`, `availability-zone:${h.az}`],
        apps: h.role === "db" ? ["postgres", "system"] : ["nodejs", "system"],
        meta: { cpuCores: 4 },
      },
      true,
    );
  const t0 = Math.floor(Date.now() / 1000);
  // backfill the last 30 minutes so graphs have history
  const now = Date.now();
  for (let back = 30 * 60; back > 0; back -= 60) await tick(orgId, t0 - back, now - back * 1000);
  const end = Date.now() + minutes * 60_000;
  const iv = setInterval(() => {
    if (Date.now() > end) return stopSampleData(orgId);
    tick(orgId, t0).catch((e) => logger.warn({ err: String(e) }, "sample tick failed"));
  }, 15_000);
  running.set(orgId, iv);
  return { until: end };
}
export function stopSampleData(orgId: number) {
  const iv = running.get(orgId);
  if (iv) clearInterval(iv);
  running.delete(orgId);
}
export function sampleRunning(orgId: number) {
  return running.has(orgId);
}
