import { serviceSummary, serviceTimeseries, serviceResources, serviceOperations } from "../query/apmStats";
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
import { compileSearch, logResolver, spanResolver, SqlBuilder, jsonPath, safeNumber } from "../query/search";
import { v2Search, v2Page, parseAggregate, toBuckets, aggregatePasses, mergeBuckets, limitBuckets, PERCENTILE, type AggregateRequest } from "../query/v2";
import { filterHosts } from "../query/hosts";
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
  const metrics = (
    await pool.query(
      `select s.host, s.metric, avg(p.value) as v from metric_series s join metric_points p on p.series_id = s.id
     where s.org_id=$1 and s.metric = any($2) and p.ts > $3 group by 1,2`,
      [
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
      ],
    )
  ).rows;
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
async function cappedCount(table: string, where: string, params: any[]) {
  const c = (await pool.query(`select count(*)::int as c from (select 1 from ${table} where ${where} limit ${COUNT_CAP + 1}) x`, params)).rows[0].c;
  return { total: Math.min(c, COUNT_CAP), total_capped: c > COUNT_CAP };
}
// Facet values are computed over the most recent 50,000 matches (exact below that).
const FACET_SAMPLE = 50000;
// ---------- Logs ----------
function logWhere(orgId: number, query: string, from: number, to: number) {
  const b = new SqlBuilder([orgId, from * 1000, to * 1000]);
  const where = `org_id=$1 AND ts >= $2 AND ts < $3 AND ${compileSearch(query || "*", logResolver, b, "message")}`;
  return { where, params: b.params, b };
}
const LOG_COLUMNS = ["status", "service", "host", "source"];
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
/** SQL for a log facet (column, @attribute or tag key); keys are bound as parameters. */
function logFacetSql(f: string, b: SqlBuilder): string {
  if (LOG_COLUMNS.includes(f)) return f;
  if (f.startsWith("@")) return logAttrSql(f.slice(1), b);
  return `(select substr(t, ${b.p(f.length + 2)}::int) from unnest(tags) t where t like ${b.p(likeEsc(f) + ":%")} limit 1)`;
}
/** A log attribute as text: a nested path (a.b.c) or a flat dotted key ("http.status_code"), as search resolves it. */
function logAttrSql(key: string, b: SqlBuilder): string {
  return `COALESCE(${jsonPath("attributes", key, b)}, attributes ->> ${b.p(key)}::text)`;
}
/** A numeric log attribute (non-numeric values become NULL instead of failing the query). */
function logNumberSql(metric: string, b: SqlBuilder): string {
  return safeNumber(logAttrSql(metric.replace(/^@/, ""), b));
}
router.post(
  "/ui/logs/search",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", limit = 100, cursor, sort = "desc" } = req.body ?? {};
    const { where, params } = logWhere(req.orgId!, query, from, to);
    const base = [...params];
    let w = where;
    const n = pageLimit(limit, 100, 1000);
    if (cursor) {
      const [cts, cid] = String(cursor).split("_");
      if (!/^\d+$/.test(cts ?? "") || !/^\d+$/.test(cid ?? "")) throw new HttpError(400, "Invalid cursor");
      params.push(Number(cts), cid);
      w += ` AND (ts, id) ${sort === "asc" ? ">" : "<"} ($${params.length - 1}, $${params.length}::bigint)`;
    }
    const rows = (
      await pool.query(`select * from logs where ${w} order by ts ${sort === "asc" ? "asc" : "desc"}, id ${sort === "asc" ? "asc" : "desc"} limit ${n}`, params)
    ).rows;
    const counted = await cappedCount("logs", where, base);
    const last = rows.at(-1);
    res.json({
      logs: rows.map((r) => ({ ...r, ts: Number(r.ts), id: String(r.id) })),
      ...counted,
      cursor: rows.length === n && last ? `${last.ts}_${last.id}` : null,
    });
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
    const rows = (
      await pool.query(
        `select (ts/1000/${interval})*${interval} as b, ${col} as g, count(*)::int as c from logs where ${where} group by 1,2 order by 1`,
        params,
      )
    ).rows;
    res.json({ interval, buckets: rows.map((r) => ({ t: Number(r.b) * 1000, g: r.g, c: r.c })) });
  }),
);
router.post(
  "/ui/logs/facets",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", facets = ["status", "service", "host", "source"] } = req.body ?? {};
    const { where, params } = logWhere(req.orgId!, query, from, to);
    const out: Record<string, { value: string; count: number }[]> = {};
    for (const f of facets as string[]) {
      const fb = new SqlBuilder(params);
      const expr = logFacetSql(String(f), fb);
      // read only the columns facets need (the attributes JSON only for @attribute facets) from the sampled rows
      const cols = `status, service, host, source, tags${(facets as string[]).some((x) => x.startsWith("@")) ? ", attributes" : ""}`;
      out[f] = (
        await pool.query(
          `select ${expr} as v, count(*)::int as c from (select ${cols} from logs where ${where} order by ts desc limit ${FACET_SAMPLE}) logs group by 1 order by 2 desc limit 25`,
          fb.params,
        )
      ).rows
        .filter((r) => r.v !== null && r.v !== "")
        .map((r) => ({ value: String(r.v), count: r.c }));
    }
    res.json({ facets: out });
  }),
);
router.post(
  "/ui/logs/aggregate",
  h(async (req, res) => {
    // Visualize as timeseries / toplist / table, grouped by a facet
    const { from, to } = range(req);
    const { query = "*", groupBy = "", measure = "count", type = "timeseries" } = req.body ?? {};
    const { where, b } = logWhere(req.orgId!, query, from, to);
    const params = b.params;
    const g = !groupBy ? "'*'" : logFacetSql(String(groupBy), b);
    const m = measure === "count" ? "count(*)::double precision" : `avg(${logNumberSql(String(measure), b)})`;
    if (type === "timeseries") {
      const interval = pickInterval(from, to, 120);
      const rows = (
        await pool.query(`select (ts/1000/${interval})*${interval} as b, ${g} as g, ${m} as v from logs where ${where} group by 1,2 order by 1`, params)
      ).rows;
      const series = new Map<string, [number, number][]>();
      for (const r of rows) {
        const k = String(r.g ?? "N/A");
        if (!series.has(k)) series.set(k, []);
        series.get(k)!.push([Number(r.b) * 1000, Number(r.v)]);
      }
      res.json({ interval, series: [...series].map(([k, p]) => ({ group: groupBy ? [`${groupBy}:${k}`] : [], pointlist: p })) });
    } else {
      const rows = (await pool.query(`select ${g} as g, ${m} as v from logs where ${where} group by 1 order by 2 desc limit 50`, params)).rows;
      res.json({ rows: rows.map((r) => ({ group: String(r.g ?? "N/A"), value: Number(r.v) })) });
    }
  }),
);
// v2 logs search API (POST .../search with a JSON body, or GET /api/v2/logs/events with filter[...] params).
// Times may be seconds, milliseconds, ISO 8601 or date math; results page with page[cursor].
const logsSearchV2 = h(async (req, res) => {
  const started = Date.now();
  const s = v2Search(req, { defaultLimit: 10, maxLimit: 5000 });
  const { where, params } = logWhere(req.orgId!, s.query, s.from, s.to);
  let w = where;
  if (s.cursor) {
    params.push(Number(s.cursor[0]), String(s.cursor[1]));
    w += ` AND (ts, id) ${s.asc ? ">" : "<"} ($${params.length - 1}, $${params.length}::bigint)`;
  }
  const dir = s.asc ? "asc" : "desc";
  const rows = (await pool.query(`select * from logs where ${w} order by ts ${dir}, id ${dir} limit ${s.limit + 1}`, params)).rows;
  const { page, envelope } = v2Page(req, rows, s.limit, (r: any) => [Number(r.ts), String(r.id)], started);
  res.json({
    data: page.map((r: any) => ({
      id: String(r.id),
      type: "log",
      attributes: {
        timestamp: new Date(Number(r.ts)).toISOString(),
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
function aggregateComputeSql(c: AggregateRequest["computes"][number], b: SqlBuilder): string {
  if (c.aggregation === "count") return "count(*)::double precision";
  const metric = c.metric!;
  if (c.aggregation === "cardinality") return `count(distinct ${logFacetSql(metric, b)})::double precision`;
  const x = logNumberSql(metric, b);
  if (c.aggregation in PERCENTILE) return `percentile_cont(${PERCENTILE[c.aggregation]}) within group (order by ${x})`;
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
      const groups = a.groupBy.map((g, i) => `${logFacetSql(g.facet, b)} as g${i}`);
      const computes = pass.computes.map((c) => `${aggregateComputeSql(c, b)} as ${c.name}`);
      const ts = pass.interval !== null;
      const sel = [...groups, ...(ts ? [`(ts / 1000 / ${pass.interval}) * ${pass.interval} as t`] : []), ...computes];
      const by = [...a.groupBy.map((_, i) => i + 1), ...(ts ? [groups.length + 1] : [])];
      const rows = (
        await pool.query(
          `select ${sel.join(", ")} from logs where ${where} ${by.length ? `group by ${by.join(",")}` : ""} ${ts ? "order by t" : ""} limit 100000`,
          b.params,
        )
      ).rows;
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
    const envs = (await pool.query("select distinct env from span_stats where org_id=$1 and bucket > $2", [req.orgId, to - 86400 * 7])).rows
      .map((r) => r.env)
      .filter(Boolean);
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
    const deps = (
      await pool.query(
        `select c.service, count(*)::int as calls, avg(c.duration) as avg
     from (select trace_id, span_id from spans where org_id=$1 and service=$2 and start_ms >= $3 and start_ms < $4 order by start_ms desc limit 2000) p
     join spans c on c.org_id=$1 and c.trace_id=p.trace_id and c.parent_id=p.span_id
     where c.service<>$2 group by 1 order by 2 desc limit 20`,
        [req.orgId, service, from * 1000, to * 1000],
      )
    ).rows;
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
  const b = new SqlBuilder([orgId, from * 1000, to * 1000]);
  const where = `org_id=$1 AND start_ms >= $2 AND start_ms < $3 AND ${compileSearch(query || "*", spanResolver, b, "resource")}`;
  return { where, params: b.params };
}
router.post(
  "/ui/apm/spans",
  h(async (req, res) => {
    const { from, to } = range(req);
    const { query = "*", limit = 100, topLevelOnly = false } = req.body ?? {};
    const { where, params } = spanWhere(req.orgId!, query, from, to);
    const w = topLevelOnly ? `${where} AND is_top_level=1` : where;
    const rows = (
      await pool.query(
        `select id, trace_id, span_id, parent_id, service, name, resource, type, env, host, start, start_ms, duration, error, meta from spans where ${w} order by start_ms desc limit ${pageLimit(limit, 100, 1000)}`,
        params,
      )
    ).rows;
    const counted = await cappedCount("spans", w, params);
    res.json({
      spans: rows.map((r) => ({ ...r, id: String(r.id), start: Number(r.start), start_ms: Number(r.start_ms), duration: Number(r.duration) })),
      ...counted,
    });
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
      ["status", "(CASE WHEN error=1 THEN 'error' ELSE 'ok' END)"],
      ["@http.status_code", "meta->>'http.status_code'"],
      ["host", "host"],
    ] as const)
      out[f] = (
        await pool.query(
          `select ${expr} as v, count(*)::int as c from (select service, env, resource, name, error, host, jsonb_build_object('http.status_code', meta->'http.status_code') as meta from spans where ${where} order by start_ms desc limit ${FACET_SAMPLE}) spans group by 1 order by 2 desc limit 20`,
          params,
        )
      ).rows
        .filter((r) => r.v)
        .map((r) => ({ value: String(r.v), count: r.c }));
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
    const rows = (await pool.query("select * from spans where org_id=$1 and trace_id=$2 order by start", [req.orgId, tid])).rows;
    const logs = (
      await pool.query("select id, ts, status, service, host, message from logs where org_id=$1 and trace_id=$2 order by ts limit 200", [req.orgId, tid])
    ).rows;
    res.json({
      spans: rows.map((r) => ({ ...r, id: String(r.id), start: Number(r.start), start_ms: Number(r.start_ms), duration: Number(r.duration) })),
      logs: logs.map((l) => ({ ...l, id: String(l.id), ts: Number(l.ts) })),
    });
  }),
);
// v2 spans search (POST .../search with {data:{attributes:{filter,page,sort}}}, or GET /api/v2/spans/events).
// Honors filter.from/to (default: last 15 minutes), page.limit (up to 1000) and page.cursor.
const spansSearchV2 = h(async (req, res) => {
  const started = Date.now();
  const s = v2Search(req, { bodyRoot: (body) => body?.data?.attributes, defaultLimit: 10, maxLimit: 1000 });
  const { where, params } = spanWhere(req.orgId!, s.query, s.from, s.to);
  let w = where;
  if (s.cursor) {
    params.push(Number(s.cursor[0]), String(s.cursor[1]));
    w += ` AND (start_ms, id) ${s.asc ? ">" : "<"} ($${params.length - 1}, $${params.length}::bigint)`;
  }
  const dir = s.asc ? "asc" : "desc";
  const rows = (await pool.query(`select * from spans where ${w} order by start_ms ${dir}, id ${dir} limit ${s.limit + 1}`, params)).rows;
  const { page, envelope } = v2Page(req, rows, s.limit, (r: any) => [Number(r.start_ms), String(r.id)], started);
  res.json({ data: page.map((r: any) => spanV2(r, String(r.id))), ...envelope });
});
export function spanV2(r: any, id: string) {
  const start = Number(r.start);
  return {
    id,
    type: "spans",
    attributes: {
      trace_id: String(r.trace_id),
      span_id: String(r.span_id),
      parent_id: String(r.parent_id ?? "0"),
      service: r.service,
      resource_name: r.resource,
      operation_name: r.name,
      type: r.type,
      env: r.env,
      host: r.host,
      status: Number(r.error) ? "error" : "ok",
      start_timestamp: new Date(Math.floor(start / 1e6)).toISOString(),
      end_timestamp: new Date(Math.floor((start + Number(r.duration)) / 1e6)).toISOString(),
      duration: Number(r.duration),
      custom: typeof r.meta === "string" ? JSON.parse(r.meta || "{}") : (r.meta ?? {}),
    },
  };
}
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
export { logWhere };

export default router;
