/** Telemetry API on ClickHouse storage (DATACAT_STORAGE=clickhouse): same routes and responses as telemetry.ts, queried with ClickHouse SQL. */
import { serviceSummary, serviceTimeseries, serviceResources, serviceOperations, apmEnvs } from "../query/apmStats";
import { chQuery, ChParams } from "../lib/ch";
import { hostMetricsCh } from "../query/metricsCh";
import { logWhereCh, spanWhereCh } from "../query/searchCh";
import { v2Search, v2Page, parseAggregate, toBuckets, limitBuckets, PERCENTILE, type AggregateRequest, aggregatePasses, mergeBuckets } from "../query/v2";
import { filterHosts } from "../query/hosts";
import { spanV2 } from "./telemetry";
import { correlate } from "../query/correlate";
import { Router, type Request, type Response } from "express";
import { h, HttpError, rangeOf, parseTime, pageLimit, encodeCursor, decodeCursor, nextLink } from "../lib/http";
import { pool } from "@workspace/db";
import { requireOrg } from "../middlewares/authMiddleware";
import {
  runQueries,
  listMetrics,
  metricTags,
  pickInterval,
  parseMetricQuery,
  runMetricQuery,
  extractInlineQueries,
  evalFormula,
  type SeriesSet,
} from "../query/metrics";
import { normalizeTraceId } from "../intake/decode";

const router: Router = Router();
router.use(
  ["/ui", "/v1/query", "/v2/query", "/v1/metrics", "/v2/logs/events", "/v2/logs/analytics", "/v2/spans/events", "/v1/hosts", "/v1/intake"],
  requireOrg,
);

const range = (req: Request) => rangeOf({ ...(req.query as any), ...(req.body ?? {}) });

// ---------- Metrics ----------
router.post(
  "/ui/metrics/query",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { queries, formulas, vars, interval } = req.body ?? {};
    const r = await runQueries(req.orgId!, { queries: queries ?? [], formulas, from, to, vars, interval });
    res.json({ ...r, from, to });
  }),
);

// v1 query API: GET /api/v1/query?from=&to=&query=
router.get(
  "/v1/query",
  h(async (req, res) => {
    const { from, to } = range(req);
    const query = String(req.query.query ?? "");
    const interval = pickInterval(from, to);
    const r = await runQueries(req.orgId!, { queries: [{ name: "a", query }], from, to, interval });
    res.json({
      status: "ok",
      res_type: "time_series",
      from_date: from * 1000,
      to_date: to * 1000,
      query,
      series: r.series.map((s) => ({
        metric: query,
        display_name: query,
        expression: query,
        scope: s.group.join(",") || "*",
        tag_set: s.group,
        pointlist: s.pointlist,
        length: s.pointlist.length,
        interval: s.interval ?? interval,
        start: s.pointlist[0]?.[0],
        end: s.pointlist.at(-1)?.[0],
        aggr: null,
        unit: null,
      })),
    });
  }),
);

// v2 timeseries formula API
router.post(
  "/v2/query/timeseries",
  h(async (req, res) => {
    const a = req.body?.data?.attributes ?? {};
    const from = Math.floor(Number(a.from) / 1000),
      to = Math.floor(Number(a.to) / 1000);
    const r = await runQueries(req.orgId!, {
      queries: (a.queries ?? []).map((q: any) => ({ name: q.name, query: q.query })),
      formulas: a.formulas,
      from,
      to,
      interval: a.interval ? a.interval / 1000 : undefined,
    });
    const times = [...new Set(r.series.flatMap((s) => s.pointlist.map((p) => p[0])))].sort((x, y) => x - y);
    res.json({
      data: {
        type: "timeseries_response",
        attributes: {
          times,
          series: r.series.map((s) => ({ query_index: s.queryIndex, group_tags: s.group, unit: null })),
          values: r.series.map((s) => {
            const m = new Map(s.pointlist);
            return times.map((t) => m.get(t) ?? null);
          }),
        },
      },
    });
  }),
);

router.get(
  ["/ui/metrics", "/v1/metrics"],
  h(async (req, res) => {
    const list = await listMetrics(req.orgId!, String(req.query.q ?? ""));
    if (req.path.startsWith("/v1")) res.json({ metrics: list.map((m) => m.metric), from: String(req.query.from ?? "") });
    else res.json({ metrics: list });
  }),
);
router.get(
  "/ui/metrics/:name/tags",
  h(async (req, res) => res.json(await metricTags(req.orgId!, String(req.params.name)))),
);
router.get(
  "/ui/tags",
  h(async (req, res) => res.json(await metricTags(req.orgId!, ""))),
);

// ---------- Infrastructure ----------
async function hostRows(orgId: number) {
  const hosts = (await pool.query("select * from hosts where org_id=$1 order by name", [orgId])).rows;
  const now = Math.floor(Date.now() / 1000);
  const metrics = await hostMetricsCh(
    orgId,
    [
      "system.cpu.user",
      "system.cpu.system",
      "system.cpu.iowait",
      "system.load.15",
      "system.load.1",
      "system.mem.pct_usable",
      "system.mem.used",
      "system.mem.total",
      "system.disk.in_use",
      "system.cpu.idle",
    ],
    now - 600,
  );
  const by = new Map<string, Record<string, number>>();
  for (const m of metrics) {
    let o = by.get(m.host);
    if (!o) by.set(m.host, (o = {}));
    o[m.metric] = Number(m.v);
  }
  // apps are recorded on hosts.apps at intake; services per host come from host_services (both small tables)
  const appBy = new Map<string, string[]>();
  const svc = (
    await pool
      .query(`select host, array_agg(service order by service) as s from host_services where org_id=$1 and last_seen > $2 group by host`, [orgId, now - 3600])
      .catch(() => ({ rows: [] as any[] }))
  ).rows;
  const svcBy = new Map(svc.map((r) => [r.host, r.s as string[]]));
  return hosts.map((x) => {
    const m = by.get(x.name) ?? {};
    const cpu =
      m["system.cpu.user"] !== undefined
        ? (m["system.cpu.user"] ?? 0) + (m["system.cpu.system"] ?? 0)
        : m["system.cpu.idle"] !== undefined
          ? 100 - m["system.cpu.idle"]
          : null;
    return {
      id: x.id,
      name: x.name,
      os: x.os,
      platform: x.platform,
      agent_version: x.agent_version,
      tags: x.tags,
      meta: x.meta,
      apps: [...new Set([...(x.apps ?? []), ...(appBy.get(x.name) ?? []).filter((a) => !["trace", "service_check", "datadog", "datacat"].includes(a))])].sort(),
      services: svcBy.get(x.name) ?? [],
      up: now - Number(x.last_seen) < 600,
      last_seen: Number(x.last_seen),
      first_seen: Number(x.first_seen),
      cpu,
      iowait: m["system.cpu.iowait"] ?? null,
      load15: m["system.load.15"] ?? null,
      load1: m["system.load.1"] ?? null,
      mem_pct: m["system.mem.pct_usable"] !== undefined ? (1 - m["system.mem.pct_usable"]) * 100 : null,
      disk_pct: m["system.disk.in_use"] !== undefined ? m["system.disk.in_use"] * 100 : null,
    };
  });
}
router.get(
  "/ui/hosts",
  h(async (req, res) => res.json({ hosts: await hostRows(req.orgId!) })),
);
router.get(
  "/v1/hosts",
  h(async (req, res) => {
    const { page: rows, total } = filterHosts(await hostRows(req.orgId!), req.query as Record<string, unknown>);
    res.json({
      total_matching: total,
      host_list: rows.map((r) => ({
        name: r.name,
        host_name: r.name,
        up: r.up,
        last_reported_time: r.last_seen,
        apps: r.apps,
        tags_by_source: { DataCat: r.tags },
        metrics: { cpu: r.cpu, iowait: r.iowait, load: r.load15 },
        meta: { agent_version: r.agent_version, platform: r.platform },
      })),
      total_returned: rows.length,
    });
  }),
);
router.post(
  "/ui/hostmap",
  h(async (req, res) => {
    // Host map: value per host for a metric query (space-aggregated per host)
    const { metric = "avg:system.cpu.user{*}", filter = "" } = req.body ?? {};
    const now = Math.floor(Date.now() / 1000);
    const q = parseMetricQuery(metric.includes("{") ? metric : `avg:${metric}{${filter || "*"}}`);
    if (filter && !metric.includes("{")) void 0;
    q.groupBy = ["host"];
    const set = await runMetricQuery(req.orgId!, q, now - 300, now, 60);
    const values: Record<string, number> = {};
    for (const s of set) {
      const vs = [...s.points.values()];
      if (vs.length) values[s.tags[0].slice(5)] = vs[vs.length - 1];
    }
    res.json({ values, hosts: await hostRows(req.orgId!) });
  }),
);

// Counting every match is a full scan of the range; stop at 10,000 (shown as "10,000+") like large-scale log tools.
const COUNT_CAP = 10000;
async function cappedCount(table: string, where: string, params: Record<string, string | number>) {
  const r = await chQuery(`SELECT count() AS c FROM (SELECT 1 FROM ${table} WHERE ${where} LIMIT ${COUNT_CAP + 1})`, params);
  const c = Number(r[0]?.c ?? 0);
  return { total: Math.min(c, COUNT_CAP), total_capped: c > COUNT_CAP };
}
// Facet values are computed over the most recent 50,000 matches (exact below that).
const FACET_SAMPLE = 50000;
const logOut = (r: any) => ({
  id: String(r.id),
  ts: Number(r.ts),
  status: r.status,
  service: r.service,
  host: r.host,
  source: r.source,
  message: r.message,
  tags: r.tags,
  attributes: (() => {
    try {
      return JSON.parse(r.attributes || "{}");
    } catch {
      return {};
    }
  })(),
  trace_id: r.trace_id || null,
});
const LOG_COLS = "id, ts, status, service, host, source, message, tags, attributes, trace_id";
/** SQL for a log facet (column, @attribute or tag key); keys are bound as parameters. */
const facetExpr = (f: string, b: ChParams) => {
  if (["status", "service", "host", "source"].includes(f)) return f;
  if (f.startsWith("@")) return `attrs[${b.p(f.slice(1))}]`;
  const prefix = b.p(f + ":");
  return `substring(arrayFirst(t -> startsWith(t, ${prefix}), tags), length(${prefix}) + 1)`;
};
// ---------- Logs ----------
function logWhere(orgId: number, query: string, from: number, to: number) {
  const { where, b } = logWhereCh(orgId, query, from, to);
  return { where, params: b.params, b };
}
router.post(
  "/ui/logs/search",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", limit = 100, cursor, sort = "desc" } = req.body ?? {};
    const { where, b } = logWhere(req.orgId!, query, from, to);
    const base = { ...b.params };
    let w = where;
    const dir = sort === "asc" ? "ASC" : "DESC";
    if (cursor && !/^\d+_\d+$/.test(String(cursor))) throw new HttpError(400, "Invalid cursor");
    if (cursor) {
      const [cts, cid] = String(cursor).split("_");
      w +=
        sort === "asc"
          ? ` AND (ts, id) > (${b.p(Number(cts), "Int64")}, ${b.p(Number(cid), "UInt64")})`
          : ` AND (ts, id) < (${b.p(Number(cts), "Int64")}, ${b.p(Number(cid), "UInt64")})`;
    }
    const n = pageLimit(limit, 100, 1000);
    const rows = await chQuery(`SELECT ${LOG_COLS} FROM logs WHERE ${w} ORDER BY ts ${dir}, id ${dir} LIMIT ${n}`, b.params);
    const counted = await cappedCount("logs", where, base);
    const last = rows.at(-1);
    res.json({ logs: rows.map(logOut), ...counted, cursor: rows.length === n && last ? `${last.ts}_${last.id}` : null });
  }),
);
router.post(
  "/ui/logs/histogram",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", groupBy = "status" } = req.body ?? {};
    const interval = pickInterval(from, to, 80);
    const { where, params } = logWhere(req.orgId!, query, from, to);
    const col = ["status", "service", "host", "source"].includes(groupBy) ? groupBy : "status";
    const rows = await chQuery(
      `SELECT intDiv(ts, ${interval * 1000}) * ${interval} AS b, ${col} AS g, count() AS c FROM logs WHERE ${where} GROUP BY b, g ORDER BY b`,
      params,
    );
    res.json({ interval, buckets: rows.map((r) => ({ t: Number(r.b) * 1000, g: r.g, c: Number(r.c) })) });
  }),
);
router.post(
  "/ui/logs/facets",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", facets = ["status", "service", "host", "source"] } = req.body ?? {};
    const { where, params } = logWhere(req.orgId!, query, from, to);
    const out: Record<string, { value: string; count: number }[]> = {};
    const needAttrs = (facets as string[]).some((x) => x.startsWith("@"));
    for (const f of facets as string[]) {
      const fb = new ChParams(params);
      const rows = await chQuery(
        `SELECT ${facetExpr(String(f), fb)} AS v, count() AS c FROM (SELECT status, service, host, source, tags${needAttrs ? ", attrs" : ""} FROM logs WHERE ${where} ORDER BY ts DESC LIMIT ${FACET_SAMPLE}) GROUP BY v ORDER BY c DESC LIMIT 25`,
        fb.params,
      );
      out[f] = rows.filter((r) => r.v !== null && r.v !== "").map((r) => ({ value: String(r.v), count: Number(r.c) }));
    }
    res.json({ facets: out });
  }),
);
router.post(
  "/ui/logs/aggregate",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", groupBy = "", measure = "count", type = "timeseries" } = req.body ?? {};
    const { where, b } = logWhere(req.orgId!, query, from, to);
    const params = b.params;
    const g = !groupBy ? "'*'" : facetExpr(String(groupBy), b);
    const m = measure === "count" ? "toFloat64(count())" : `avg(toFloat64OrNull(attrs[${b.p(String(measure).replace(/^@/, ""))}]))`;
    if (type === "timeseries") {
      const interval = pickInterval(from, to, 120);
      const rows = await chQuery(
        `SELECT intDiv(ts, ${interval * 1000}) * ${interval} AS b, ${g} AS g, ${m} AS v FROM logs WHERE ${where} GROUP BY b, g ORDER BY b`,
        params,
      );
      const series = new Map<string, [number, number][]>();
      for (const r of rows) {
        const k = String(r.g || "N/A");
        if (!series.has(k)) series.set(k, []);
        series.get(k)!.push([Number(r.b) * 1000, Number(r.v)]);
      }
      res.json({ interval, series: [...series].map(([k, p]) => ({ group: groupBy ? [`${groupBy}:${k}`] : [], pointlist: p })) });
    } else {
      const rows = await chQuery(`SELECT ${g} AS g, ${m} AS v FROM logs WHERE ${where} GROUP BY g ORDER BY v DESC LIMIT 50`, params);
      res.json({ rows: rows.map((r) => ({ group: String(r.g || "N/A"), value: Number(r.v) })) });
    }
  }),
);
// v2 logs search API (POST .../search, or GET /api/v2/logs/events); see telemetry.ts for the contract.
const logsSearchV2 = h(async (req, res) => {
  const started = Date.now();
  const s = v2Search(req, { defaultLimit: 10, maxLimit: 5000 });
  const { where, b } = logWhere(req.orgId!, s.query, s.from, s.to);
  let w = where;
  if (s.cursor) w += ` AND (ts, id) ${s.asc ? ">" : "<"} (${b.p(Number(s.cursor[0]), "Int64")}, ${b.p(Number(s.cursor[1]), "UInt64")})`;
  const dir = s.asc ? "ASC" : "DESC";
  const rows = (await chQuery(`SELECT ${LOG_COLS} FROM logs WHERE ${w} ORDER BY ts ${dir}, id ${dir} LIMIT ${s.limit + 1}`, b.params)).map(logOut);
  const { page, envelope } = v2Page(req, rows, s.limit, (r) => [r.ts, r.id], started);
  res.json({
    data: page.map((r) => ({
      id: r.id,
      type: "log",
      attributes: {
        timestamp: new Date(r.ts).toISOString(),
        status: r.status,
        service: r.service,
        host: r.host,
        message: r.message,
        tags: r.tags,
        attributes: r.attributes,
      },
    })),
    ...envelope,
  });
});
router.post("/v2/logs/events/search", logsSearchV2);
router.get("/v2/logs/events", logsSearchV2);

// v2 log analytics: group and count (POST /api/v2/logs/analytics/aggregate)
function aggregateComputeSql(c: AggregateRequest["computes"][number], b: ChParams): string {
  if (c.aggregation === "count") return "toFloat64(count())";
  const metric = c.metric!;
  if (c.aggregation === "cardinality") return `toFloat64(uniqExact(${facetExpr(metric, b)}))`;
  const x = `toFloat64OrNull(attrs[${b.p(metric.replace(/^@/, ""))}])`;
  if (c.aggregation in PERCENTILE) return `quantileExactInclusive(${PERCENTILE[c.aggregation]})(${x})`;
  return `${c.aggregation}(${x})`;
}
router.post(
  "/v2/logs/analytics/aggregate",
  h(async (req, res) => {
    const started = Date.now();
    const a = parseAggregate(req.body);
    const parts = [];
    for (const pass of aggregatePasses(a, (f, t) => pickInterval(f, t, 60))) {
      const { where, b } = logWhere(req.orgId!, a.query, a.from, a.to);
      const groups = a.groupBy.map((g, i) => `${facetExpr(g.facet, b)} AS g${i}`);
      const computes = pass.computes.map((c) => `${aggregateComputeSql(c, b)} AS ${c.name}`);
      const ts = pass.interval !== null;
      const sel = [...groups, ...(ts ? [`intDiv(ts, ${pass.interval! * 1000}) * ${pass.interval} AS t`] : []), ...computes];
      const by = [...a.groupBy.map((_, i) => `g${i}`), ...(ts ? ["t"] : [])];
      const rows = await chQuery(
        `SELECT ${sel.join(", ")} FROM logs WHERE ${where} ${by.length ? `GROUP BY ${by.join(", ")}` : ""} ${ts ? "ORDER BY t" : ""} LIMIT 100000`,
        b.params,
      );
      parts.push(toBuckets({ ...a, computes: pass.computes }, rows));
    }
    res.json({ data: { buckets: limitBuckets(a, mergeBuckets(parts)) }, meta: { status: "done", elapsed: Date.now() - started } });
  }),
);

// ---------- APM ----------
router.get(
  "/ui/apm/services",
  h(async (req, res) => {
    const { from, to } = range(req);
    const env = req.query.env && req.query.env !== "*" ? String(req.query.env) : null;
    // per-minute rollups written at intake (query/apmStats.ts), not raw spans
    const rows = await serviceSummary(req.orgId!, from, to, env);
    const envs = await apmEnvs(req.orgId!, to - 86400 * 7);
    const span = Math.max(1, to - from);
    res.json({ envs, services: rows.map((r) => ({ ...r, rps: r.hits / span, error_rate: r.hits ? r.errors / r.hits : 0 })) });
  }),
);
router.get(
  "/ui/apm/services/:service",
  h(async (req, res) => {
    const { from, to } = range(req);
    const service = String(req.params.service);
    const interval = pickInterval(from, to, 90);
    const [ts, resources, ops] = await Promise.all([
      serviceTimeseries(req.orgId!, service, from, to, interval),
      serviceResources(req.orgId!, service, from, to),
      serviceOperations(req.orgId!, service, from, to),
    ]);
    // Downstream services come from parent/child links in raw spans: look at this service's 2,000 most
    // recent spans in the range (index lookups by trace id) instead of joining every span in the window.
    const db = new ChParams();
    const o = db.p(req.orgId!, "UInt32"),
      sv = db.p(service),
      f0 = db.p(from * 1000, "Int64"),
      t0 = db.p(to * 1000, "Int64");
    const deps = await chQuery(
      `SELECT c.service AS service, toUInt32(count()) AS calls, avg(c.duration) AS avg FROM spans AS c
    INNER JOIN (SELECT trace_id, span_id FROM spans WHERE org_id = ${o} AND service = ${sv} AND start_ms >= ${f0} AND start_ms < ${t0} ORDER BY start_ms DESC LIMIT 2000) AS p
      ON c.trace_id = p.trace_id AND c.parent_id = p.span_id
    WHERE c.org_id = ${o} AND c.start_ms >= ${f0} - 60000 AND c.start_ms < ${t0} + 60000 AND c.service != ${sv}
    GROUP BY c.service ORDER BY calls DESC LIMIT 20`,
      db.params,
    );
    res.json({
      service,
      interval: Math.max(60, interval),
      timeseries: ts,
      resources,
      downstream: deps.map((d) => ({ ...d, avg: Number(d.avg) })),
      operations: ops,
    });
  }),
);
function spanWhere(orgId: number, query: string, from: number, to: number) {
  const { where, b } = spanWhereCh(orgId, query, from, to);
  return { where, params: b.params, b };
}
const spanOut = (r: any) => ({
  ...r,
  id: `${r.trace_id}:${r.span_id}`,
  start: Number(r.start),
  start_ms: Number(r.start_ms),
  duration: Number(r.duration),
  error: Number(r.error),
  is_top_level: Number(r.is_top_level ?? 0),
});
const SPAN_COLS = "trace_id, span_id, parent_id, service, name, resource, type, env, host, start, start_ms, duration, error, is_top_level, meta";
router.post(
  "/ui/apm/spans",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", limit = 100, topLevelOnly = false } = req.body ?? {};
    const { where, params } = spanWhere(req.orgId!, query, from, to);
    const w = topLevelOnly ? `${where} AND is_top_level = 1` : where;
    const rows = await chQuery(`SELECT ${SPAN_COLS} FROM spans WHERE ${w} ORDER BY start_ms DESC LIMIT ${pageLimit(limit, 100, 1000)}`, params);
    const counted = await cappedCount("spans", w, params);
    res.json({ spans: rows.map(spanOut), ...counted });
  }),
);
router.post(
  "/ui/apm/spans/facets",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*" } = req.body ?? {};
    const { where, params } = spanWhere(req.orgId!, query, from, to);
    const out: Record<string, { value: string; count: number }[]> = {};
    for (const [f, expr] of [
      ["service", "service"],
      ["env", "env"],
      ["resource_name", "resource"],
      ["operation_name", "name"],
      ["status", "if(error = 1, 'error', 'ok')"],
      ["@http.status_code", "sc"],
      ["host", "host"],
    ] as const) {
      const rows = await chQuery(
        `SELECT ${expr} AS v, count() AS c FROM (SELECT service, env, resource, name, error, host, meta['http.status_code'] AS sc FROM spans WHERE ${where} ORDER BY start_ms DESC LIMIT ${FACET_SAMPLE}) GROUP BY v ORDER BY c DESC LIMIT 20`,
        params,
      );
      out[f] = rows.filter((r) => r.v).map((r) => ({ value: String(r.v), count: Number(r.c) }));
    }
    res.json({ facets: out });
  }),
);
// Evidence-based correlation for an incident window (query/correlate.ts): what changed vs the window just before.
router.get(
  "/ui/correlate/:service",
  h(async (req, res) => {
    const { from, to } = range(req);
    res.json(await correlate(req.orgId!, String(req.params.service), from, to));
  }),
);
router.get(
  "/ui/apm/traces/:traceId",
  h(async (req, res) => {
    const tid = normalizeTraceId(req.params.traceId) ?? String(req.params.traceId);
    const b = new ChParams();
    const o = b.p(req.orgId!, "UInt32"),
      t = b.p(tid);
    const rows = await chQuery(`SELECT ${SPAN_COLS}, metrics FROM spans WHERE org_id = ${o} AND trace_id = ${t} ORDER BY start`, b.params);
    const logs = await chQuery(
      `SELECT id, ts, status, service, host, message FROM logs WHERE org_id = ${o} AND trace_id = ${t} ORDER BY ts LIMIT 200`,
      b.params,
    );
    res.json({ spans: rows.map(spanOut), logs: logs.map((l) => ({ ...l, id: String(l.id), ts: Number(l.ts) })) });
  }),
);
// v2 spans search (POST .../search, or GET /api/v2/spans/events); see telemetry.ts for the contract.
const spansSearchV2 = h(async (req, res) => {
  const started = Date.now();
  const s = v2Search(req, { bodyRoot: (body) => body?.data?.attributes, defaultLimit: 10, maxLimit: 1000 });
  const { where, b } = spanWhere(req.orgId!, s.query, s.from, s.to);
  let w = where;
  if (s.cursor) w += ` AND (start, span_id) ${s.asc ? ">" : "<"} (${b.p(Number(s.cursor[0]), "Int64")}, ${b.p(String(s.cursor[1]))})`;
  const dir = s.asc ? "ASC" : "DESC";
  const rows = await chQuery(`SELECT ${SPAN_COLS} FROM spans WHERE ${w} ORDER BY start ${dir}, span_id ${dir} LIMIT ${s.limit + 1}`, b.params);
  const { page, envelope } = v2Page(req, rows, s.limit, (r: any) => [Number(r.start), String(r.span_id)], started);
  res.json({ data: page.map((r: any) => spanV2(r, `${r.trace_id}:${r.span_id}`)), ...envelope });
});
router.post("/v2/spans/events/search", spansSearchV2);
router.get("/v2/spans/events", spansSearchV2);

// helper for monitor evaluation reuse
export async function evalMetricExpression(orgId: number, expr: string, from: number, to: number): Promise<SeriesSet> {
  const interval = pickInterval(from, to, 60);
  const { formula, queries } = extractInlineQueries(expr);
  const env: Record<string, SeriesSet> = {};
  for (const [n, raw] of Object.entries(queries)) env[n] = await runMetricQuery(orgId, parseMetricQuery(raw), from, to, interval);
  return evalFormula(formula, env, interval);
}
export { logWhere, spanWhere };

export default router;
