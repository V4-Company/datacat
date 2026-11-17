/**
 * ClickHouse storage for telemetry (spans, logs, metric series and points, APM rollups).
 * App data (users, orgs, keys, monitors, dashboards, events, hosts) stays in Postgres.
 *
 *   DATACAT_CLICKHOUSE_URL       default http://127.0.0.1:8123
 *   DATACAT_CLICKHOUSE_DB        default datacat
 *   DATACAT_CLICKHOUSE_USER      default "default"
 *   DATACAT_CLICKHOUSE_PASSWORD  default empty
 *   DATACAT_CLICKHOUSE_CLUSTER   optional: create Replicated* tables ON CLUSTER <name> (needs Keeper)
 *   DATACAT_RETENTION_DAYS       default 15, applied as table TTLs
 */
import { logger } from "./logger";

const BASE = process.env.DATACAT_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const DB = process.env.DATACAT_CLICKHOUSE_DB ?? "datacat";
const USER = process.env.DATACAT_CLICKHOUSE_USER ?? "default";
const PASS = process.env.DATACAT_CLICKHOUSE_PASSWORD ?? "";
const CLUSTER = process.env.DATACAT_CLICKHOUSE_CLUSTER ?? "";
const RETENTION_DAYS = Number(process.env.DATACAT_RETENTION_DAYS ?? process.env.RETENTION_DAYS ?? 15);

/** Typed query parameters: {pN:Type} placeholders, sent as param_pN (never interpolated into SQL). */
export class ChParams {
  params: Record<string, string | number> = {};
  private n = 0;
  constructor(initial: Record<string, string | number> = {}) {
    Object.assign(this.params, initial);
    // continue numbering after copied parameters so new ones never overwrite them
    for (const k of Object.keys(initial)) {
      const m = /^p(\d+)$/.exec(k);
      if (m) this.n = Math.max(this.n, Number(m[1]));
    }
  }
  p(v: any, type?: string): string {
    const name = `p${++this.n}`;
    const t = type ?? (typeof v === "number" ? (Number.isInteger(v) ? "Int64" : "Float64") : "String");
    this.params[name] = typeof v === "number" ? v : String(v);
    return `{${name}:${t}}`;
  }
}

export interface External {
  name: string;
  structure: string;
  tsv: string;
}

function url(extra: Record<string, string> = {}, withDb = true) {
  const u = new URL(BASE);
  if (withDb) u.searchParams.set("database", DB);
  u.searchParams.set("output_format_json_quote_64bit_integers", "0");
  u.searchParams.set("output_format_json_named_tuples_as_objects", "0");
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u;
}
const auth = () => ({ "X-ClickHouse-User": USER, "X-ClickHouse-Key": PASS });

export async function chQuery<T = any>(
  sql: string,
  params: Record<string, string | number> = {},
  opts: { external?: External[]; settings?: Record<string, string | number>; noDb?: boolean } = {},
): Promise<T[]> {
  const extra: Record<string, string> = { default_format: "JSON" };
  for (const [k, v] of Object.entries(params)) extra[`param_${k}`] = String(v);
  for (const [k, v] of Object.entries(opts.settings ?? {})) extra[k] = String(v);
  let res: Response;
  if (opts.external?.length) {
    extra.query = sql;
    const fd = new FormData();
    for (const e of opts.external) {
      extra[`${e.name}_structure`] = e.structure;
      fd.append(e.name, new Blob([e.tsv]), e.name);
    }
    res = await fetch(url(extra, !opts.noDb), { method: "POST", headers: auth(), body: fd });
  } else {
    res = await fetch(url(extra, !opts.noDb), { method: "POST", headers: auth(), body: sql });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse: ${text.slice(0, 500)}`);
  if (!text || text[0] !== "{") return [];
  return (JSON.parse(text).data ?? []) as T[];
}

/** Insert rows as JSONEachRow. Async insert batches small inserts server-side; wait_for_async_insert=1 means the
 * request is acknowledged only after the data is written to a part on disk, so an ack is never lost on a crash. */
export async function chInsert(table: string, rows: object[]) {
  if (!rows.length) return;
  const body = `INSERT INTO ${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join("\n");
  const res = await fetch(
    url({
      async_insert: process.env.DATACAT_CLICKHOUSE_ASYNC_INSERT ?? "1",
      wait_for_async_insert: "1",
      async_insert_busy_timeout_ms: "200",
      input_format_skip_unknown_fields: "1",
    }),
    { method: "POST", headers: auth(), body },
  );
  if (!res.ok) throw new Error(`ClickHouse: insert into ${table}: ${(await res.text()).slice(0, 500)}`);
  await res.arrayBuffer();
}

const onCluster = CLUSTER ? ` ON CLUSTER ${CLUSTER}` : "";
const engine = (kind: string, args = "") =>
  CLUSTER ? `Replicated${kind}('/clickhouse/tables/{shard}/${DB}/{table}', '{replica}'${args ? ", " + args : ""})` : `${kind}(${args})`;
const ttl = (expr: string) => `TTL ${expr} + INTERVAL ${Math.max(1, Math.floor(RETENTION_DAYS))} DAY`;

const DDL = [
  `CREATE DATABASE IF NOT EXISTS ${DB}${onCluster}`,
  `CREATE TABLE IF NOT EXISTS ${DB}.spans${onCluster} (
    org_id UInt32, trace_id String, span_id String, parent_id String,
    service LowCardinality(String), name LowCardinality(String), resource String CODEC(ZSTD(3)), type LowCardinality(String),
    env LowCardinality(String), host LowCardinality(String),
    start Int64 CODEC(Delta, ZSTD(1)), start_ms Int64 CODEC(Delta, ZSTD(1)), duration Int64 CODEC(ZSTD(1)), error UInt8, is_top_level UInt8,
    meta Map(String, String) CODEC(ZSTD(3)), metrics Map(String, Float64) CODEC(ZSTD(3)),
    INDEX idx_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_service service TYPE set(200) GRANULARITY 4,
    INDEX idx_error error TYPE minmax GRANULARITY 1,
    INDEX idx_meta_vals mapValues(meta) TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ${engine("MergeTree")} PARTITION BY toYYYYMMDD(toDateTime(intDiv(start_ms, 1000))) ORDER BY (org_id, start_ms)
  ${ttl("toDateTime(intDiv(start_ms, 1000))")} SETTINGS index_granularity = 8192`,
  `CREATE TABLE IF NOT EXISTS ${DB}.logs${onCluster} (
    org_id UInt32, id UInt64, ts Int64 CODEC(Delta, ZSTD(1)), status LowCardinality(String), service LowCardinality(String),
    host LowCardinality(String), source LowCardinality(String), message String CODEC(ZSTD(3)), tags Array(LowCardinality(String)),
    attributes String CODEC(ZSTD(3)), attrs Map(String, String) CODEC(ZSTD(3)), trace_id String,
    INDEX idx_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_service service TYPE set(200) GRANULARITY 4,
    INDEX idx_status status TYPE set(20) GRANULARITY 4,
    INDEX idx_attr_vals mapValues(attrs) TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_msg lower(message) TYPE ngrambf_v1(3, 65536, 2, 0) GRANULARITY 4
  ) ENGINE = ${engine("MergeTree")} PARTITION BY toYYYYMMDD(toDateTime(intDiv(ts, 1000))) ORDER BY (org_id, ts)
  ${ttl("toDateTime(intDiv(ts, 1000))")} SETTINGS index_granularity = 8192`,
  `CREATE TABLE IF NOT EXISTS ${DB}.metric_series${onCluster} (
    org_id UInt32, metric LowCardinality(String), series_id UInt64, host LowCardinality(String), tags Array(String), type LowCardinality(String),
    unit LowCardinality(String), last_seen UInt32
  ) ENGINE = ${engine("ReplacingMergeTree", "last_seen")} ORDER BY (org_id, metric, series_id)`,
  `CREATE TABLE IF NOT EXISTS ${DB}.metric_points${onCluster} (
    org_id UInt32, metric LowCardinality(String), series_id UInt64, host LowCardinality(String), ts UInt32 CODEC(Delta, ZSTD(1)), value Float64 CODEC(Gorilla, ZSTD(1)),
    weight Float64 DEFAULT 1 CODEC(ZSTD(1))
  ) ENGINE = ${engine("MergeTree")} PARTITION BY toYYYYMMDD(toDateTime(ts)) ORDER BY (org_id, metric, series_id, ts)
  ${ttl("toDateTime(ts)")}`,
  // Per-minute APM rollups, maintained by ClickHouse itself from top-level spans (the same log-scale histogram
  // buckets as the Postgres version: bucket i covers (1µs·1.04^(i-1), 1µs·1.04^i]).
  `CREATE TABLE IF NOT EXISTS ${DB}.span_stats${onCluster} (
    org_id UInt32, bucket UInt32, service LowCardinality(String), env LowCardinality(String), name LowCardinality(String), resource String,
    type SimpleAggregateFunction(anyLast, String), lang SimpleAggregateFunction(anyLast, String),
    hits SimpleAggregateFunction(sum, UInt64), errors SimpleAggregateFunction(sum, UInt64),
    dur_sum SimpleAggregateFunction(sum, Float64), dur_max SimpleAggregateFunction(max, Float64),
    hist SimpleAggregateFunction(sumMap, Tuple(Array(Int32), Array(UInt64)))
  ) ENGINE = ${engine("AggregatingMergeTree")} PARTITION BY toYYYYMMDD(toDateTime(bucket)) ORDER BY (org_id, service, bucket, env, name, resource)
  ${ttl("toDateTime(bucket)")}`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DB}.span_stats_mv${onCluster} TO ${DB}.span_stats AS
   SELECT org_id, toUInt32(intDiv(start_ms, 60000) * 60) AS bucket, service, env, name, resource,
          anyLast(type) AS type, anyLast(meta['language']) AS lang, count() AS hits, toUInt64(sum(error)) AS errors,
          sum(toFloat64(duration)) AS dur_sum, max(toFloat64(duration)) AS dur_max,
          sumMap([toInt32(if(duration <= 1000, 0, ceil(log(duration / 1000) / log(1.04))))], [toUInt64(1)]) AS hist
   FROM ${DB}.spans WHERE is_top_level = 1 GROUP BY org_id, bucket, service, env, name, resource`,
];

let ready: Promise<void> | null = null;
export function ensureChSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // the database itself must be created without ?database= (it does not exist yet)
      for (const sql of DDL) await chQuery(sql, {}, { noDb: sql.startsWith("CREATE DATABASE") });
      // installs created before weighted distribution points
      await chQuery(`ALTER TABLE ${DB}.metric_points${onCluster} ADD COLUMN IF NOT EXISTS weight Float64 DEFAULT 1 CODEC(ZSTD(1))`);
      // keep TTLs in step with DATACAT_RETENTION_DAYS when it changes between restarts
      for (const [t, e] of [
        ["spans", "toDateTime(intDiv(start_ms, 1000))"],
        ["logs", "toDateTime(intDiv(ts, 1000))"],
        ["metric_points", "toDateTime(ts)"],
        ["span_stats", "toDateTime(bucket)"],
      ]) {
        await chQuery(`ALTER TABLE ${DB}.${t}${onCluster} MODIFY ${ttl(e)}`).catch((err) => logger.warn({ err: String(err) }, `TTL update on ${t} failed`));
      }
      logger.info({ url: BASE, db: DB, cluster: CLUSTER || null }, "ClickHouse telemetry schema ready");
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
