/**
 * APM stats rollups.
 *
 * The APM screens (service list, service page, resources) used to compute counts and latency
 * percentiles over every raw top-level span in the time range, which grows linearly with traffic.
 * Instead, intake now writes per-minute rollups per (service, env, operation, resource) with a
 * mergeable log-scale latency histogram (relative error ~2%, like DDSketch), and the screens read
 * those. Rows are append-only (several rows per minute are fine); queries sum them.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { useClickHouse } from "../lib/storage";
import * as ch from "./apmStatsCh";

const GAMMA = 1.04; // bucket i covers (1µs·γ^(i-1), 1µs·γ^i]; value error ≤ (γ-1)/(γ+1) ≈ 2%
const LOG_GAMMA = Math.log(GAMMA);
const MIN_NS = 1000;

export function bucketOf(durationNs: number): number {
  if (!(durationNs > MIN_NS)) return 0;
  return Math.ceil(Math.log(durationNs / MIN_NS) / LOG_GAMMA);
}
function valueOf(idx: number): number {
  if (idx <= 0) return MIN_NS;
  // geometric midpoint of the bucket, in ns
  return MIN_NS * Math.pow(GAMMA, idx) * (2 / (1 + GAMMA));
}

let ready: Promise<void> | null = null;
export function ensureSpanStats(): Promise<void> {
  if (useClickHouse) return ch.ensureSpanStats();
  if (!ready) {
    ready = (async () => {
      const existed = (await pool.query("select to_regclass('span_stats') is not null as e")).rows[0].e;
      await pool.query(`create table if not exists span_stats (
        org_id integer not null, bucket bigint not null, service text not null, env text not null default '',
        name text not null default '', resource text not null default '', type text not null default '', lang text not null default '',
        hits integer not null, errors integer not null, dur_sum double precision not null, dur_max double precision not null,
        hist_idx integer[] not null, hist_cnt integer[] not null)`);
      await pool.query("create index if not exists span_stats_org_bucket on span_stats (org_id, bucket)");
      await pool.query("create index if not exists span_stats_org_service_bucket on span_stats (org_id, service, bucket)");
      // Error spans are ~1-5% of traffic; "status:error" searches would otherwise scan every span in the range.
      pool
        .query("create index concurrently if not exists spans_errors on spans (org_id, service, start_ms) where error = 1")
        .catch((e) => logger.warn({ err: e }, "spans_errors index creation failed"));
      // First run on an existing install: build rollups for spans stored before this point (in the background). The
      // limit is the highest span id now, so spans inserted later (whatever their start time) are counted once, by intake.
      if (!existed) {
        const maxId = Number((await pool.query("select coalesce(max(id), 0) as m from spans")).rows[0].m);
        backfillSpanStats(maxId).catch((e) => logger.warn({ err: e }, "span_stats backfill failed"));
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

interface SpanLike {
  service: string;
  env: string;
  name: string;
  resource: string;
  type: string;
  start: number;
  duration: number;
  error: number;
  meta: Record<string, string>;
  isTopLevel?: boolean;
}

type Agg = {
  bucket: number;
  service: string;
  env: string;
  name: string;
  resource: string;
  type: string;
  lang: string;
  hits: number;
  errors: number;
  sum: number;
  max: number;
  hist: Map<number, number>;
};
// Rollups are aggregated in memory across requests and flushed every 10 s, so each
// (minute, service, env, operation, resource) gets about one row per flush instead of one per request.
const pending = new Map<number, Map<string, Agg>>();
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_MS = Number(process.env.DATACAT_STATS_FLUSH_MS ?? 10000);

export async function recordSpanStats(orgId: number, spans: SpanLike[]) {
  if (useClickHouse) return;
  let agg = pending.get(orgId);
  if (!agg) pending.set(orgId, (agg = new Map()));
  for (const s of spans) {
    if (!s.isTopLevel) continue;
    const bucket = Math.floor(s.start / 1e9 / 60) * 60;
    const service = s.service || "unnamed-service";
    const resource = s.resource || s.name || "";
    const k = `${bucket}|${service}|${s.env}|${s.name}|${resource}`;
    let a = agg.get(k);
    if (!a)
      agg.set(
        k,
        (a = {
          bucket,
          service,
          env: s.env || "",
          name: s.name || "",
          resource,
          type: s.type || "",
          lang: s.meta?.language || "",
          hits: 0,
          errors: 0,
          sum: 0,
          max: 0,
          hist: new Map(),
        }),
      );
    const d = Math.max(0, s.duration);
    a.hits++;
    if (s.error) a.errors++;
    a.sum += d;
    if (d > a.max) a.max = d;
    const b = bucketOf(d);
    a.hist.set(b, (a.hist.get(b) ?? 0) + 1);
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushSpanStats().catch((e) => logger.warn({ err: e }, "span stats flush failed"));
    }, FLUSH_MS);
    flushTimer.unref();
    process.once("beforeExit", () => {
      void flushSpanStats();
    });
  }
}

/**
 * Merge each finished minute's rollup rows into one row per (service, env, operation, resource),
 * histograms included, so the table stays small no matter how many intake requests wrote to it.
 */
async function compactMinute(bucket: number) {
  await pool.query(
    `with d as (delete from span_stats where bucket = $1 returning *),
     u as (select org_id, bucket, service, env, name, resource, max(type) as type, max(lang) as lang, sum(hits)::int as hits, sum(errors)::int as errors,
                  sum(dur_sum) as dur_sum, max(dur_max) as dur_max from d group by 1,2,3,4,5,6),
     h as (select org_id, bucket, service, env, name, resource, t.i, sum(t.c)::int as c from d, unnest(d.hist_idx, d.hist_cnt) as t(i, c) group by 1,2,3,4,5,6,7),
     ha as (select org_id, bucket, service, env, name, resource, array_agg(i order by i) as hi, array_agg(c order by i) as hc from h group by 1,2,3,4,5,6)
     insert into span_stats (org_id, bucket, service, env, name, resource, type, lang, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt)
     select u.org_id, u.bucket, u.service, u.env, u.name, u.resource, u.type, u.lang, u.hits, u.errors, u.dur_sum, u.dur_max, ha.hi, ha.hc
     from u join ha using (org_id, bucket, service, env, name, resource)`,
    [bucket],
  );
}
let lastCompacted = 0;
async function compactFinishedMinutes() {
  // a minute is final ~3 minutes after it ends (late spans, 10 s flushes)
  const upTo = Math.floor(Date.now() / 60000) * 60 - 180;
  if (!lastCompacted) lastCompacted = upTo - 60 * 10; // after a restart, revisit the last 10 minutes
  for (let b = lastCompacted + 60; b <= upTo; b += 60) {
    await compactMinute(b);
    lastCompacted = b;
  }
}

export async function flushSpanStats() {
  compactFinishedMinutes().catch((e) => logger.warn({ err: e }, "span stats compaction failed"));
  if (!pending.size) return;
  await ensureSpanStats();
  const batches = [...pending.entries()];
  pending.clear();
  for (let n = 0; n < batches.length; n++) {
    const [orgId, agg] = batches[n];
    const rows = [...agg.values()].map((a) => ({ ...a, hist_idx: [...a.hist.keys()], hist_cnt: [...a.hist.values()], hist: undefined }));
    try {
      await insertStats(orgId, rows);
    } catch (e) {
      // nothing from this org was committed (one transaction); put it and every org not yet written back for the next flush
      for (const [o, a] of batches.slice(n)) restore(o, a);
      throw e;
    }
  }
}

function restore(orgId: number, agg: Map<string, Agg>) {
  let cur = pending.get(orgId);
  if (!cur) pending.set(orgId, (cur = new Map()));
  for (const [k, a] of agg) {
    const b = cur.get(k);
    if (!b) {
      cur.set(k, a);
      continue;
    }
    b.hits += a.hits;
    b.errors += a.errors;
    b.sum += a.sum;
    b.max = Math.max(b.max, a.max);
    for (const [i, c] of a.hist) b.hist.set(i, (b.hist.get(i) ?? 0) + c);
  }
}

async function insertStats(orgId: number, rows: any[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i += 1000) {
      await client.query(
        `insert into span_stats (org_id, bucket, service, env, name, resource, type, lang, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt)
         select $1, x.bucket, x.service, x.env, x.name, x.resource, x.type, x.lang, x.hits, x.errors, x.sum, x.max,
                array(select jsonb_array_elements_text(x.hist_idx)::int), array(select jsonb_array_elements_text(x.hist_cnt)::int)
         from jsonb_to_recordset($2::jsonb) as x(bucket bigint, service text, env text, name text, resource text, type text, lang text, hits int, errors int, sum float8, max float8, hist_idx jsonb, hist_cnt jsonb)`,
        [orgId, JSON.stringify(rows.slice(i, i + 1000))],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

class Hist {
  m = new Map<number, number>();
  n = 0;
  add(idx: number[], cnt: number[]) {
    for (let i = 0; i < idx.length; i++) {
      this.m.set(idx[i], (this.m.get(idx[i]) ?? 0) + cnt[i]);
      this.n += cnt[i];
    }
  }
  q(p: number): number {
    if (!this.n) return 0;
    const rank = p * (this.n - 1);
    let seen = 0;
    for (const k of [...this.m.keys()].sort((a, b) => a - b)) {
      seen += this.m.get(k)!;
      if (seen > rank) return valueOf(k);
    }
    return valueOf(Math.max(...this.m.keys()));
  }
}

// A minute bucket overlaps the range if any part of it is inside [from, to).
const RANGE = "org_id=$1 and bucket > $2 - 60 and bucket < $3";

export async function serviceSummary(orgId: number, from: number, to: number, env: string | null) {
  if (useClickHouse) return ch.serviceSummary(orgId, from, to, env);
  await ensureSpanStats();
  const g = await grouped(
    `select service, type, env, lang, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt from span_stats where ${RANGE} and ($4::text is null or env=$4)`,
    [orgId, from, to, env],
    (r) => r.service,
  );
  return [...g.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([service, x]) => ({
      service,
      type: x.types.size ? [...x.types].sort().at(-1) : "",
      envs: [...x.envs],
      language: [...x.langs].filter(Boolean).sort().at(-1) || null,
      hits: x.hits,
      errors: x.errors,
      p50: x.h.q(0.5),
      p95: x.h.q(0.95),
      p99: x.h.q(0.99),
      avg: x.hits ? x.total / x.hits : 0,
      total: x.total,
    }));
}

/** Histogram rows for a set of rows grouped by key, merged in JS. */
async function grouped(sql: string, params: any[], key: (r: any) => string) {
  const out = new Map<
    string,
    { first: any; hits: number; errors: number; total: number; max: number; h: Hist; types: Set<string>; envs: Set<string>; langs: Set<string> }
  >();
  for (const r of (await pool.query(sql, params)).rows) {
    const k = key(r);
    let g = out.get(k);
    if (!g) out.set(k, (g = { first: r, hits: 0, errors: 0, total: 0, max: 0, h: new Hist(), types: new Set(), envs: new Set(), langs: new Set() }));
    if (r.type) g.types.add(r.type);
    if (r.env !== undefined) g.envs.add(r.env);
    if (r.lang) g.langs.add(r.lang);
    g.hits += r.hits;
    g.errors += r.errors;
    g.total += Number(r.dur_sum);
    g.max = Math.max(g.max, Number(r.dur_max));
    g.h.add(r.hist_idx, r.hist_cnt);
  }
  return out;
}

export async function serviceTimeseries(orgId: number, service: string, from: number, to: number, interval: number) {
  if (useClickHouse) return ch.serviceTimeseries(orgId, service, from, to, interval);
  await ensureSpanStats();
  const step = Math.max(60, interval);
  const g = await grouped(
    `select (bucket / ${step}) * ${step} as b, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt from span_stats where ${RANGE} and service=$4`,
    [orgId, from, to, service],
    (r) => String(r.b),
  );
  return [...g.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([b, x]) => ({ t: Number(b) * 1000, hits: x.hits, errors: x.errors, p50: x.h.q(0.5), p95: x.h.q(0.95), p99: x.h.q(0.99), max: x.max }));
}

export async function serviceResources(orgId: number, service: string, from: number, to: number) {
  if (useClickHouse) return ch.serviceResources(orgId, service, from, to);
  await ensureSpanStats();
  const g = await grouped(
    `select resource, name, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt from span_stats where ${RANGE} and service=$4`,
    [orgId, from, to, service],
    (r) => `${r.resource}\u0000${r.name}`,
  );
  const span = Math.max(1, to - from);
  return [...g.values()]
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 200)
    .map((x) => ({
      resource: x.first.resource,
      name: x.first.name,
      hits: x.hits,
      errors: x.errors,
      p50: x.h.q(0.5),
      p95: x.h.q(0.95),
      p99: x.h.q(0.99),
      total: x.total,
      rps: x.hits / span,
    }));
}

/** Environments seen in the APM rollups since `since` (unix seconds). */
export async function apmEnvs(orgId: number, since: number): Promise<string[]> {
  if (useClickHouse) return ch.apmEnvs(orgId, since);
  await ensureSpanStats();
  return (await pool.query("select distinct env from span_stats where org_id=$1 and bucket > $2", [orgId, since])).rows
    .map((r) => r.env as string)
    .filter(Boolean);
}

export async function serviceOperations(orgId: number, service: string, from: number, to: number) {
  if (useClickHouse) return ch.serviceOperations(orgId, service, from, to);
  await ensureSpanStats();
  return (await pool.query(`select distinct name from span_stats where ${RANGE} and service=$4`, [orgId, from, to, service])).rows.map((r) => r.name as string);
}

/** One-time backfill of rollups from raw spans stored before the table existed (spans written since boot are recorded by intake). */
async function backfillSpanStats(maxId: number) {
  const t0 = Date.now();
  await pool.query(
    `insert into span_stats (org_id, bucket, service, env, name, resource, type, lang, hits, errors, dur_sum, dur_max, hist_idx, hist_cnt)
     select org_id, bucket, service, env, name, resource, coalesce(max(type), ''), coalesce(max(lang), ''), sum(c)::int, sum(e)::int, sum(s), max(m), array_agg(idx), array_agg(c)
     from (select org_id, (start_ms / 60000) * 60 as bucket, service, env, name, resource, max(type) as type, max(meta->>'language') as lang,
                  case when duration <= ${MIN_NS} then 0 else ceil(ln(duration::float8 / ${MIN_NS}) / ln(${GAMMA}))::int end as idx,
                  count(*)::int as c, sum(error)::int as e, sum(duration)::float8 as s, max(duration)::float8 as m
           from spans where is_top_level=1 and id <= ${Math.floor(maxId)} group by 1,2,3,4,5,6,9) x
     group by org_id, bucket, service, env, name, resource`,
  );
  logger.info({ ms: Date.now() - t0 }, "span_stats backfilled from spans");
}
