import type { Request } from "express";
import { HttpError, parseTime, pageLimit, decodeCursor, encodeCursor, nextLink } from "../lib/http";

/**
 * Request parameters of the v2 event search APIs (logs and spans), from either the POST body or the GET query
 * string (filter[query], filter[from], filter[to], page[limit], page[cursor], sort).
 */
export interface V2Search {
  query: string;
  from: number; // unix seconds
  to: number;
  limit: number;
  cursor: (string | number)[] | null;
  asc: boolean;
}

function flat(q: any, group: string, key: string) {
  return q?.[group]?.[key] ?? q?.[`${group}[${key}]`];
}

export function v2Search(req: Request, opts: { bodyRoot?: (body: any) => any; defaultLimit: number; maxLimit: number }): V2Search {
  const q: any = req.query ?? {};
  const body: any = req.body ?? {};
  const a = opts.bodyRoot ? (opts.bodyRoot(body) ?? {}) : body;
  const filter = a.filter ?? {};
  const now = Math.floor(Date.now() / 1000);
  const to = parseTime(filter.to ?? flat(q, "filter", "to"), now, now);
  const from = parseTime(filter.from ?? flat(q, "filter", "from"), to - 900, now);
  if (from > to) throw new HttpError(400, "filter.from must be before filter.to");
  const page = a.page ?? {};
  const limit = pageLimit(page.limit ?? flat(q, "page", "limit"), opts.defaultLimit, opts.maxLimit);
  const cursor = decodeCursor(page.cursor ?? flat(q, "page", "cursor"));
  const sort = String(a.sort ?? q.sort ?? "-timestamp");
  if (sort !== "timestamp" && sort !== "-timestamp") throw new HttpError(400, "sort must be timestamp or -timestamp");
  return { query: String(filter.query ?? flat(q, "filter", "query") ?? "*") || "*", from, to, limit, cursor, asc: sort === "timestamp" };
}

/** Response envelope with a next-page cursor when more rows exist (rows were fetched with limit + 1). */
export function v2Page<T>(req: Request, rows: T[], limit: number, keyOf: (row: T) => (string | number)[], started: number) {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const after = more && page.length ? encodeCursor(keyOf(page[page.length - 1])) : null;
  return {
    page,
    envelope: {
      ...(after ? { links: { next: nextLink(req, after) } } : {}),
      meta: { page: after ? { after } : {}, status: "done", elapsed: Date.now() - started },
    },
  };
}

/** Aggregations accepted by POST /api/v2/logs/analytics/aggregate. */
export const LOG_AGGREGATIONS = ["count", "cardinality", "sum", "min", "max", "avg", "median", "pc75", "pc90", "pc95", "pc98", "pc99"] as const;
export type LogAggregation = (typeof LOG_AGGREGATIONS)[number];
export const PERCENTILE: Record<string, number> = { median: 0.5, pc75: 0.75, pc90: 0.9, pc95: 0.95, pc98: 0.98, pc99: 0.99 };

export interface AggregateRequest {
  query: string;
  from: number;
  to: number;
  computes: { name: string; aggregation: LogAggregation; metric: string | null; timeseries: boolean; interval: number | null }[];
  groupBy: { facet: string; limit: number; sort: { order: "asc" | "desc"; byCompute: string | null; alphabetical: boolean } }[];
}

function intervalSeconds(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) return Math.max(1, Math.floor(Number(v) / 1000));
  const m = /^(\d+)(s|m|h|d)$/.exec(String(v));
  if (!m) throw new HttpError(400, `Invalid interval: ${String(v)}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

export function parseAggregate(body: any): AggregateRequest {
  const filter = body?.filter ?? {};
  const now = Math.floor(Date.now() / 1000);
  const to = parseTime(filter.to, now, now);
  const from = parseTime(filter.from, to - 900, now);
  if (from > to) throw new HttpError(400, "filter.from must be before filter.to");
  const rawComputes: any[] = Array.isArray(body?.compute) && body.compute.length ? body.compute : [{ aggregation: "count" }];
  if (rawComputes.length > 10) throw new HttpError(400, "At most 10 computes");
  const computes = rawComputes.map((c, i) => {
    const aggregation = String(c?.aggregation ?? "count") as LogAggregation;
    if (!LOG_AGGREGATIONS.includes(aggregation)) throw new HttpError(400, `Unsupported aggregation: ${aggregation}`);
    const metric = c?.metric ? String(c.metric) : null;
    if (aggregation !== "count" && !metric) throw new HttpError(400, `Aggregation ${aggregation} needs a metric (for example @duration)`);
    const timeseries = c?.type === "timeseries";
    if (c?.type && c.type !== "total" && c.type !== "timeseries") throw new HttpError(400, `Unsupported compute type: ${c.type}`);
    return { name: `c${i}`, aggregation, metric, timeseries, interval: timeseries ? intervalSeconds(c.interval) : null };
  });
  const rawGroups: any[] = Array.isArray(body?.group_by) ? body.group_by : [];
  if (rawGroups.length > 4) throw new HttpError(400, "At most 4 group_by facets");
  const groupBy = rawGroups.map((g) => {
    if (!g?.facet) throw new HttpError(400, "group_by entries need a facet");
    const limit = pageLimit(g.limit, 10, 10000);
    const s = g.sort ?? {};
    const order = s.order === "asc" ? "asc" : "desc";
    const alphabetical = s.type === "alphabetical";
    let byCompute: string | null = null;
    if (!alphabetical) {
      const idx = s.aggregation ? computes.findIndex((c) => c.aggregation === s.aggregation && (!s.metric || c.metric === s.metric)) : 0;
      byCompute = computes[Math.max(0, idx)].name;
    }
    return { facet: String(g.facet), limit, sort: { order: order as "asc" | "desc", byCompute, alphabetical } };
  });
  return { query: String(filter.query ?? "*") || "*", from, to, computes, groupBy };
}

/**
 * Splits computes into query passes: one for all totals (no time grouping) and one per distinct timeseries interval,
 * so a total is never replaced by its last time bucket and each timeseries keeps its own interval.
 */
export function aggregatePasses(
  req: AggregateRequest,
  auto: (from: number, to: number) => number,
): { interval: number | null; computes: AggregateRequest["computes"] }[] {
  const passes: { interval: number | null; computes: AggregateRequest["computes"] }[] = [];
  const totals = req.computes.filter((c) => !c.timeseries);
  if (totals.length) passes.push({ interval: null, computes: totals });
  const byInterval = new Map<number, AggregateRequest["computes"]>();
  for (const c of req.computes.filter((x) => x.timeseries)) {
    const iv = c.interval ?? auto(req.from, req.to);
    byInterval.set(iv, [...(byInterval.get(iv) ?? []), c]);
  }
  for (const [interval, computes] of byInterval) passes.push({ interval, computes });
  return passes;
}

/** Merges the buckets of several passes (same group-by) into one bucket per group. */
export function mergeBuckets(parts: { by: Record<string, string>; computes: Record<string, unknown> }[][]) {
  const m = new Map<string, { by: Record<string, string>; computes: Record<string, unknown> }>();
  for (const part of parts)
    for (const b of part) {
      const k = JSON.stringify(b.by);
      const cur = m.get(k);
      if (cur) Object.assign(cur.computes, b.computes);
      else m.set(k, { by: b.by, computes: { ...b.computes } });
    }
  return [...m.values()];
}

/** Shape aggregate rows into response buckets: one bucket per group, with total or timeseries computes. */
export function toBuckets(req: AggregateRequest, rows: any[]): { by: Record<string, string>; computes: Record<string, unknown> }[] {
  const ts = req.computes.some((c) => c.timeseries);
  const groups = new Map<string, { by: Record<string, string>; computes: Record<string, any> }>();
  for (const r of rows) {
    const by: Record<string, string> = {};
    req.groupBy.forEach((g, i) => {
      by[g.facet] = r[`g${i}`] === null || r[`g${i}`] === undefined || r[`g${i}`] === "" ? "N/A" : String(r[`g${i}`]);
    });
    const key = JSON.stringify(by);
    let b = groups.get(key);
    if (!b) groups.set(key, (b = { by, computes: {} }));
    for (const c of req.computes) {
      const v = r[c.name] === null || r[c.name] === undefined ? null : Number(r[c.name]);
      if (c.timeseries) (b.computes[c.name] ??= []).push({ time: new Date(Number(r.t) * 1000).toISOString(), value: v });
      else b.computes[c.name] = v;
    }
  }
  void ts;
  return [...groups.values()];
}

/** The bucket width used for timeseries computes (the first timeseries compute's interval, or an automatic one). */
export function aggregateInterval(req: AggregateRequest, auto: (from: number, to: number) => number): number {
  const c = req.computes.find((x) => x.timeseries);
  return c?.interval ?? auto(req.from, req.to);
}

/**
 * Apply each group_by level's limit and sort: the top `limit` values of the first facet (by the
 * chosen compute, summed over time and nested groups), then the top values of the next facet within each of those.
 */
export function limitBuckets<B extends { by: Record<string, string>; computes: Record<string, unknown> }>(req: AggregateRequest, buckets: B[], level = 0): B[] {
  if (level >= req.groupBy.length) return buckets;
  const g = req.groupBy[level];
  const byValue = new Map<string, B[]>();
  for (const b of buckets) {
    const v = b.by[g.facet];
    let list = byValue.get(v);
    if (!list) byValue.set(v, (list = []));
    list.push(b);
  }
  const score = (list: B[]) => {
    if (!g.sort.byCompute) return 0;
    let t = 0;
    for (const b of list) {
      const c = b.computes[g.sort.byCompute];
      if (Array.isArray(c)) for (const p of c) t += Number((p as any).value ?? 0);
      else t += Number(c ?? 0);
    }
    return t;
  };
  const ranked = [...byValue.entries()].map(([v, list]) => ({ v, list, s: score(list) }));
  ranked.sort((a, b) => {
    const d = g.sort.alphabetical ? a.v.localeCompare(b.v) : a.s - b.s;
    return g.sort.order === "asc" ? d : -d;
  });
  return ranked.slice(0, g.limit).flatMap((r) => limitBuckets(req, r.list, level + 1));
}
