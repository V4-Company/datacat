import { stripAnsi } from "./decode";
import { redactLog, redactSpan } from "./redact";

// Size limits applied before storage (span tag values are truncated at 25,000 characters and large
// log messages are truncated). Keeps one oversized record from bloating the database or the UI.
const MAX_MESSAGE = Number(process.env.DATACAT_MAX_LOG_MESSAGE_CHARS ?? 262_144);
const MAX_VALUE = Number(process.env.DATACAT_MAX_ATTRIBUTE_CHARS ?? 25_000);
const MAX_ATTRS = 500;
const cut = (v: string, n: number) => (v.length > n ? v.slice(0, n) + "…[truncated]" : v);
function limitValues(o: Record<string, any> | undefined, depth = 0): Record<string, any> | undefined {
  if (!o || typeof o !== "object") return o;
  const keys = Object.keys(o);
  if (keys.length > MAX_ATTRS) for (const k of keys.slice(MAX_ATTRS)) delete o[k];
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string") o[k] = cut(v, MAX_VALUE);
    else if (v && typeof v === "object") {
      if (depth >= 8) o[k] = cut(JSON.stringify(v), MAX_VALUE);
      else limitValues(v, depth + 1);
    }
  }
  return o;
}
import { pool } from "@workspace/db";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import { recordSpanStats } from "../query/apmStats";
import { useClickHouse } from "../lib/storage";
import { chInsert, ensureChSchema } from "../lib/ch";

export interface PointIn {
  metric: string;
  host: string;
  tags: string[];
  type: string; // gauge | count | rate | distribution
  unit?: string;
  points: ([number, number] | [number, number, number])[]; // [unix seconds, value, weight (distribution sketches; default 1)]
}

const seriesCache = new Map<string, number>();
const SERIES_CACHE_MAX = 1_000_000;
function trimCaches() {
  // a cache miss only costs a lookup, so dropping the oldest tenth is always safe
  for (const m of [seriesCache, lastSeenTouched] as Map<any, any>[]) {
    if (m.size <= SERIES_CACHE_MAX) continue;
    let drop = Math.ceil(SERIES_CACHE_MAX / 10);
    for (const k of m.keys()) {
      m.delete(k);
      if (--drop <= 0) break;
    }
  }
}

function normTags(tags: string[]): string[] {
  const set = new Set<string>();
  for (const t of tags ?? []) {
    if (!t) continue;
    const s = String(t).trim();
    if (s && !s.startsWith("host:")) set.add(s);
  }
  return [...set].sort();
}

/**
 * Resolve series ids for a batch. Unknown series are created with one multi-row upsert per request
 * (sorted by key so concurrent requests take row locks in the same order), instead of one awaited
 * round trip per new series — high-cardinality tags (e.g. a customer id) create thousands at once.
 */
async function seriesIds(orgId: number, list: PointIn[], now: number): Promise<number[]> {
  const keys: string[] = [];
  const missing = new Map<string, { metric: string; host: string; tags: string[]; tags_key: string; type: string; unit: string | null }>();
  for (const p of list) {
    const tags = normTags(p.tags);
    const tagsKey = tags.join(",");
    const key = `${orgId}|${p.metric}|${p.host}|${tagsKey}`;
    keys.push(key);
    if (!seriesCache.has(key) && !missing.has(key))
      missing.set(key, { metric: p.metric, host: p.host ?? "", tags, tags_key: tagsKey, type: p.type, unit: p.unit ?? null });
  }
  if (missing.size) {
    const sorted = [...missing.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 0; i < sorted.length; i += 1000) {
      const chunk = sorted.slice(i, i + 1000).map(([, v]) => v);
      const r = await pool.query(
        `insert into metric_series (org_id, metric, host, tags, tags_key, type, unit, last_seen)
         select $1, x.metric, x.host, array(select jsonb_array_elements_text(x.tags)), x.tags_key, x.type, x.unit, $2
         from jsonb_to_recordset($3::jsonb) as x(metric text, host text, tags jsonb, tags_key text, type text, unit text)
         on conflict (org_id, metric, host, tags_key) do update set last_seen = excluded.last_seen, type = excluded.type
         returning id, metric, host, tags_key`,
        [orgId, now, JSON.stringify(chunk)],
      );
      for (const row of r.rows) {
        seriesCache.set(`${orgId}|${row.metric}|${row.host}|${row.tags_key}`, row.id as number);
        lastSeenTouched.set(row.id as number, now);
      }
    }
  }
  const ids = keys.map((k) => seriesCache.get(k)!);
  trimCaches();
  return ids;
}

const lastSeenTouched = new Map<number, number>();

type DbClient = { query(text: string, values?: unknown[]): Promise<unknown> };
/** Runs fn in one transaction, so a batch is stored completely or not at all (a retried request never duplicates). */
async function inTransaction<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch((err) => logger.warn({ err }, "rollback failed"));
    throw e;
  } finally {
    c.release();
  }
}
/** Executes the statements on one connection in a transaction when there are several, directly when there is one. */
async function runAll(stmts: [string, any[]][]) {
  if (stmts.length === 1) await pool.query(stmts[0][0], stmts[0][1]);
  else if (stmts.length > 1)
    await inTransaction(async (c) => {
      for (const [q, v] of stmts) await c.query(q, v);
    });
}

/** ClickHouse: deterministic 52-bit series id (fits a JS number exactly), so every API process agrees without a round trip. */
function seriesIdHash(key: string): number {
  return parseInt(createHash("sha1").update(key).digest("hex").slice(0, 13), 16);
}

async function writeMetricsCh(orgId: number, series: PointIn[]) {
  await ensureChSchema();
  const now = Math.floor(Date.now() / 1000);
  const hosts = new Set<string>();
  const valid = series.filter((s) => s.metric && s.points?.length);
  const meta: object[] = [];
  const metaIds = new Set<number>();
  const points: object[] = [];
  trimCaches();
  for (const s of valid) {
    const tags = normTags(s.tags);
    const key = `${orgId}|${s.metric}|${s.host ?? ""}|${tags.join(",")}`;
    let id = seriesCache.get(key);
    if (id === undefined) {
      id = seriesIdHash(key);
      seriesCache.set(key, id);
    }
    // metadata rows are re-written at most every 5 minutes per series (ReplacingMergeTree keeps the latest)
    if (now - (lastSeenTouched.get(id) ?? 0) > 300 && !metaIds.has(id)) {
      metaIds.add(id);
      meta.push({ org_id: orgId, metric: s.metric, series_id: id, host: s.host ?? "", tags, type: s.type || "gauge", unit: s.unit ?? "", last_seen: now });
    }
    if (s.host) hosts.add(s.host);
    for (const [ts, v, w] of s.points) {
      if (!Number.isFinite(v) || !Number.isFinite(ts)) continue;
      points.push({
        org_id: orgId,
        metric: s.metric,
        series_id: id,
        host: s.host ?? "",
        ts: Math.floor(ts),
        value: v,
        weight: w !== undefined && Number.isFinite(w) ? w : 1,
      });
    }
  }
  // Metadata first: if it fails nothing is written, and a retry writes both.
  await chInsert("metric_series", meta);
  for (const id of metaIds) lastSeenTouched.set(id, now);
  await chInsert("metric_points", points);
  const apps = newApps(orgId, valid);
  for (const h of hosts) await touchHost(orgId, h, apps.has(h) ? { apps: apps.get(h) } : {}, apps.has(h));
}

export async function writeMetrics(orgId: number, series: PointIn[]) {
  if (useClickHouse) return writeMetricsCh(orgId, series);
  const now = Math.floor(Date.now() / 1000);
  const vals: any[] = [];
  const rows: string[] = [];
  const stmts: [string, any[]][] = [];
  const hosts = new Set<string>();
  const valid = series.filter((s) => s.metric && s.points?.length);
  const ids = await seriesIds(orgId, valid, now);
  // last_seen is refreshed at most every 5 minutes per series, in one statement per request
  const touch: number[] = [];
  for (let i = 0; i < valid.length; i++) {
    const s = valid[i];
    const id = ids[i];
    if (id === undefined) continue;
    if (now - (lastSeenTouched.get(id) ?? 0) > 300) {
      lastSeenTouched.set(id, now);
      touch.push(id);
    }
    if (s.host) hosts.add(s.host);
    for (const [ts, v, w] of s.points) {
      if (!Number.isFinite(v) || !Number.isFinite(ts)) continue;
      vals.push(id, Math.floor(ts), v, w !== undefined && Number.isFinite(w) && w !== 1 ? w : null);
      rows.push(`($${vals.length - 3},$${vals.length - 2},$${vals.length - 1},$${vals.length})`);
      if (rows.length >= 2000) {
        stmts.push([`insert into metric_points (series_id, ts, value, weight) values ${rows.join(",")}`, vals.slice()]);
        rows.length = 0;
        vals.length = 0;
      }
    }
  }
  if (rows.length) stmts.push([`insert into metric_points (series_id, ts, value, weight) values ${rows.join(",")}`, vals.slice()]);
  await runAll(stmts);
  if (touch.length) {
    touch.sort((a, b) => a - b);
    pool.query("update metric_series set last_seen=$1 where id = any($2::int[])", [now, touch]).catch((e) => {
      for (const id of touch) lastSeenTouched.delete(id);
      logger.warn({ err: e }, "last_seen refresh failed");
    });
  }
  const apps = newApps(orgId, valid);
  for (const h of hosts) await touchHost(orgId, h, apps.has(h) ? { apps: apps.get(h) } : {}, apps.has(h));
}

// host → service links (for the host list), refreshed at most once a minute per pair
const hostServiceTouched = new Map<string, number>();
let hostServicesReady: Promise<unknown> | null = null;
async function recordHostServices(orgId: number, spans: { host: string; service: string }[]) {
  const now = Math.floor(Date.now() / 1000);
  const fresh = new Map<string, [string, string]>();
  for (const s of spans) {
    if (!s.host || !s.service) continue;
    const k = `${orgId}|${s.host}|${s.service}`;
    if (now - (hostServiceTouched.get(k) ?? 0) < 60) continue;
    hostServiceTouched.set(k, now);
    fresh.set(k, [s.host, s.service]);
  }
  if (!fresh.size) return;
  hostServicesReady ??= pool.query(
    `create table if not exists host_services (org_id integer not null, host text not null, service text not null, last_seen bigint not null, primary key (org_id, host, service))`,
  );
  await hostServicesReady;
  const rows = [...fresh.values()].sort();
  await pool
    .query(
      `insert into host_services (org_id, host, service, last_seen) select $1, x.h, x.s, $2 from jsonb_to_recordset($3::jsonb) as x(h text, s text)
     on conflict (org_id, host, service) do update set last_seen = excluded.last_seen`,
      [orgId, now, JSON.stringify(rows.map(([h, sv]) => ({ h, s: sv })))],
    )
    .catch((e) => logger.warn({ err: e }, "host_services update failed"));
}

// integrations seen per host (metric namespace, e.g. postgresql.*, redis.*), recorded once per new namespace
const IGNORED_APPS = new Set(["system", "trace", "service_check", "datadog", "datacat", "runtime", "otelcol"]);
const hostApps = new Map<string, Set<string>>();
function newApps(orgId: number, series: PointIn[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of series) {
    if (!s.host) continue;
    const app = s.metric.split(".")[0];
    if (!app || IGNORED_APPS.has(app)) continue;
    const k = `${orgId}|${s.host}`;
    let set = hostApps.get(k);
    if (!set) hostApps.set(k, (set = new Set()));
    if (set.has(app)) continue;
    set.add(app);
    out.set(s.host, [...set]);
  }
  return out;
}

const hostTouched = new Map<string, number>();

export async function touchHost(
  orgId: number,
  name: string,
  info: { os?: string; platform?: string; agentVersion?: string; tags?: string[]; apps?: string[]; meta?: any },
  force = false,
) {
  if (!name) return;
  const now = Math.floor(Date.now() / 1000);
  const k = `${orgId}|${name}`;
  if (!force && now - (hostTouched.get(k) ?? 0) < 30 && !info.os) return;
  hostTouched.set(k, now);
  await pool.query(
    `insert into hosts (org_id, name, os, platform, agent_version, tags, apps, meta, first_seen, last_seen)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     on conflict (org_id, name) do update set
       last_seen = excluded.last_seen,
       os = coalesce(excluded.os, hosts.os),
       platform = coalesce(excluded.platform, hosts.platform),
       agent_version = coalesce(excluded.agent_version, hosts.agent_version),
       tags = case when cardinality(excluded.tags) > 0 then excluded.tags else hosts.tags end,
       apps = case when cardinality(excluded.apps) > 0 then excluded.apps else hosts.apps end,
       meta = case when excluded.meta = '{}'::jsonb then hosts.meta else hosts.meta || excluded.meta end`,
    [orgId, name, info.os ?? null, info.platform ?? null, info.agentVersion ?? null, info.tags ?? [], info.apps ?? [], info.meta ?? {}, now],
  );
}

export interface LogIn {
  ts: number;
  status: string;
  service: string;
  host: string;
  source: string;
  message: string;
  tags: string[];
  attributes: Record<string, any>;
  traceId?: string | null;
}

/** ClickHouse: nested log attributes flattened to dotted keys (string values) for the attrs Map, which has a bloom filter index. */
function flatten(o: any, prefix = "", out: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v) && depth < 6) flatten(v, key, out, depth + 1);
    else out[key] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

// ClickHouse log ids: milliseconds * 4096 + a per-process counter, unique per process and < 2^53 so they survive JSON.
let logSeq = 0;
const nextLogId = () => Date.now() * 4096 + (logSeq = (logSeq + 1) % 4096);

export async function writeLogs(orgId: number, logs: LogIn[]) {
  // Sensitive data is masked before anything is stored (intake/redact.ts).
  for (const l of logs) {
    if (typeof l.message === "string") l.message = cut(stripAnsi(l.message), MAX_MESSAGE);
    limitValues(l.attributes);
    if (Array.isArray(l.tags)) l.tags = l.tags.slice(0, MAX_ATTRS).map((t) => (typeof t === "string" ? cut(t, MAX_VALUE) : t));
    if (typeof l.service === "string") l.service = cut(l.service, 1000);
    redactLog(l);
    if (l.service) l.service = l.service.toLowerCase();
  }
  const hosts = new Set<string>();
  if (useClickHouse) {
    await ensureChSchema();
    const rows = logs.map((l) => {
      if (l.host) hosts.add(l.host);
      return {
        org_id: orgId,
        id: nextLogId(),
        ts: Math.round(l.ts),
        status: l.status ?? "",
        service: l.service ?? "",
        host: l.host ?? "",
        source: l.source ?? "",
        message: l.message ?? "",
        tags: l.tags ?? [],
        attributes: JSON.stringify(l.attributes ?? {}),
        attrs: flatten(l.attributes),
        trace_id: l.traceId ?? "",
      };
    });
    await chInsert("logs", rows);
    for (const h of hosts) await touchHost(orgId, h, {});
    return;
  }
  const stmts: [string, any[]][] = [];
  for (let i = 0; i < logs.length; i += 500) {
    const chunk = logs.slice(i, i + 500);
    const vals: any[] = [];
    const rows: string[] = [];
    for (const l of chunk) {
      const b = vals.length;
      vals.push(orgId, l.ts, l.status, l.service, l.host, l.source, l.message, l.tags, JSON.stringify(l.attributes), l.traceId ?? null);
      rows.push(`(${Array.from({ length: 10 }, (_, j) => `$${b + j + 1}`).join(",")})`);
      if (l.host) hosts.add(l.host);
    }
    stmts.push([`insert into logs (org_id, ts, status, service, host, source, message, tags, attributes, trace_id) values ${rows.join(",")}`, vals]);
  }
  await runAll(stmts);
  for (const h of hosts) await touchHost(orgId, h, {});
}

export interface SpanIn {
  traceId: string;
  spanId: string;
  parentId: string;
  service: string;
  name: string;
  resource: string;
  type: string;
  env: string;
  host: string;
  start: number; // ns
  duration: number; // ns
  error: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
  isTopLevel?: boolean;
}

export function markTopLevel(spans: SpanIn[]) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  for (const s of spans) {
    if (s.metrics?._top_level === 1 || s.metrics?.["_dd.top_level"] === 1) s.isTopLevel = true;
    else if (!s.parentId || s.parentId === "0") s.isTopLevel = true;
    else {
      const p = byId.get(s.parentId);
      s.isTopLevel = p ? p.service !== s.service : true;
    }
  }
}

export async function writeSpans(orgId: number, spans: SpanIn[]) {
  if (!spans.length) return;
  // service/env are normalized to lowercase so searches can compare exactly and use indexes.
  for (const s of spans) {
    limitValues(s.meta);
    if (s.resource) s.resource = cut(s.resource, 5000);
    if (typeof s.name === "string") s.name = cut(s.name, 1000);
    if (typeof s.service === "string") s.service = cut(s.service, 1000);
    redactSpan(s);
    if (s.service) s.service = s.service.toLowerCase();
    if (s.env) s.env = s.env.toLowerCase();
  }
  if (useClickHouse) {
    await ensureChSchema();
    const toStr = (o: Record<string, any> | undefined) => {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(o ?? {})) if (v !== null && v !== undefined) r[k] = typeof v === "string" ? v : String(v);
      return r;
    };
    const toNum = (o: Record<string, any> | undefined) => {
      const r: Record<string, number> = {};
      for (const [k, v] of Object.entries(o ?? {})) if (Number.isFinite(Number(v))) r[k] = Number(v);
      return r;
    };
    await chInsert(
      "spans",
      spans.map((s) => ({
        org_id: orgId,
        trace_id: s.traceId,
        span_id: s.spanId,
        parent_id: s.parentId || "0",
        service: s.service || "unnamed-service",
        name: s.name || "",
        resource: s.resource || s.name || "",
        type: s.type || "",
        env: s.env || "",
        host: s.host || "",
        start: Math.round(s.start),
        start_ms: Math.floor(s.start / 1e6),
        duration: Math.max(0, Math.round(s.duration)),
        error: s.error ? 1 : 0,
        is_top_level: s.isTopLevel ? 1 : 0,
        meta: toStr(s.meta),
        metrics: toNum(s.metrics),
      })),
    );
  } else {
    const stmts: [string, any[]][] = [];
    for (let i = 0; i < spans.length; i += 300) {
      const chunk = spans.slice(i, i + 300);
      const vals: any[] = [];
      const rows: string[] = [];
      for (const s of chunk) {
        const b = vals.length;
        vals.push(
          orgId,
          s.traceId,
          s.spanId,
          s.parentId || "0",
          s.service || "unnamed-service",
          s.name || "",
          s.resource || s.name || "",
          s.type || "",
          s.env || "",
          s.host || "",
          Math.round(s.start),
          Math.floor(s.start / 1e6),
          Math.max(0, Math.round(s.duration)),
          s.error ? 1 : 0,
          s.isTopLevel ? 1 : 0,
          JSON.stringify(s.meta ?? {}),
          JSON.stringify(s.metrics ?? {}),
        );
        rows.push(`(${Array.from({ length: 17 }, (_, j) => `$${b + j + 1}`).join(",")})`);
      }
      stmts.push([
        `insert into spans (org_id, trace_id, span_id, parent_id, service, name, resource, type, env, host, start, start_ms, duration, error, is_top_level, meta, metrics)
       values ${rows.join(",")}`,
        vals,
      ]);
    }
    await runAll(stmts);
  }
  await recordHostServices(orgId, spans);
  // Per-minute APM rollups (service/resource counts and latency histograms) for the APM screens.
  // With ClickHouse a materialized view on spans maintains them (lib/ch.ts).
  if (!useClickHouse)
    try {
      await recordSpanStats(orgId, spans);
    } catch (e) {
      logger.warn({ err: e }, "span stats rollup failed");
    }
  // Derive trace metrics (trace.<operation>.hits/errors/duration) from top-level spans
  const agg = new Map<string, { metric: string; tags: string[]; host: string; ts: number; hits: number; errors: number; dur: number }>();
  for (const s of spans) {
    if (!s.isTopLevel) continue;
    const ts = Math.floor(s.start / 1e9 / 10) * 10;
    const tags = [`service:${s.service}`, `resource_name:${s.resource}`, `env:${s.env || "none"}`];
    // Not keyed by host: per-host trace series multiply cardinality by the number of hosts (hundreds of
    // thousands of series at scale). Host → service links are kept in host_services instead.
    const k = `${s.name}|${tags.join(",")}|${ts}`;
    let a = agg.get(k);
    if (!a) agg.set(k, (a = { metric: s.name, tags, host: "", ts, hits: 0, errors: 0, dur: 0 }));
    a.hits++;
    a.errors += s.error ? 1 : 0;
    a.dur += s.duration / 1e9;
  }
  const out: PointIn[] = [];
  for (const a of agg.values()) {
    out.push({ metric: `trace.${a.metric}.hits`, host: a.host, tags: a.tags, type: "count", points: [[a.ts, a.hits]] });
    out.push({ metric: `trace.${a.metric}.errors`, host: a.host, tags: a.tags, type: "count", points: [[a.ts, a.errors]] });
    out.push({ metric: `trace.${a.metric}.duration`, host: a.host, tags: a.tags, type: "gauge", points: [[a.ts, a.dur / a.hits]] });
  }
  try {
    await writeMetrics(orgId, out);
  } catch (e) {
    logger.warn({ err: e }, "trace metric derivation failed");
  }
}
