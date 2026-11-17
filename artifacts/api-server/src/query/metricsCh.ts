/** Metric storage reads for ClickHouse (DATACAT_STORAGE=clickhouse). Query parsing, grouping and formulas stay in metrics.ts. */
import { chQuery, ChParams, ensureChSchema } from "../lib/ch";

/** Series of a metric that reported since `since`; FINAL collapses metadata rows not yet merged by ReplacingMergeTree. */
export async function seriesCh(orgId: number, metric: string, since: number) {
  await ensureChSchema();
  const b = new ChParams();
  const rows = await chQuery(
    `SELECT series_id AS id, host, tags, type FROM metric_series FINAL
    WHERE org_id = ${b.p(orgId, "UInt32")} AND metric = ${b.p(metric)} AND last_seen >= ${b.p(Math.max(0, since), "UInt32")}`,
    b.params,
  );
  return rows.map((r: any) => ({ id: Number(r.id), host: r.host as string, tags: r.tags as string[], type: r.type as string }));
}

/** Time aggregation per series and bucket, then space aggregation per group, both in ClickHouse; one row per group per bucket. */
export async function aggregateCh(
  orgId: number,
  metric: string,
  ids: number[],
  groups: number[],
  timeAgg: string,
  spaceAgg: string,
  step: number,
  from: number,
  to: number,
) {
  const timeCol =
    { avg: "avg(value)", sum: "sum(value)", min: "min(value)", max: "max(value)", count: "toFloat64(count())", last: "argMax(value, ts)" }[timeAgg] ??
    "avg(value)";
  const spaceCol = { sum: "sum(v)", min: "min(v)", max: "max(v)", count: "count()" }[spaceAgg] ?? "avg(v)";
  const b = new ChParams();
  // (series id, group index) pairs go to ClickHouse as an external table
  const tsv = ids.map((id, i) => `${id}\t${groups[i]}`).join("\n");
  return chQuery(
    `SELECT g, b, ${spaceCol} AS v FROM (
      SELECT series_id, intDiv(ts, ${step}) * ${step} AS b, ${timeCol} AS v FROM metric_points
      WHERE org_id = ${b.p(orgId, "UInt32")} AND metric = ${b.p(metric)} AND ts >= ${b.p(from, "UInt32")} AND ts < ${b.p(to, "UInt32")}
        AND series_id IN (SELECT id FROM sel) GROUP BY series_id, b
    ) AS p INNER JOIN sel ON sel.id = p.series_id GROUP BY g, b ORDER BY g, b`,
    b.params,
    { external: [{ name: "sel", structure: "id UInt64, g UInt32", tsv }] },
  ) as Promise<{ g: number; b: number; v: number }[]>;
}

/** Distribution metrics: one aggregation over all raw values of each (group, bucket); agg "p:<q>" is a percentile. */
export async function aggregateDistributionCh(
  orgId: number,
  metric: string,
  ids: number[],
  groups: number[],
  agg: string,
  step: number,
  from: number,
  to: number,
) {
  // agg "values": one row per distinct value with its total weight (percentiles are computed by the caller)
  const col =
    agg === "values"
      ? "p.value AS v, sum(p.weight) AS w"
      : `${({ sum: "sum(p.value * p.weight)", min: "min(p.value)", max: "max(p.value)", count: "sum(p.weight)" } as Record<string, string>)[agg] ?? "sum(p.value * p.weight) / nullIf(sum(p.weight), 0)"} AS v`;
  const b = new ChParams();
  const tsv = ids.map((id, i) => `${id}\t${groups[i]}`).join("\n");
  return chQuery(
    `SELECT sel.g AS g, intDiv(p.ts, ${step}) * ${step} AS b, ${col} FROM metric_points AS p INNER JOIN sel ON sel.id = p.series_id
    WHERE p.org_id = ${b.p(orgId, "UInt32")} AND p.metric = ${b.p(metric)} AND p.ts >= ${b.p(from, "UInt32")} AND p.ts < ${b.p(to, "UInt32")}
    GROUP BY g, b${agg === "values" ? ", p.value" : ""} ORDER BY g, b`,
    b.params,
    { external: [{ name: "sel", structure: "id UInt64, g UInt32", tsv }] },
  ) as Promise<{ g: number; b: number; v: number; w?: number }[]>;
}

export async function listMetricsCh(orgId: number, search: string, limit: number) {
  await ensureChSchema();
  const b = new ChParams();
  const r = await chQuery(
    `SELECT metric, max(type) AS type, toUInt32(uniqExact(series_id)) AS series, max(last_seen) AS last_seen FROM metric_series
    WHERE org_id = ${b.p(orgId, "UInt32")} AND metric ILIKE ${b.p(`%${search}%`)} GROUP BY metric ORDER BY metric LIMIT ${Math.min(5000, Number(limit) || 500)}`,
    b.params,
  );
  return r.map((x: any) => ({ metric: x.metric as string, type: x.type as string, series: Number(x.series), last_seen: Number(x.last_seen) }));
}

export async function metricTagsCh(orgId: number, metric: string) {
  await ensureChSchema();
  const b = new ChParams();
  const w = `org_id = ${b.p(orgId, "UInt32")} ${metric ? `AND metric = ${b.p(metric)}` : ""}`;
  const r = await chQuery(`SELECT DISTINCT arrayJoin(tags) AS t FROM metric_series WHERE ${w} LIMIT 2000`, b.params);
  const h = await chQuery(`SELECT DISTINCT host FROM metric_series WHERE ${w} AND host != '' LIMIT 1000`, b.params);
  return { tags: r.map((x: any) => x.t as string).sort(), hosts: h.map((x: any) => x.host as string).sort() };
}

/** Recent average of a few system metrics per host, for the host list. */
export async function hostMetricsCh(orgId: number, metrics: string[], since: number) {
  const b = new ChParams();
  return chQuery(
    `SELECT host, metric, avg(value) AS v FROM metric_points
    WHERE org_id = ${b.p(orgId, "UInt32")} AND metric IN (${metrics.map((m) => b.p(m)).join(", ")}) AND ts > ${b.p(since, "UInt32")} AND host != ''
    GROUP BY host, metric`,
    b.params,
  ) as Promise<{ host: string; metric: string; v: number }[]>;
}
