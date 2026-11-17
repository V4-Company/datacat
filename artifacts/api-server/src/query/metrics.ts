import { pool } from "@workspace/db";
import { useClickHouse } from "../lib/storage";
import { seriesCh, aggregateCh, aggregateDistributionCh, listMetricsCh, metricTagsCh } from "./metricsCh";
import { HttpError } from "../lib/http";

// ---------------- Types ----------------
export interface Series {
  key: string; // group key, "*" when ungrouped
  tags: string[]; // group tags e.g. ["host:a"]
  points: Map<number, number>; // bucket ts (s) -> value
  metric?: string;
  /** bucket width in seconds actually used (a .rollup() can make it wider than the requested interval) */
  interval?: number;
}
export type SeriesSet = Series[];

export interface MetricQuery {
  spaceAgg: string;
  metric: string;
  filter: FilterNode | null;
  groupBy: string[];
  fns: { name: string; args: string[] }[];
  raw: string;
}

type FilterNode =
  { t: "and" | "or"; c: FilterNode[] } | { t: "not"; c: FilterNode } | { t: "term"; key: string; value: string } | { t: "in"; key: string; values: string[] };

// ---------------- Filter parsing ----------------
function tokenizeFilter(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      out.push(ch);
      i++;
      continue;
    }
    let j = i;
    let quoted = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '"') quoted = !quoted;
      if (!quoted && (/\s/.test(c) || c === "(" || c === ")" || c === ",")) break;
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export function parseFilter(s: string): FilterNode | null {
  const src = s.trim();
  if (!src || src === "*") return null;
  const toks = tokenizeFilter(src);
  for (const t of toks)
    if ((t.match(/[*?]/g)?.length ?? 0) > MAX_WILDCARDS) throw new HttpError(400, `A tag filter may use at most ${MAX_WILDCARDS} wildcards`);
  let p = 0;
  const peek = () => toks[p];
  function parseOr(): FilterNode {
    const parts = [parseAnd()];
    while (peek() && peek().toUpperCase() === "OR") {
      p++;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { t: "or", c: parts };
  }
  function parseAnd(): FilterNode {
    const parts = [parseUnary()];
    while (peek() && peek() !== ")" && peek().toUpperCase() !== "OR") {
      if (peek() === "," || peek().toUpperCase() === "AND") {
        p++;
        continue;
      }
      parts.push(parseUnary());
    }
    return parts.length === 1 ? parts[0] : { t: "and", c: parts };
  }
  function parseUnary(): FilterNode {
    const tk = peek();
    if (!tk) return { t: "and", c: [] };
    if (tk.toUpperCase() === "NOT") {
      p++;
      return { t: "not", c: parseUnary() };
    }
    if (tk === "(") {
      p++;
      const n = parseOr();
      if (peek() === ")") p++;
      return n;
    }
    p++;
    let neg = false;
    let term = tk;
    if (term.startsWith("!") || term.startsWith("-")) {
      neg = true;
      term = term.slice(1);
    }
    // key IN (a, b)
    if (peek() && peek().toUpperCase() === "IN" && toks[p + 1] === "(") {
      p += 2;
      const values: string[] = [];
      while (peek() && peek() !== ")") {
        if (peek() !== ",") values.push(peek().replace(/"/g, ""));
        p++;
      }
      p++;
      const n: FilterNode = { t: "in", key: term, values };
      return neg ? { t: "not", c: n } : n;
    }
    if (peek() && peek().toUpperCase() === "NOT" && toks[p + 1]?.toUpperCase() === "IN") {
      p += 3;
      const values: string[] = [];
      while (peek() && peek() !== ")") {
        if (peek() !== ",") values.push(peek().replace(/"/g, ""));
        p++;
      }
      p++;
      return { t: "not", c: { t: "in", key: term, values } };
    }
    const idx = term.indexOf(":");
    const n: FilterNode = idx >= 0 ? { t: "term", key: term.slice(0, idx), value: term.slice(idx + 1).replace(/"/g, "") } : { t: "term", key: term, value: "" };
    return neg ? { t: "not", c: n } : n;
  }
  return parseOr();
}

const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
/**
 * Case-insensitive glob match ("*" any run of characters, "?" one character; neither crosses a line break). Greedy
 * matching that backs up only to the most recent "*", so the cost stays proportional to pattern × value length.
 */
export function globMatch(pattern: string, v: string) {
  if (pattern === "*") return true;
  const p = pattern.toLowerCase();
  const s = v.toLowerCase();
  if (!p.includes("*") && !p.includes("?")) return p === s;
  let i = 0,
    j = 0,
    star = -1,
    mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] !== "*" && (p[i] === s[j] || (p[i] === "?" && !isLineBreak(s.charCodeAt(j))))) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0 && !isLineBreak(s.charCodeAt(mark))) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}
const MAX_WILDCARDS = 20;

const normTag = (v: string) => v.toLowerCase().replace(/[^a-z0-9_:./\-*?]+/g, "_");

export function matchTags(node: FilterNode | null, tags: string[]): boolean {
  if (!node) return true;
  switch (node.t) {
    case "and":
      return node.c.every((c) => matchTags(c, tags));
    case "or":
      return node.c.some((c) => matchTags(c, tags));
    case "not":
      return !matchTags(node.c, tags);
    case "in":
      return node.values.some((v) => matchTags({ t: "term", key: node.key, value: v }, tags));
    case "term": {
      if (!node.value) return tags.some((t) => globMatch(node.key, t));
      return tags.some((t) => {
        const i = t.indexOf(":");
        if (i < 0) return false;
        if (!globMatch(node.key, t.slice(0, i))) return false;
        const v = t.slice(i + 1);
        // Tag normalization: values are lowercased and spaces become underscores (resource_name:post_/checkout)
        return globMatch(node.value!, v) || globMatch(normTag(node.value!), normTag(v));
      });
    }
  }
}

// ---------------- Query parsing ----------------
const SPACE_AGGS = ["avg", "sum", "min", "max", "count"];
/** p50, p75, p90, p95, p99, p99.9 ... (only valid on distribution metrics) */
export const percentileOf = (agg: string): number | null => {
  const m = /^p(\d{1,2}(?:\.\d+)?)$/.exec(agg);
  return m && Number(m[1]) > 0 && Number(m[1]) < 100 ? Number(m[1]) / 100 : null;
};

/** Parse one metric query starting at position i of s. Returns query and end index. */
export function parseMetricQueryAt(s: string, i: number): { q: MetricQuery; end: number } | null {
  const m = /^(avg|sum|min|max|count|p\d{1,2}(?:\.\d+)?):/.exec(s.slice(i));
  let spaceAgg = "avg";
  let j = i;
  if (m) {
    spaceAgg = m[1];
    j += m[0].length;
  }
  const mm = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(j));
  if (!mm) return null;
  const metric = mm[0];
  j += metric.length;
  let filterStr = "*";
  if (s[j] === "{") {
    let depth = 0;
    let k = j;
    for (; k < s.length; k++) {
      if (s[k] === "{") depth++;
      else if (s[k] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    filterStr = s.slice(j + 1, k);
    j = k + 1;
  } else if (!m) return null;
  let groupBy: string[] = [];
  const by = /^\s*by\s*\{([^}]*)\}/i.exec(s.slice(j));
  if (by) {
    groupBy = by[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    j += by[0].length;
  }
  const fns: { name: string; args: string[] }[] = [];
  for (;;) {
    const f = /^\.([a-z_]+)\(([^)]*)\)/i.exec(s.slice(j));
    if (!f) break;
    fns.push({
      name: f[1],
      args: f[2]
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    });
    j += f[0].length;
  }
  return {
    q: {
      spaceAgg: SPACE_AGGS.includes(spaceAgg) || percentileOf(spaceAgg) !== null ? spaceAgg : "avg",
      metric,
      filter: parseFilter(filterStr),
      groupBy,
      fns,
      raw: s.slice(i, j),
    },
    end: j,
  };
}

export function parseMetricQuery(s: string): MetricQuery {
  const r = parseMetricQueryAt(s.trim(), 0);
  if (!r) throw new Error(`Could not parse metric query: ${s}`);
  return r.q;
}

/** Replace inline metric queries inside an arithmetic expression with placeholders. */
export function extractInlineQueries(expr: string, prefix = "__q"): { formula: string; queries: Record<string, string> } {
  const queries: Record<string, string> = {};
  let out = "";
  let i = 0;
  let n = 0;
  while (i < expr.length) {
    const prev = out.trimEnd().slice(-1);
    const atBoundary = i === 0 || /[\s(+\-*/,]/.test(expr[i - 1]);
    if (atBoundary && /[A-Za-z]/.test(expr[i])) {
      const r = parseMetricQueryAt(expr, i);
      // only treat as metric query if it has an aggregator or a {filter}
      if (r && (/^(avg|sum|min|max|count):/.test(expr.slice(i)) || r.q.raw.includes("{"))) {
        const name = `${prefix}${n++}`;
        queries[name] = r.q.raw;
        out += name;
        i = r.end;
        continue;
      }
    }
    void prev;
    out += expr[i];
    i++;
  }
  return { formula: out, queries };
}

// ---------------- Execution ----------------
const NICE = [10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
export function pickInterval(from: number, to: number, target = 180): number {
  const span = Math.max(1, to - from);
  for (const n of NICE) if (span / n <= target) return n;
  return 86400;
}

function tagValue(tags: string[], key: string): string {
  const p = key + ":";
  const t = tags.find((t) => t.startsWith(p));
  return t ? t.slice(p.length) : "N/A";
}

export async function runMetricQuery(
  orgId: number,
  q: MetricQuery,
  from: number,
  to: number,
  interval: number,
  vars: Record<string, string> = {},
): Promise<SeriesSet> {
  // apply template variables
  let filter = q.filter;
  if (Object.keys(vars).length) {
    const sub = (n: FilterNode | null): FilterNode | null => {
      if (!n) return n;
      if (n.t === "term") {
        const v = n.value.replace(
          /^\$([A-Za-z0-9_]+)(\.value)?$/,
          (_m, name) => vars[`${name}.value`] ?? (vars[name]?.includes(":") ? vars[name].split(":").slice(1).join(":") : vars[name]) ?? "*",
        );
        const k = n.key.replace(/^\$([A-Za-z0-9_]+)$/, (_m, name) => vars[name] ?? "*");
        if (k.includes(":")) {
          const i = k.indexOf(":");
          return { t: "term", key: k.slice(0, i), value: k.slice(i + 1) };
        }
        if (v === "*" || k === "*") return null;
        return { ...n, key: k, value: v };
      }
      if (n.t === "not") {
        const c = sub(n.c);
        return c ? { t: "not", c } : null;
      }
      if (n.t === "and" || n.t === "or") return { t: n.t, c: n.c.map(sub).filter(Boolean) as FilterNode[] };
      return n;
    };
    filter = sub(filter);
  }
  // Only series that reported during (or just before) the window can have points in it. last_seen is
  // refreshed at most every 5 minutes at intake (store.ts), so a 15-minute margin is safe.
  const srows = useClickHouse
    ? await seriesCh(orgId, q.metric, from - 900)
    : (await pool.query("select id, host, tags, type from metric_series where org_id=$1 and metric=$2 and last_seen >= $3", [orgId, q.metric, from - 900]))
        .rows;
  const matched = srows
    .map((r) => ({ id: r.id as number, type: r.type as string, tags: [...(r.tags as string[]), ...(r.host ? [`host:${r.host}`] : [])] }))
    .filter((r) => matchTags(filter, r.tags));
  if (!matched.length) return [];
  let rollAgg: string | null = null;
  let rollInterval = interval;
  let asCount = false;
  let asRate = false;
  for (const f of q.fns) {
    if (f.name === "rollup") {
      for (const a of f.args) {
        if (/^\d+$/.test(a)) rollInterval = Math.max(interval, Number(a));
        else rollAgg = a.replace(/['"]/g, "");
      }
    } else if (f.name === "as_count") asCount = true;
    else if (f.name === "as_rate") asRate = true;
  }
  const type = matched[0].type;
  const pct = percentileOf(q.spaceAgg);
  if (pct !== null && type !== "distribution")
    throw new HttpError(400, `Percentile aggregator ${q.spaceAgg} needs a distribution metric; ${q.metric} is a ${type}`);
  if (type === "distribution")
    return runDistributionQuery(
      orgId,
      q,
      matched.map((m) => m.id),
      gOfGroups(q, matched),
      rollInterval,
      from,
      to,
    );
  const timeAgg = rollAgg ?? (type === "count" ? "sum" : "avg");
  const col =
    { avg: "avg(value)", sum: "sum(value)", min: "min(value)", max: "max(value)", count: "count(*)", last: "(array_agg(value order by ts desc))[1]" }[
      timeAgg
    ] ?? "avg(value)";
  // Group membership is decided here (tag parsing), the time and space aggregation run in Postgres, so
  // only one row per group per bucket comes back instead of one per series per bucket (which is
  // millions of rows for high-cardinality metrics).
  const groupIdx = new Map<string, number>();
  const groupList: { key: string; tags: string[] }[] = [];
  const gOf = new Array<number>(matched.length);
  matched.forEach((s, i) => {
    const gtags = q.groupBy.map((g) => `${g}:${tagValue(s.tags, g)}`);
    const key = gtags.length ? gtags.join(",") : "*";
    let gi = groupIdx.get(key);
    if (gi === undefined) {
      gi = groupList.length;
      groupIdx.set(key, gi);
      groupList.push({ key, tags: gtags });
    }
    gOf[i] = gi;
  });
  const spaceCol = { sum: "sum(p.v)", min: "min(p.v)", max: "max(p.v)", count: "count(*)" }[q.spaceAgg] ?? "avg(p.v)";
  const pr = useClickHouse
    ? {
        rows: await aggregateCh(
          orgId,
          q.metric,
          matched.map((m) => m.id),
          gOf,
          timeAgg,
          q.spaceAgg,
          rollInterval,
          from,
          to,
        ),
      }
    : await pool.query(
        `with s as (select * from unnest($1::int[], $2::int[]) as s(id, g)),
          p as (select series_id, (ts / $3) * $3 as b, ${col} as v from metric_points
                where series_id = any($1) and ts >= $4 and ts < $5 group by 1, 2)
     select s.g, p.b, ${spaceCol} as v from p join s on s.id = p.series_id group by 1, 2 order by 1, 2`,
        [matched.map((m) => m.id), gOf, rollInterval, from, to],
      );
  // as_rate / as_count scaling is linear, so applying it after sum/avg/min/max equals applying it per series
  const scale = q.spaceAgg === "count" ? 1 : type === "count" && asRate ? 1 / rollInterval : type === "rate" && asCount ? rollInterval : 1;
  const pointsByGroup = new Map<number, Map<number, number>>();
  for (const r of pr.rows) {
    let m = pointsByGroup.get(r.g);
    if (!m) pointsByGroup.set(r.g, (m = new Map()));
    m.set(Number(r.b), Number(r.v) * scale);
  }
  const out: SeriesSet = [];
  for (const [gi, points] of pointsByGroup) out.push({ key: groupList[gi].key, tags: groupList[gi].tags, points, metric: q.metric, interval: rollInterval });
  // post functions applied per-series
  for (const f of q.fns) if (f.name === "fill") fillSeries(out, f.args[0] ?? "null", from, to, rollInterval);
  return out;
}

function spaceAggregate(agg: string, vs: number[]): number {
  switch (agg) {
    case "sum":
      return vs.reduce((a, b) => a + b, 0);
    case "min":
      return Math.min(...vs);
    case "max":
      return Math.max(...vs);
    case "count":
      return vs.length;
    default:
      return vs.reduce((a, b) => a + b, 0) / vs.length;
  }
}

function fillSeries(set: SeriesSet, mode: string, from: number, to: number, interval: number) {
  if (mode === "null" || !(interval > 0)) return;
  for (const s of set) {
    let last: number | undefined;
    for (let b = Math.floor(from / interval) * interval; b < to; b += interval) {
      if (s.points.has(b)) last = s.points.get(b);
      else if (mode === "zero") s.points.set(b, 0);
      else if (mode === "last" && last !== undefined) s.points.set(b, last);
    }
    s.points = new Map([...s.points].sort((a, b) => a[0] - b[0]));
  }
}

/** Group index of every matched series, and the group list (tag sets), for a query's group-by. */
function gOfGroups(q: MetricQuery, matched: { tags: string[] }[]) {
  const groupIdx = new Map<string, number>();
  const groups: { key: string; tags: string[] }[] = [];
  const gOf = matched.map((s) => {
    const gtags = q.groupBy.map((g) => `${g}:${tagValue(s.tags, g)}`);
    const key = gtags.length ? gtags.join(",") : "*";
    let gi = groupIdx.get(key);
    if (gi === undefined) {
      gi = groups.length;
      groupIdx.set(key, gi);
      groups.push({ key, tags: gtags });
    }
    return gi;
  });
  return { gOf, groups };
}

/**
 * Distribution metrics keep every submitted value, so avg/sum/min/max/count and percentiles are computed over all
 * values of a group in each bucket (globally accurate), in one aggregation step.
 */
async function runDistributionQuery(
  orgId: number,
  q: MetricQuery,
  ids: number[],
  g: { gOf: number[]; groups: { key: string; tags: string[] }[] },
  step: number,
  from: number,
  to: number,
): Promise<SeriesSet> {
  const pct = percentileOf(q.spaceAgg);
  const agg = pct !== null ? "values" : q.spaceAgg;
  let rows: { g: number; b: number; v: number }[];
  if (useClickHouse) rows = await aggregateDistributionCh(orgId, q.metric, ids, g.gOf, agg, step, from, to);
  else {
    const w = "coalesce(p.weight, 1)";
    const col =
      agg === "values"
        ? `p.value as v, sum(${w}) as w`
        : `${({ sum: `sum(p.value * ${w})`, min: "min(p.value)", max: "max(p.value)", count: `sum(${w})::double precision` } as Record<string, string>)[agg] ?? `sum(p.value * ${w}) / nullif(sum(${w}), 0)`} as v`;
    rows = (
      await pool.query(
        `with s as (select * from unnest($1::int[], $2::int[]) as s(id, g))
         select s.g, (p.ts / $3) * $3 as b, ${col}
         from metric_points p join s on s.id = p.series_id where p.series_id = any($1) and p.ts >= $4 and p.ts < $5
         group by 1, 2${agg === "values" ? ", p.value" : ""} order by 1, 2`,
        [ids, g.gOf, step, from, to],
      )
    ).rows;
  }
  if (pct !== null) rows = weightedPercentileRows(rows as any, pct);
  const byGroup = new Map<number, Map<number, number>>();
  for (const r of rows as { g: number; b: number; v: number }[]) {
    let m = byGroup.get(Number(r.g));
    if (!m) byGroup.set(Number(r.g), (m = new Map()));
    m.set(Number(r.b), Number(r.v));
  }
  const out: SeriesSet = [];
  for (const [gi, points] of byGroup) out.push({ key: g.groups[gi].key, tags: g.groups[gi].tags, points, metric: q.metric, interval: step });
  for (const f of q.fns) if (f.name === "fill") fillSeries(out, f.args[0] ?? "null", from, to, step);
  return out;
}

// ---------------- Formula evaluation ----------------
type Val = number | SeriesSet;

function tokenizeFormula(s: string): string[] {
  const re = /\s*([A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?(?:e[+-]?\d+)?|'[^']*'|"[^"]*"|[()+\-*/,])/gy;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

function binop(op: string, a: Val, b: Val): Val {
  const f = (x: number, y: number) => (op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : y === 0 ? NaN : x / y);
  if (typeof a === "number" && typeof b === "number") return f(a, b);
  if (typeof a === "number") return (b as SeriesSet).map((s) => mapPoints(s, (v) => f(a, v)));
  if (typeof b === "number") return (a as SeriesSet).map((s) => mapPoints(s, (v) => f(v, b)));
  const A = a as SeriesSet,
    B = b as SeriesSet;
  const additive = op === "+" || op === "-";
  if (additive && B.length === 0) return A;
  if (additive && A.length === 0) return op === "+" ? B : B.map((s) => mapPoints(s, (v) => -v));
  const out: SeriesSet = [];
  const bIndex = new Map(B.map((s) => [s.key, s]));
  // An ungrouped series ("*") applies to every group of the other side; grouped series combine only when their group
  // keys are equal. For + and -, a group present on one side only is kept (the missing side counts as 0).
  const bAll = B.length === 1 && B[0].key === "*" ? B[0] : undefined;
  const aAll = A.length === 1 && A[0].key === "*" ? A[0] : undefined;
  const empty: Series = { key: "", tags: [], points: new Map() };
  for (const sa of A) {
    let sb = bIndex.get(sa.key) ?? bAll;
    if (!sb && aAll && B.length > 1) break; // handled below: A is ungrouped, B is grouped
    if (!sb && additive) sb = { ...empty, key: sa.key, tags: sa.tags };
    if (!sb) continue;
    const pts = new Map<number, number>();
    for (const [t, v] of sa.points) {
      const w = sb.points.get(t) ?? (additive ? 0 : undefined);
      if (w !== undefined) {
        const r = f(v, w);
        if (Number.isFinite(r)) pts.set(t, r);
      }
    }
    if (additive)
      for (const [t, w] of sb.points)
        if (!sa.points.has(t)) {
          const r = f(0, w);
          if (Number.isFinite(r)) pts.set(t, r);
        }
    out.push({ key: sa.key, tags: sa.tags.length ? sa.tags : sb.tags, points: pts });
  }
  if (additive && !aAll && !bAll) {
    const aKeys = new Set(A.map((s) => s.key));
    for (const sb of B)
      if (!aKeys.has(sb.key)) {
        const pts = new Map<number, number>();
        for (const [t, w] of sb.points) {
          const r = f(0, w);
          if (Number.isFinite(r)) pts.set(t, r);
        }
        out.push({ key: sb.key, tags: sb.tags, points: pts });
      }
  }
  if (aAll && B.length > 1) {
    return B.map((sb) => {
      const pts = new Map<number, number>();
      for (const [t, w] of sb.points) {
        const v = A[0].points.get(t);
        if (v !== undefined) {
          const r = f(v, w);
          if (Number.isFinite(r)) pts.set(t, r);
        }
      }
      return { key: sb.key, tags: sb.tags, points: pts };
    });
  }
  return out;
}

function mapPoints(s: Series, fn: (v: number, t: number) => number): Series {
  const pts = new Map<number, number>();
  for (const [t, v] of s.points) {
    const r = fn(v, t);
    if (Number.isFinite(r)) pts.set(t, r);
  }
  return { key: s.key, tags: s.tags, points: pts, metric: s.metric, interval: s.interval };
}

function applyFn(name: string, args: Val[], interval: number): Val {
  const x = args[0];
  const asSet = (v: Val): SeriesSet => (typeof v === "number" ? [] : v);
  switch (name) {
    case "abs":
      return typeof x === "number" ? Math.abs(x) : asSet(x).map((s) => mapPoints(s, Math.abs));
    case "log10":
      return typeof x === "number" ? Math.log10(x) : asSet(x).map((s) => mapPoints(s, Math.log10));
    case "log2":
      return typeof x === "number" ? Math.log2(x) : asSet(x).map((s) => mapPoints(s, Math.log2));
    case "per_second":
      return asSet(x).map((s) => mapPoints(s, (v) => v / interval));
    case "per_minute":
      return asSet(x).map((s) => mapPoints(s, (v) => (v / interval) * 60));
    case "per_hour":
      return asSet(x).map((s) => mapPoints(s, (v) => (v / interval) * 3600));
    case "cumsum":
      return asSet(x).map((s) => {
        let acc = 0;
        return mapPoints(s, (v) => (acc += v));
      });
    case "diff":
      return asSet(x).map((s) => {
        let prev: number | undefined;
        return mapPoints(s, (v) => {
          const r = prev === undefined ? NaN : v - prev;
          prev = v;
          return r;
        });
      });
    case "derivative":
      return asSet(x).map((s) => {
        let prev: number | undefined;
        return mapPoints(s, (v) => {
          const r = prev === undefined ? NaN : (v - prev) / interval;
          prev = v;
          return r;
        });
      });
    case "default_zero":
      return asSet(x);
    case "count_nonzero":
    case "count_not_null": {
      const pts = new Map<number, number>();
      for (const s of asSet(x)) for (const [t, v] of s.points) if (name === "count_not_null" || v !== 0) pts.set(t, (pts.get(t) ?? 0) + 1);
      return [{ key: "*", tags: [], points: new Map([...pts].sort((a, b) => a[0] - b[0])) }];
    }
    case "top":
    case "top10":
    case "top5": {
      const n = name === "top5" ? 5 : name === "top10" ? 10 : typeof args[1] === "number" ? args[1] : 10;
      const ranked = asSet(x)
        .map((s) => ({ s, m: reduce([...s.points.values()], "avg") }))
        .sort((a, b) => b.m - a.m);
      return ranked.slice(0, n).map((r) => r.s);
    }
    default:
      throw new Error(`Unsupported function ${name}()`);
  }
}

export function evalFormula(formula: string, env: Record<string, SeriesSet>, interval: number): SeriesSet {
  const toks = tokenizeFormula(formula);
  let p = 0;
  const peek = () => toks[p];
  function expr(): Val {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = toks[p++];
      v = binop(op, v, term());
    }
    return v;
  }
  function term(): Val {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = toks[p++];
      v = binop(op, v, factor());
    }
    return v;
  }
  function factor(): Val {
    const t = toks[p++];
    if (t === undefined) throw new Error("Unexpected end of formula");
    if (t === "-") return binop("*", -1, factor());
    if (t === "(") {
      const v = expr();
      p++;
      return v;
    }
    if (/^\d/.test(t)) return Number(t);
    if (/^['"]/.test(t)) return NaN;
    if (peek() === "(") {
      p++;
      const args: Val[] = [];
      while (peek() !== ")" && peek() !== undefined) {
        if (peek() === ",") {
          p++;
          continue;
        }
        if (/^['"]/.test(peek())) {
          p++;
          continue;
        }
        args.push(expr());
      }
      p++;
      return applyFn(t, args, interval);
    }
    if (env[t]) return env[t];
    throw new Error(`Unknown query name '${t}' in formula`);
  }
  const v = expr();
  return typeof v === "number" ? [] : v;
}

/**
 * Percentile per (group, bucket) of weighted values, with the same interpolation as percentile_cont over the values
 * repeated by their weights. Rows are (g, b, v, w), one per distinct value.
 */
export function weightedPercentileRows(rows: { g: number; b: number; v: number; w: number }[], q: number): { g: number; b: number; v: number }[] {
  const cells = new Map<string, { g: number; b: number; vs: [number, number][] }>();
  for (const r of rows) {
    const k = `${r.g}|${r.b}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { g: Number(r.g), b: Number(r.b), vs: [] }));
    c.vs.push([Number(r.v), Number(r.w)]);
  }
  const out: { g: number; b: number; v: number }[] = [];
  for (const c of cells.values()) {
    c.vs.sort((x, y) => x[0] - y[0]);
    const total = c.vs.reduce((a, x) => a + x[1], 0);
    if (!(total > 0)) continue;
    const r = q * (total - 1);
    const at = (pos: number) => {
      let cum = 0;
      for (const [v, w] of c.vs) {
        cum += w;
        if (cum > pos) return v;
      }
      return c.vs[c.vs.length - 1][0];
    };
    const lo = at(Math.floor(r));
    out.push({ g: c.g, b: c.b, v: lo + (at(Math.ceil(r)) - lo) * (r - Math.floor(r)) });
  }
  return out.sort((x, y) => x.g - y.g || x.b - y.b);
}

/** Linear interpolation between closest ranks (the method of PostgreSQL's percentile_cont). */
export function interpolatedPercentile(vs: number[], q: number): number {
  const s = [...vs].sort((a, b) => a - b);
  const r = q * (s.length - 1);
  const lo = Math.floor(r);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (r - lo);
}

/** Reduce the values of a window, in time order. agg "pNN" is the NNth percentile. */
export function reduce(vs: number[], agg: string): number {
  if (!vs.length) return NaN;
  const pm = /^p(\d{1,2}(?:\.\d+)?)$/.exec(agg);
  if (pm && agg !== "p95") return interpolatedPercentile(vs, Number(pm[1]) / 100);
  switch (agg) {
    case "sum":
      return vs.reduce((a, b) => a + b, 0);
    case "min":
      return Math.min(...vs);
    case "max":
      return Math.max(...vs);
    case "last":
      return vs[vs.length - 1];
    case "count":
      return vs.length;
    case "change":
      return vs[vs.length - 1] - vs[0];
    case "pct_change":
      return vs[0] === 0 ? NaN : ((vs[vs.length - 1] - vs[0]) / Math.abs(vs[0])) * 100;
    case "percentile":
    case "p95":
      return interpolatedPercentile(vs, 0.95);
    default:
      return vs.reduce((a, b) => a + b, 0) / vs.length;
  }
}

export interface QueryRequest {
  queries: { name: string; query: string; data_source?: string; aggregator?: string }[];
  formulas?: { formula: string; alias?: string }[];
  from: number; // seconds
  to: number;
  interval?: number;
  vars?: Record<string, string>;
}

export interface QueryResultSeries {
  /** index of the formula (or query, when there are no formulas) this series belongs to */
  queryIndex: number;
  name: string;
  alias?: string;
  formula: string;
  group: string[];
  pointlist: [number, number][]; // ms, value
  interval: number; // bucket width in seconds
}

const MAX_BUCKETS = 10_000;
/** Bucket width in seconds: a requested interval must be a positive number; it is widened to at most MAX_BUCKETS buckets. */
export function resolveInterval(requested: unknown, from: number, to: number): number {
  if (requested === undefined || requested === null) return pickInterval(from, to);
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, "interval must be a positive number of seconds");
  return Math.max(1, Math.round(n), Math.ceil((to - from) / MAX_BUCKETS) || 1);
}

/** Run a set of named queries + formulas (v2 timeseries style). Supports inline arithmetic in a query. */
export async function runQueries(orgId: number, req: QueryRequest): Promise<{ series: QueryResultSeries[]; interval: number }> {
  const interval = resolveInterval(req.interval, req.from, req.to);
  const env: Record<string, SeriesSet> = {};
  const exprs: Record<string, string> = {};
  const raws: Record<string, string> = {};
  for (const q of req.queries) {
    if (!q.query?.trim()) continue;
    const { formula, queries } = extractInlineQueries(q.query.trim(), `__q_${q.name.replace(/\W/g, "")}_`);
    for (const [n, raw] of Object.entries(queries)) {
      raws[n] = raw;
      env[n] = await runMetricQuery(orgId, parseMetricQuery(raw), req.from, req.to, interval, req.vars);
    }
    exprs[q.name] = formula;
  }
  // Operands of a formula must share one bucket size: when a .rollup() widened some query, the others are re-run at
  // that width (from raw data, with their own aggregation) instead of being matched point by point.
  let widest = interval;
  for (const set of Object.values(env)) for (const s of set) if (s.interval && s.interval > widest) widest = s.interval;
  if (widest > interval)
    for (const [n, raw] of Object.entries(raws))
      if (env[n].some((s) => (s.interval ?? interval) < widest))
        env[n] = await runMetricQuery(orgId, parseMetricQuery(raw), req.from, req.to, widest, req.vars);
  for (const [name, f] of Object.entries(exprs)) env[name] = /^__q\w+$/.test(f.trim()) && env[f.trim()] ? env[f.trim()] : evalFormula(f, env, interval);
  const formulas = req.formulas?.length ? req.formulas : req.queries.filter((q) => q.query?.trim()).map((q) => ({ formula: q.name, alias: undefined }));
  // The reported interval is the widest bucket actually used (a .rollup(…, N) can widen it past the default).
  let effective = interval;
  for (const set of Object.values(env)) for (const s of set) if (s.interval && s.interval > effective) effective = s.interval;
  const series: QueryResultSeries[] = [];
  for (const [fi, f] of formulas.entries()) {
    const set = evalFormula(f.formula, env, effective);
    for (const s of set) {
      series.push({
        queryIndex: fi,
        name: f.formula,
        alias: f.alias,
        formula: f.formula,
        group: s.tags,
        interval: s.interval ?? effective,
        pointlist: [...s.points].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t * 1000, v]),
      });
    }
  }
  return { series, interval: effective };
}

export async function listMetrics(orgId: number, search = "", limit = 500): Promise<{ metric: string; type: string; series: number; last_seen: number }[]> {
  if (useClickHouse) return listMetricsCh(orgId, search, limit);
  const r = await pool.query(
    `select metric, max(type) as type, count(*)::int as series, max(last_seen)::bigint as last_seen from metric_series
     where org_id=$1 and metric ilike $2 group by metric order by metric limit $3`,
    [orgId, `%${search}%`, limit],
  );
  return r.rows.map((x) => ({ ...x, last_seen: Number(x.last_seen) }));
}

export async function metricTags(orgId: number, metric: string): Promise<{ tags: string[]; hosts: string[] }> {
  if (useClickHouse) return metricTagsCh(orgId, metric);
  const r = await pool.query("select distinct unnest(tags) as t from metric_series where org_id=$1 and ($2 = '' or metric=$2) limit 2000", [orgId, metric]);
  const h = await pool.query("select distinct host from metric_series where org_id=$1 and ($2 = '' or metric=$2) and host <> '' limit 1000", [orgId, metric]);
  return { tags: r.rows.map((x) => x.t).sort(), hosts: h.rows.map((x) => x.host).sort() };
}
