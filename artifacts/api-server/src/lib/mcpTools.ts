import { rangeOf } from "./http";
import { logger } from "./logger";
import { internalCredentialHeaders } from "./mcpInternal";

// Read-only tools of the MCP endpoint (routes/mcp.ts). Each tool calls DataCat's own HTTP API over loopback with the
// internal MCP credential for the caller's organization (lib/mcpInternal.ts), which authMiddleware accepts for reads
// only, so the tools work the same on PostgreSQL and ClickHouse storage and cannot write whoever the caller is. Outputs
// are compact and capped so they fit in a model's context.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One call to DataCat's HTTP API: a GET with query parameters, or a POST when a body is given. Path is below /api. */
export type ApiCall = (path: string, req?: { query?: Record<string, string | number | undefined>; body?: unknown }) => Promise<unknown>;

/** A tool failure whose message is safe to show the caller (bad arguments, an API answer that is not 2xx). */
export class ToolError extends Error {}

/** Longest text a tool returns; longer output is cut with a note on how to narrow the query. */
export const MAX_OUTPUT_CHARS = 40_000;
export const API_TIMEOUT_MS = 20_000;

/** Base URL of this process's own API: the port src/index.ts listens on. */
export function loopbackBase(env: Record<string, string | undefined> = process.env): string {
  return `http://127.0.0.1:${Number(env.PORT ?? "3000")}`;
}

/**
 * API client for this server, acting for one organization with the internal read-only credential. Nothing of the MCP
 * caller's (keys, token, cookies) is sent, and redirects are refused. Errors carry the API's own message, which is
 * already safe to show (lib/http.ts).
 */
export function loopbackApi(opts: { base: string; orgId: number; fetch?: FetchLike; timeoutMs?: number }): ApiCall {
  const doFetch = opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  return async (path, req = {}) => {
    const url = new URL(`/api${path}`, opts.base);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", ...internalCredentialHeaders(opts.orgId) };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    let status: number;
    let text: string;
    try {
      const res = await doFetch(url.toString(), {
        method: req.body === undefined ? "GET" : "POST",
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ path: url.pathname, ...(timedOut ? { timeoutMs } : { err }) }, "mcp: DataCat API call failed");
      throw new ToolError(
        timedOut
          ? `The DataCat API did not answer within ${Math.round(timeoutMs / 1000)} s. Try a shorter time range or a more specific query.`
          : "Could not reach the DataCat API.",
      );
    }
    const body = parseJson(text);
    if (status >= 200 && status < 300) return body;
    const errors = obj(body).errors;
    const message = Array.isArray(errors) && errors.length ? errors.map(String).join("; ") : str(obj(body).error) || "request failed";
    throw new ToolError(`The DataCat API answered ${status}: ${message}`);
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- Argument schemas ----------

type TimeArg = { type: readonly ["string", "number"]; description: string };
type Prop =
  | { type: "string"; description: string; enum?: readonly string[]; maxLength?: number; pattern?: string }
  | { type: "integer"; description: string; minimum: number; maximum: number }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: { type: "string"; maxLength: number }; maxItems: number }
  | TimeArg;
export interface InputSchema {
  type: "object";
  properties: Record<string, Prop>;
  required?: readonly string[];
  additionalProperties: false;
}

type ArgOf<P> = P extends { type: "string" }
  ? string
  : P extends { type: "integer" }
    ? number
    : P extends { type: "boolean" }
      ? boolean
      : P extends { type: "array" }
        ? string[]
        : string | number;
type RequiredOf<S> = S extends { required: readonly (infer R)[] } ? R : never;
type Args<S extends InputSchema> = { [K in keyof S["properties"] as K extends RequiredOf<S> ? K : never]: ArgOf<S["properties"][K]> } & {
  [K in keyof S["properties"] as K extends RequiredOf<S> ? never : K]?: ArgOf<S["properties"][K]>;
};

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  run: (args: Record<string, unknown>, api: ApiCall) => Promise<string>;
}

/** A tool whose run() receives arguments typed from its schema; callArgs() has checked them against that schema. */
function defineTool<S extends InputSchema>(t: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  run: (args: Args<S>, api: ApiCall) => Promise<string>;
}): Tool {
  return { ...t, run: (args, api) => t.run(args as Args<S>, api) };
}

/** Checks tool arguments against the tool's declared input schema; the message names the argument and the rule. */
export function checkArgs(schema: InputSchema, raw: unknown): Record<string, unknown> {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("arguments must be an object");
  const out = args as Record<string, unknown>;
  for (const k of Object.keys(out))
    if (!(k in schema.properties)) throw new ToolError(`Unknown argument '${k}'. Allowed: ${Object.keys(schema.properties).join(", ")}`);
  for (const k of schema.required ?? []) if (out[k] === undefined || out[k] === null || out[k] === "") throw new ToolError(`'${k}' is required`);
  for (const [k, p] of Object.entries(schema.properties)) if (out[k] !== undefined && out[k] !== null) checkValue(k, p, out[k]);
  return out;
}

const isTimeArg = (p: Prop): p is TimeArg => Array.isArray(p.type);

function checkValue(k: string, p: Prop, v: unknown): void {
  if (isTimeArg(p)) {
    if (typeof v !== "string" && typeof v !== "number") throw new ToolError(`'${k}' must be a string or a number`);
    return;
  }
  switch (p.type) {
    case "string":
      if (typeof v !== "string") throw new ToolError(`'${k}' must be a string`);
      if (p.maxLength !== undefined && v.length > p.maxLength) throw new ToolError(`'${k}' must be at most ${p.maxLength} characters`);
      if (p.enum && !p.enum.includes(v)) throw new ToolError(`'${k}' must be one of: ${p.enum.join(", ")}`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) throw new ToolError(`'${k}' has an invalid format`);
      return;
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolError(`'${k}' must be an integer`);
      if (v < p.minimum || v > p.maximum) throw new ToolError(`'${k}' must be between ${p.minimum} and ${p.maximum}`);
      return;
    case "boolean":
      if (typeof v !== "boolean") throw new ToolError(`'${k}' must be true or false`);
      return;
    case "array": {
      const max = p.items.maxLength;
      if (!Array.isArray(v)) throw new ToolError(`'${k}' must be a list`);
      if (v.length > p.maxItems) throw new ToolError(`'${k}' takes at most ${p.maxItems} entries`);
      if (v.some((x) => typeof x !== "string" || !x || x.length > max))
        throw new ToolError(`each entry of '${k}' must be a non-empty string of at most ${max} characters`);
    }
  }
}

// ---------- Output helpers ----------

/** Cuts text longer than `max` and says so, with a hint to narrow the query instead of paging through output. */
export function capOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [output truncated at ${max} of ${text.length} characters: narrow the query (shorter time range, more specific filter or a lower limit)]`;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Six significant digits: enough to read, short to print. */
const round = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(6)) : null);
/** Span and APM times are nanoseconds; tools report milliseconds to the microsecond (span starts are doubles, exact to ~1 µs). */
const nsToMs = (ns: unknown) => Math.round(num(ns) / 1e3) / 1e3;
/** ISO time of a unix timestamp in seconds or milliseconds (values above 1e11 are milliseconds). */
const iso = (t: unknown) => {
  const n = num(t);
  return n ? new Date(n > 1e11 ? n : n * 1000).toISOString() : null;
};
const json = (v: unknown) => JSON.stringify(v);

// ---------- Shared arguments ----------

const FROM: TimeArg = {
  type: ["string", "number"],
  description: "Start of the time range: now-15m, now-1h, now-7d, ISO 8601, or epoch seconds/milliseconds. Default now-1h.",
};
const TO: TimeArg = { type: ["string", "number"], description: "End of the time range (same formats as from). Default now." };
const LOG_QUERY = {
  type: "string",
  maxLength: 2000,
  description: 'Log search, Datadog syntax: service:web status:error @http.status_code:500 "timeout" -host:db-1. Default * (all).',
} as const;
const SPAN_QUERY = {
  type: "string",
  maxLength: 2000,
  description: 'Span search, Datadog syntax: service:web resource_name:"GET /users" status:error @http.status_code:5* env:prod. Default *.',
} as const;

/** The time range in unix seconds (default: the hour before `to`), parsed as the HTTP API parses it (HttpError if invalid). */
const timeRange = (args: { from?: string | number; to?: string | number }) => rangeOf({ from: args.from, to: args.to });
const rangeOut = (r: { from: number; to: number }) => ({ from: iso(r.from), to: iso(r.to) });

// ---------- APM ----------

const listServices = defineTool({
  name: "list_services",
  title: "List APM services",
  description: "APM services seen in a time range with hits, errors, error rate, requests/s and latency (avg/p50/p95/p99 in ms), busiest first.",
  inputSchema: {
    type: "object",
    properties: {
      from: FROM,
      to: TO,
      env: { type: "string", maxLength: 200, description: "Only this environment (env tag), e.g. prod." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most services to return (default 50)." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const body = obj(await api("/ui/apm/services", { query: { ...r, env: args.env } }));
    const services = arr(body.services)
      .map(obj)
      .sort((a, b) => num(b.hits) - num(a.hits));
    return json({
      ...rangeOut(r),
      envs: arr(body.envs),
      services_total: services.length,
      services: services.slice(0, args.limit ?? 50).map((s) => ({
        service: s.service,
        type: s.type,
        language: s.language,
        envs: s.envs,
        hits: num(s.hits),
        errors: num(s.errors),
        error_rate_pct: round(num(s.error_rate) * 100),
        rps: round(num(s.rps)),
        avg_ms: nsToMs(s.avg),
        p50_ms: nsToMs(s.p50),
        p95_ms: nsToMs(s.p95),
        p99_ms: nsToMs(s.p99),
      })),
    });
  },
});

const getService = defineTool({
  name: "get_service",
  title: "Get APM service",
  description: "One APM service: totals, its resources/endpoints (hits, errors, latency in ms), operations and downstream services it calls.",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", maxLength: 200, description: "Service name, as list_services shows it." },
      from: FROM,
      to: TO,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most resources to return, busiest first (default 50)." },
    },
    required: ["service"],
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const body = obj(await api(`/ui/apm/services/${encodeURIComponent(args.service)}`, { query: r }));
    const points = arr(body.timeseries).map(obj);
    const hits = points.reduce((t, p) => t + num(p.hits), 0);
    const errors = points.reduce((t, p) => t + num(p.errors), 0);
    const resources = arr(body.resources).map(obj);
    return json({
      service: args.service,
      ...rangeOut(r),
      hits,
      errors,
      error_rate_pct: hits ? round((errors / hits) * 100) : 0,
      operations: arr(body.operations),
      resources_total: resources.length,
      resources: resources.slice(0, args.limit ?? 50).map((x) => ({
        resource: x.resource,
        operation: x.name,
        hits: num(x.hits),
        errors: num(x.errors),
        rps: round(num(x.rps)),
        p50_ms: nsToMs(x.p50),
        p95_ms: nsToMs(x.p95),
        p99_ms: nsToMs(x.p99),
      })),
      downstream: arr(body.downstream)
        .map(obj)
        .map((d) => ({ service: d.service, calls: num(d.calls), avg_ms: nsToMs(d.avg) })),
    });
  },
});

const searchSpans = defineTool({
  name: "search_spans",
  title: "Search spans",
  description: "Most recent spans matching a query, with service, operation, resource, duration (ms), status and trace_id (use get_trace for the whole trace).",
  inputSchema: {
    type: "object",
    properties: {
      query: SPAN_QUERY,
      from: FROM,
      to: TO,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most spans to return (default 50)." },
      top_level_only: { type: "boolean", description: "Only service entry spans (one per service per trace). Default false." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const body = obj(
      await api("/ui/apm/spans", { body: { query: args.query || "*", ...r, limit: args.limit ?? 50, topLevelOnly: args.top_level_only ?? false } }),
    );
    const spans = arr(body.spans).map(obj);
    return json({
      query: args.query || "*",
      ...rangeOut(r),
      total: body.total_capped ? `${num(body.total)}+` : num(body.total),
      returned: spans.length,
      spans: spans.map((s) => ({
        start: iso(num(s.start_ms)),
        service: s.service,
        operation: s.name,
        resource: clip(str(s.resource), 300),
        duration_ms: nsToMs(s.duration),
        status: num(s.error) ? "error" : "ok",
        http_status: obj(s.meta)["http.status_code"],
        env: s.env || undefined,
        host: s.host || undefined,
        trace_id: str(s.trace_id),
        span_id: str(s.span_id),
      })),
    });
  },
});

/** Most spans printed in a trace tree. */
const TRACE_SPANS = 300;

const getTrace = defineTool({
  name: "get_trace",
  title: "Get trace",
  description: "All spans of one trace as an indented tree (parent → children) with offsets and durations in ms, plus logs carrying that trace_id.",
  inputSchema: {
    type: "object",
    properties: {
      trace_id: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{1,40}$", description: "Trace id (decimal, or hex as OpenTelemetry prints it)." },
    },
    required: ["trace_id"],
    additionalProperties: false,
  },
  run: async (args, api) => {
    const body = obj(await api(`/ui/apm/traces/${encodeURIComponent(args.trace_id)}`));
    const spans = arr(body.spans).map(obj);
    if (!spans.length) return `No spans found for trace ${args.trace_id}. Spans older than the retention period are deleted.`;
    return traceTree(args.trace_id, spans, arr(body.logs).map(obj));
  },
});

/** Text tree of a trace's spans by parent_id; spans whose parent is missing are printed as roots. */
export function traceTree(traceId: string, spans: Record<string, unknown>[], logs: Record<string, unknown>[]): string {
  const ids = new Set(spans.map((s) => str(s.span_id)));
  const children = new Map<string, Record<string, unknown>[]>();
  const roots: Record<string, unknown>[] = [];
  for (const s of spans) {
    const parent = str(s.parent_id);
    if (!ids.has(parent) || parent === str(s.span_id)) {
      roots.push(s);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const t0 = Math.min(...spans.map((s) => num(s.start)));
  const end = Math.max(...spans.map((s) => num(s.start) + num(s.duration)));
  const errors = spans.filter((s) => num(s.error)).length;
  const services = [...new Set(spans.map((s) => str(s.service)))];
  const lines = [
    `trace ${traceId}: ${spans.length} spans, ${services.length} services (${services.join(", ")}), ${nsToMs(end - t0)} ms, ${errors} with errors`,
  ];
  const seen = new Set<Record<string, unknown>>();
  const walk = (s: Record<string, unknown>, depth: number) => {
    if (seen.has(s) || seen.size >= TRACE_SPANS) return;
    seen.add(s);
    const status = num(s.error) ? " ERROR" : "";
    const http = obj(s.meta)["http.status_code"];
    lines.push(
      `${"  ".repeat(depth)}- ${str(s.service)} ${str(s.name)} "${clip(str(s.resource), 200)}" ${nsToMs(s.duration)} ms @+${nsToMs(num(s.start) - t0)} ms${http ? ` http ${str(http)}` : ""}${status} span_id=${str(s.span_id)}`,
    );
    for (const c of children.get(str(s.span_id)) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (seen.size < spans.length) lines.push(`… ${spans.length - seen.size} more spans not shown`);
  if (logs.length) {
    lines.push("", `logs with this trace_id (${logs.length}${logs.length >= 200 ? "+" : ""}):`);
    for (const l of logs.slice(0, 20)) lines.push(`${iso(l.ts)} ${str(l.status)} ${str(l.service)}: ${clip(str(l.message), 300)}`);
  }
  return lines.join("\n");
}

// ---------- Metrics ----------

/** Most points per series when points are included; longer series are averaged into this many buckets. */
const MAX_POINTS = 60;

/** Averages consecutive points so a series has at most `max` points (each bucket keeps its first timestamp). */
export function downsample(points: [number, number][], max = MAX_POINTS): [number, number][] {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    out.push([chunk[0][0], chunk.reduce((t, p) => t + p[1], 0) / chunk.length]);
  }
  return out;
}

const queryMetrics = defineTool({
  name: "query_metrics",
  title: "Query metrics",
  description:
    "Run a metric query (Datadog syntax) and summarize each series: group tags, point count, min/avg/max/last. " +
    "Examples: avg:system.cpu.user{host:web-1}, sum:trace.web.request.hits{service:api} by {resource_name}.as_count(), " +
    "sum:trace.web.request.errors{service:api}.as_count() / sum:trace.web.request.hits{service:api}.as_count() * 100. " +
    "Use search_metrics to find metric names and get_metric_tags for tags.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 2000, description: "Metric query; arithmetic between queries is allowed." },
      from: FROM,
      to: TO,
      include_points: { type: "boolean", description: `Also return the points, averaged down to at most ${MAX_POINTS} per series. Default false.` },
      max_series: { type: "integer", minimum: 1, maximum: 100, description: "Most series to return (default 20)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const body = obj(await api("/ui/metrics/query", { body: { queries: [{ name: "a", query: args.query }], ...r } }));
    const series = arr(body.series).map(obj);
    return json({
      query: args.query,
      ...rangeOut(r),
      interval_s: num(body.interval),
      series_total: series.length,
      series: series.slice(0, args.max_series ?? 20).map((s) => {
        const points = arr(s.pointlist)
          .map((p) => arr(p))
          .map((p): [number, number] => [num(p[0]), Number(p[1])])
          .filter((p) => Number.isFinite(p[1]));
        const values = points.map((p) => p[1]);
        const last = points.at(-1);
        return {
          group: arr(s.group).length ? arr(s.group).map(String).join(",") : "*",
          points: points.length,
          min: values.length ? round(Math.min(...values)) : null,
          avg: values.length ? round(values.reduce((t, v) => t + v, 0) / values.length) : null,
          max: values.length ? round(Math.max(...values)) : null,
          last: last ? round(last[1]) : null,
          last_at: last ? iso(last[0]) : null,
          ...(args.include_points ? { pointlist: downsample(points).map(([t, v]) => [iso(t), round(v)]) } : {}),
        };
      }),
    });
  },
});

const searchMetrics = defineTool({
  name: "search_metrics",
  title: "Search metric names",
  description: "Find metric names containing a text (case-insensitive), with type, number of series and when last seen.",
  inputSchema: {
    type: "object",
    properties: {
      search: { type: "string", maxLength: 200, description: "Text the metric name contains, e.g. cpu or trace.http. Default: all metrics." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Most metrics to return (default 100)." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const metrics = arr(obj(await api("/ui/metrics", { query: { q: args.search } })).metrics).map(obj);
    return json({
      metrics_total: metrics.length >= 500 ? "500+" : metrics.length,
      metrics: metrics.slice(0, args.limit ?? 100).map((m) => ({ metric: m.metric, type: m.type, series: num(m.series), last_seen: iso(m.last_seen) })),
    });
  },
});

const getMetricTags = defineTool({
  name: "get_metric_tags",
  title: "Get metric tags",
  description: "Tag keys of a metric with their values (to use in {…} filters and 'by {…}' groupings), and the hosts reporting it.",
  inputSchema: {
    type: "object",
    properties: { metric: { type: "string", maxLength: 300, description: "Exact metric name, e.g. trace.web.request.hits." } },
    required: ["metric"],
    additionalProperties: false,
  },
  run: async (args, api) => {
    const body = obj(await api(`/ui/metrics/${encodeURIComponent(args.metric)}/tags`));
    const byKey = new Map<string, string[]>();
    for (const t of arr(body.tags).map(String)) {
      const i = t.indexOf(":");
      const key = i < 0 ? t : t.slice(0, i);
      byKey.set(key, [...(byKey.get(key) ?? []), ...(i < 0 ? [] : [t.slice(i + 1)])]);
    }
    const hosts = arr(body.hosts).map(String);
    return json({
      metric: args.metric,
      tags: Object.fromEntries([...byKey].map(([k, vs]) => [k, vs.length > 25 ? { values: vs.slice(0, 25), more: vs.length - 25 } : vs])),
      hosts_total: hosts.length,
      hosts: hosts.slice(0, 50),
    });
  },
});

// ---------- Logs ----------

/** A few scalar attributes of a log, short enough to scan. */
function someAttributes(a: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(a))) {
    if (Object.keys(out).length >= 10) break;
    if (v === null || typeof v === "object") continue;
    out[k] = typeof v === "string" ? clip(v, 120) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

const searchLogs = defineTool({
  name: "search_logs",
  title: "Search logs",
  description: "Logs matching a query: time, status, service, host, message (cut at 500 characters), trace_id and a few attributes.",
  inputSchema: {
    type: "object",
    properties: {
      query: LOG_QUERY,
      from: FROM,
      to: TO,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most logs to return (default 50)." },
      sort: { type: "string", enum: ["desc", "asc"], description: "desc (newest first, default) or asc." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const body = obj(await api("/ui/logs/search", { body: { query: args.query || "*", ...r, limit: args.limit ?? 50, sort: args.sort ?? "desc" } }));
    const logs = arr(body.logs).map(obj);
    return json({
      query: args.query || "*",
      ...rangeOut(r),
      total: body.total_capped ? `${num(body.total)}+` : num(body.total),
      returned: logs.length,
      logs: logs.map((l) => ({
        timestamp: iso(l.ts),
        status: l.status,
        service: l.service,
        host: l.host || undefined,
        message: clip(str(l.message), 500),
        trace_id: l.trace_id || undefined,
        attributes: someAttributes(l.attributes),
      })),
    });
  },
});

const aggregateLogs = defineTool({
  name: "aggregate_logs",
  title: "Count logs by facet",
  description:
    "Count logs matching a query, grouped by up to 2 facets: status, service, host, source, a tag key (env) or an attribute (@http.status_code). " +
    "Without group_by, returns the total count.",
  inputSchema: {
    type: "object",
    properties: {
      query: LOG_QUERY,
      from: FROM,
      to: TO,
      group_by: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 2, description: 'Facets to group by, e.g. ["service", "status"].' },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Most values per facet, by count (default 10)." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const r = timeRange(args);
    const groupBy = args.group_by ?? [];
    const body = obj(
      await api("/v2/logs/analytics/aggregate", {
        body: {
          filter: { query: args.query || "*", ...r },
          compute: [{ aggregation: "count" }],
          group_by: groupBy.map((facet) => ({ facet, limit: args.limit ?? 10 })),
        },
      }),
    );
    const groups = arr(obj(body.data).buckets)
      .map(obj)
      .map((b) => ({ ...obj(b.by), count: num(obj(b.computes).c0) }))
      .sort((a, b) => b.count - a.count);
    return json({ query: args.query || "*", ...rangeOut(r), group_by: groupBy, groups });
  },
});

// ---------- Monitors and dashboards ----------

const listMonitors = defineTool({
  name: "list_monitors",
  title: "List monitors",
  description: "Monitors with their type, query and overall state (OK, Warn, Alert, No Data), optionally filtered by state or name.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["OK", "Warn", "Alert", "No Data"], description: "Only monitors in this state." },
      search: { type: "string", maxLength: 200, description: "Text the monitor name contains (case-insensitive)." },
    },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const needle = (args.search ?? "").toLowerCase();
    const monitors = arr(await api("/v1/monitor"))
      .map(obj)
      .filter((m) => (!args.state || m.overall_state === args.state) && str(m.name).toLowerCase().includes(needle));
    return json({
      monitors_total: monitors.length,
      monitors: monitors.slice(0, 200).map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        query: m.query,
        overall_state: m.overall_state,
        muted: num(m.muted_until) * 1000 > Date.now(),
        last_triggered_at: iso(m.last_triggered_at),
        tags: arr(m.tags).length ? m.tags : undefined,
      })),
    });
  },
});

const listDashboards = defineTool({
  name: "list_dashboards",
  title: "List dashboards",
  description:
    "Dashboards (id, title, description, widget count, last change), optionally filtered by title. Use get_dashboard for the widgets and their queries.",
  inputSchema: {
    type: "object",
    properties: { search: { type: "string", maxLength: 200, description: "Text the title contains (case-insensitive)." } },
    additionalProperties: false,
  },
  run: async (args, api) => {
    const needle = (args.search ?? "").toLowerCase();
    const dashboards = arr(obj(await api("/v1/dashboard")).dashboards)
      .map(obj)
      .filter((d) => str(d.title).toLowerCase().includes(needle));
    return json({
      dashboards_total: dashboards.length,
      dashboards: dashboards.slice(0, 200).map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description ? clip(str(d.description), 200) : undefined,
        widgets: num(d.widget_count),
        modified_at: d.modified_at,
      })),
    });
  },
});

/** Query strings anywhere in a widget definition (requests[].q, queries[].query, formulas), not in nested widgets. */
function widgetQueries(def: unknown, out: string[] = []): string[] {
  if (Array.isArray(def)) {
    for (const x of def) widgetQueries(x, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj(def))) {
    if (k === "widgets") continue;
    const isQuery = (k === "q" || k === "query" || k === "formula") && typeof v === "string" && v.trim();
    if (isQuery) out.push(clip(v, 500));
    if (v && typeof v === "object") widgetQueries(v, out);
  }
  return out;
}

/** Widgets in display order; a group's widgets follow it with the group title as a prefix. */
function flattenWidgets(widgets: unknown[], prefix = ""): { title: string; type: string; queries: string[] }[] {
  return widgets.flatMap((w) => {
    const def = obj(obj(w).definition);
    const title = `${prefix}${str(def.title) || "(untitled)"}`;
    const nested = arr(def.widgets);
    return [{ title, type: str(def.type), queries: widgetQueries(def) }, ...flattenWidgets(nested, `${title} / `)];
  });
}

const getDashboard = defineTool({
  name: "get_dashboard",
  title: "Get dashboard",
  description: "One dashboard: template variables and every widget with its title, type and queries (reusable with query_metrics, search_logs, search_spans).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", pattern: "^[A-Za-z0-9-]{1,64}$", description: "Dashboard id from list_dashboards, e.g. abc-def-ghi." } },
    required: ["id"],
    additionalProperties: false,
  },
  run: async (args, api) => {
    const d = obj(await api(`/v1/dashboard/${encodeURIComponent(args.id)}`));
    const widgets = flattenWidgets(arr(d.widgets));
    return json({
      id: d.id,
      title: d.title,
      description: d.description || undefined,
      template_variables: arr(d.template_variables)
        .map(obj)
        .map((t) => ({ name: t.name, prefix: t.prefix, default: t.default })),
      widgets_total: widgets.length,
      widgets: widgets.slice(0, 150),
    });
  },
});

export const TOOLS: Tool[] = [
  listServices,
  getService,
  searchSpans,
  getTrace,
  queryMetrics,
  searchMetrics,
  getMetricTags,
  searchLogs,
  aggregateLogs,
  listMonitors,
  listDashboards,
  getDashboard,
];
