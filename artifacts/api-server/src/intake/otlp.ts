/**
 * Native OpenTelemetry (OTLP/HTTP) intake for traces, metrics and logs.
 *
 * Accepts protobuf (application/x-protobuf) and JSON (application/json), gzip or plain, on
 *   POST /otlp/v1/traces | /otlp/v1/metrics | /otlp/v1/logs
 * and maps OpenTelemetry data onto DataCat's model so every product (APM, Logs, Infrastructure,
 * dashboards, monitors) works on it. The message definitions below are taken from opentelemetry-proto v1
 * (https://github.com/open-telemetry/opentelemetry-proto, Copyright 2019, OpenTelemetry Authors, Apache-2.0).
 * Naming of operations/resources and host-metric mapping follow the conventions the DataCat Agent
 * and libraries rely on (http.server.request, <db.system>.query, system.cpu.user, ...).
 */
import protobuf from "protobufjs";
import { normalizeTraceId } from "./decode";
import { type PointIn, type LogIn, type SpanIn } from "./store";

const PROTO = `
syntax = "proto3";
package otlp;
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; fixed32 flags = 16;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10;
  repeated Event events = 11; uint32 dropped_events_count = 12; repeated Link links = 13; uint32 dropped_links_count = 14;
  Status status = 15;
  message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
  message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
}
message Status { string message = 2; int32 code = 3; }

message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message Metric {
  string name = 1; string description = 2; string unit = 3;
  oneof data { Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; ExponentialHistogram exponential_histogram = 10; Summary summary = 11; }
  repeated KeyValue metadata = 12;
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated HistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message ExponentialHistogram { repeated ExponentialHistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message Summary { repeated SummaryDataPoint data_points = 1; }
message NumberDataPoint { repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; oneof value { double as_double = 4; sfixed64 as_int = 6; } repeated Exemplar exemplars = 5; uint32 flags = 8; }
message HistogramDataPoint { repeated KeyValue attributes = 9; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; fixed64 count = 4; double sum = 5; repeated fixed64 bucket_counts = 6; repeated double explicit_bounds = 7; repeated Exemplar exemplars = 8; uint32 flags = 10; double min = 11; double max = 12; }
message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; fixed64 count = 4; double sum = 5;
  sint32 scale = 6; fixed64 zero_count = 7; Buckets positive = 8; Buckets negative = 9; uint32 flags = 10; repeated Exemplar exemplars = 11;
  double min = 12; double max = 13; double zero_threshold = 14;
  message Buckets { sint32 offset = 1; repeated uint64 bucket_counts = 2; }
}
message SummaryDataPoint { repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; fixed64 count = 4; double sum = 5; repeated ValueAtQuantile quantile_values = 6; uint32 flags = 8; message ValueAtQuantile { double quantile = 1; double value = 2; } }
message Exemplar { repeated KeyValue filtered_attributes = 7; fixed64 time_unix_nano = 2; oneof value { double as_double = 3; sfixed64 as_int = 6; } bytes span_id = 4; bytes trace_id = 5; }

message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message LogRecord {
  fixed64 time_unix_nano = 1; fixed64 observed_time_unix_nano = 11; int32 severity_number = 2; string severity_text = 3;
  AnyValue body = 5; repeated KeyValue attributes = 6; uint32 dropped_attributes_count = 7; fixed32 flags = 8;
  bytes trace_id = 9; bytes span_id = 10; string event_name = 12;
}
`;

const root = protobuf.parse(PROTO, { keepCase: false }).root;
const T = {
  traces: root.lookupType("otlp.ExportTraceServiceRequest"),
  metrics: root.lookupType("otlp.ExportMetricsServiceRequest"),
  logs: root.lookupType("otlp.ExportLogsServiceRequest"),
};
export type OtlpSignal = keyof typeof T;

/** Decode a request body into the OTLP/JSON object shape (camelCase keys, hex IDs, string int64s). */
export function decodeOtlp(signal: OtlpSignal, body: Buffer, contentType: string): any {
  if (/json/i.test(contentType)) {
    const s = body.toString("utf8").trim();
    return s ? JSON.parse(s) : {};
  }
  const t = T[signal];
  const obj = t.toObject(t.decode(body), { longs: String, enums: Number, bytes: String, defaults: false, arrays: true, oneofs: false });
  fixIds(obj);
  return obj;
}

const ID_KEYS = new Set(["traceId", "spanId", "parentSpanId"]);
// protobuf bytes come back base64; OTLP/JSON uses hex
function fixIds(o: any) {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) {
    for (const x of o) fixIds(x);
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    if (ID_KEYS.has(k) && typeof v === "string") o[k] = v ? Buffer.from(v, "base64").toString("hex") : "";
    else if (v && typeof v === "object") fixIds(v);
  }
}

export function encodeEmptyResponse(contentType: string): { type: string; body: Buffer | string } {
  return /json/i.test(contentType) ? { type: "application/json", body: "{}" } : { type: "application/x-protobuf", body: Buffer.alloc(0) };
}

// ---------- attribute helpers ----------
type Attrs = Record<string, any>;
function anyValue(v: any): any {
  if (!v || typeof v !== "object") return v ?? null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ("kvlistValue" in v) return attrs(v.kvlistValue?.values);
  if ("bytesValue" in v) return v.bytesValue;
  return null;
}
function attrs(kvs: any[] | undefined): Attrs {
  const o: Attrs = {};
  for (const kv of kvs ?? []) if (kv?.key) o[kv.key] = anyValue(kv.value);
  return o;
}
const str = (v: any) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const nano = (v: any) => Number(v ?? 0); // ns as number (precision to ~µs is fine for UI)

function hexToDec(hex: string | undefined): string {
  if (!hex || /^0*$/.test(hex)) return "0";
  return BigInt("0x" + hex.slice(-16)).toString();
}

const RES_KNOWN = new Set([
  "service.name",
  "service.version",
  "deployment.environment",
  "deployment.environment.name",
  "host.name",
  "host.id",
  "os.type",
  "os.description",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
  "telemetry.distro.name",
  "telemetry.distro.version",
  "process.pid",
  "process.executable.path",
  "process.command_args",
  "process.command_line",
  "process.executable.name",
  "process.runtime.description",
  "process.owner",
  "process.command",
  "service.instance.id",
  "datacat.agent.version",
]);

interface ResInfo {
  service: string;
  env: string;
  version: string;
  host: string;
  tags: string[];
  attrs: Attrs;
}
function resourceInfo(resource: any): ResInfo {
  const a = attrs(resource?.attributes);
  const env = str(a["deployment.environment.name"] ?? a["deployment.environment"]);
  const version = str(a["service.version"]);
  const tags: string[] = [];
  if (env) tags.push(`env:${env}`);
  if (version) tags.push(`version:${version}`);
  for (const [k, v] of Object.entries(a)) {
    if (RES_KNOWN.has(k) || v === null || typeof v === "object") continue;
    // detector noise (host.arch, os.version, process.runtime.*, telemetry.*) stays on spans/logs as attributes, not as metric tags
    if (/^(host|os|process|telemetry|service\.instance|k8s\.pod\.uid|container\.image\.id)\./.test(k)) continue;
    // DataCat tags arrive as datacat.tag.<key> or as plain resource attributes
    tags.push(`${k.replace(/^datacat\.tag\./, "")}:${v}`);
  }
  return { service: str(a["service.name"]).replace(/^unknown_service.*$/, "") || "", env, version, host: str(a["host.name"]), tags, attrs: a };
}

// ---------- traces ----------
const KIND = ["unspecified", "internal", "server", "client", "producer", "consumer"];

function opAndResource(name: string, kind: number, a: Attrs): { op: string; resource: string; type: string } {
  const method = str(a["http.request.method"] ?? a["http.method"]);
  const dbSystem = str(a["db.system.name"] ?? a["db.system"]);
  const msgSystem = str(a["messaging.system"]);
  const rpcSystem = str(a["rpc.system"]);
  if (method && kind === 2) {
    const route = str(a["http.route"] ?? a["url.template"]) || str(a["url.path"] ?? a["http.target"]).split("?")[0];
    return { op: "http.server.request", resource: route ? `${method} ${route}` : method, type: "web" };
  }
  if (method && kind === 3) {
    const host = str(a["server.address"] ?? a["net.peer.name"] ?? a["http.host"]);
    return { op: "http.client.request", resource: host ? `${method} ${host}` : method, type: "http" };
  }
  if (dbSystem) {
    const q = str(a["db.query.text"] ?? a["db.statement"]) || str(a["db.operation.name"] ?? a["db.operation"]) || name;
    const sqlish = /postgres|mysql|mariadb|sqlite|mssql|oracle|db2|cockroach|sql/i.test(dbSystem);
    return {
      op: `${dbSystem}.query`,
      resource: q.replace(/\s+/g, " ").slice(0, 500),
      type: sqlish ? "sql" : dbSystem === "redis" || dbSystem === "memcached" ? "cache" : "db",
    };
  }
  if (msgSystem) {
    const opn = str(a["messaging.operation.type"] ?? a["messaging.operation"]) || KIND[kind];
    const dest = str(a["messaging.destination.name"] ?? a["messaging.destination"]);
    return { op: `${msgSystem}.${opn}`, resource: dest ? `${opn} ${dest}` : name, type: "queue" };
  }
  if (rpcSystem) {
    return {
      op: `${rpcSystem}.${kind === 2 ? "server" : "client"}.request`,
      resource: [a["rpc.service"], a["rpc.method"]].filter(Boolean).join("/") || name,
      type: kind === 2 ? "web" : "http",
    };
  }
  if (kind === 2) return { op: "server.request", resource: name, type: "web" };
  // framework-internal spans (express/koa/fastify layers): "<framework>.<layer type>" with the layer name as resource
  for (const fw of ["express", "koa", "fastify", "hapi", "restify", "connect", "nestjs"]) {
    const t = str(a[`${fw}.type`]);
    if (t) return { op: `${fw}.${t.replace(/\s+/g, "_")}`, resource: str(a[`${fw}.name`]) || name, type: "web" };
  }
  const explicit = str(a["resource.name"] ?? a["datacat.resource"]);
  return {
    op:
      name
        .toLowerCase()
        .replace(/[^a-z0-9_.\/:-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "span",
    resource: explicit || name,
    type: kind === 5 ? "worker" : "custom",
  };
}

export function otlpToSpans(req: any): SpanIn[] {
  const out: SpanIn[] = [];
  for (const rs of req?.resourceSpans ?? []) {
    const r = resourceInfo(rs.resource);
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      const scope = ss.scope ?? ss.instrumentationLibrary ?? {};
      for (const sp of ss.spans ?? []) {
        const a = attrs(sp.attributes);
        const kind = Number(sp.kind ?? 0);
        const { op, resource, type } = opAndResource(String(sp.name ?? ""), kind, a);
        const start = nano(sp.startTimeUnixNano);
        const end = nano(sp.endTimeUnixNano);
        const meta: Record<string, string> = {};
        const metrics: Record<string, number> = {};
        for (const [k, v] of Object.entries(a)) {
          if (typeof v === "number" && !/status_code|port/.test(k)) metrics[k] = v;
          else meta[k] = str(v);
        }
        for (const [k, v] of Object.entries(r.attrs)) if (!(k in meta) && v !== null && typeof v !== "object") meta[k] = str(v);
        meta["span.kind"] = KIND[kind] ?? "unspecified";
        meta["span.name"] = String(sp.name ?? "");
        if (scope.name) meta["otel.scope.name"] = String(scope.name);
        if (r.version) meta["version"] = r.version;
        const lang = str(r.attrs["telemetry.sdk.language"]);
        if (lang) meta["language"] = lang === "nodejs" ? "nodejs" : lang;
        const code = Number(sp.status?.code ?? 0);
        const httpStatus = Number(a["http.response.status_code"] ?? a["http.status_code"] ?? 0);
        if (httpStatus) meta["http.status_code"] = String(httpStatus);
        if (a["http.request.method"] ?? a["http.method"]) meta["http.method"] = str(a["http.request.method"] ?? a["http.method"]);
        if (a["url.full"] ?? a["http.url"]) meta["http.url"] = str(a["url.full"] ?? a["http.url"]);
        let error = code === 2 || (kind === 2 && httpStatus >= 500) ? 1 : 0;
        for (const ev of sp.events ?? []) {
          if (ev.name !== "exception") continue;
          const ea = attrs(ev.attributes);
          error = 1;
          if (ea["exception.type"]) meta["error.type"] = str(ea["exception.type"]);
          if (ea["exception.message"]) meta["error.message"] = str(ea["exception.message"]);
          if (ea["exception.stacktrace"]) meta["error.stack"] = str(ea["exception.stacktrace"]);
        }
        if (error && sp.status?.message && !meta["error.message"]) meta["error.message"] = String(sp.status.message);
        const parent = hexToDec(sp.parentSpanId);
        out.push({
          traceId: normalizeTraceId(sp.traceId) ?? "0",
          spanId: hexToDec(sp.spanId),
          parentId: parent,
          service: r.service || "unnamed-service",
          name: op,
          resource,
          type,
          env: r.env,
          host: r.host,
          start,
          duration: Math.max(0, end - start),
          error,
          meta,
          metrics,
          isTopLevel: kind === 2 || kind === 5 || parent === "0" ? true : undefined,
        });
      }
    }
  }
  // service-entry spans: parent present in this batch but from another service
  const byId = new Map(out.map((s) => [s.spanId, s]));
  for (const s of out) {
    if (s.isTopLevel) continue;
    const p = byId.get(s.parentId);
    s.isTopLevel = p ? p.service !== s.service : false;
  }
  return out;
}

// ---------- logs ----------
function sevToStatus(num: number, text: string): string {
  const t = text.toLowerCase();
  if (t) {
    if (/^(warn|warning)$/.test(t)) return "warn";
    if (/^(err|error)$/.test(t)) return "error";
    if (/^(fatal|critical|crit|emerg|emergency|alert)$/.test(t)) return "critical";
    if (/^(debug|trace)$/.test(t)) return "debug";
    if (/^(info|notice|information)$/.test(t)) return "info";
  }
  if (num >= 21) return "critical";
  if (num >= 17) return "error";
  if (num >= 13) return "warn";
  if (num >= 9 || num === 0) return "info";
  return "debug";
}

export function otlpToLogs(req: any): LogIn[] {
  const out: LogIn[] = [];
  for (const rl of req?.resourceLogs ?? []) {
    const r = resourceInfo(rl.resource);
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const a = attrs(lr.attributes);
        let body = anyValue(lr.body);
        let message: string;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          message = str(body.message ?? body.msg ?? JSON.stringify(body));
          for (const [k, v] of Object.entries(body)) if (k !== "message" && k !== "msg" && !(k in a)) a[k] = v;
        } else message = str(body);
        const tsNs = nano(lr.timeUnixNano) || nano(lr.observedTimeUnixNano) || Date.now() * 1e6;
        const traceHex = lr.traceId && !/^0*$/.test(lr.traceId) ? lr.traceId : null;
        const traceAttr = a["trace_id"] ?? a["dd.trace_id"] ?? a["otelTraceID"] ?? a["traceId"];
        const service = r.service || str(a["service.name"] ?? a["service"]) || "";
        const source = str(a["log.source"] ?? a["source"] ?? a["ddsource"]) || str(r.attrs["telemetry.sdk.language"]) || (a["log.file.path"] ? "file" : "otlp");
        const statusAttr = str(a["level"] ?? a["status"] ?? a["severity"]);
        out.push({
          ts: Math.floor(tsNs / 1e6),
          status: sevToStatus(Number(lr.severityNumber ?? 0), String(lr.severityText ?? "") || statusAttr),
          service,
          host: r.host || str(a["host.name"] ?? a["host"]),
          source,
          message,
          tags: r.tags,
          attributes: { ...a, ...(lr.spanId && !/^0*$/.test(lr.spanId) ? { span_id: hexToDec(lr.spanId) } : {}) },
          traceId: traceHex ? normalizeTraceId(traceHex) : traceAttr ? normalizeTraceId(traceAttr) : null,
        });
      }
    }
  }
  return out;
}

// ---------- metrics ----------
const cumulative = new Map<string, any>(); // last cumulative value per stream, for delta conversion
const cumulativeMaxSetting = Number(process.env.DATACAT_CUMULATIVE_STREAMS_MAX ?? 500_000);
const CUMULATIVE_MAX = Number.isFinite(cumulativeMaxSetting) && cumulativeMaxSetting >= 1000 ? Math.floor(cumulativeMaxSetting) : 500_000;
function rememberCumulative(k: string, v: any) {
  cumulative.delete(k);
  cumulative.set(k, v);
  if (cumulative.size > CUMULATIVE_MAX) {
    let drop = Math.ceil(CUMULATIVE_MAX / 10);
    for (const key of cumulative.keys()) {
      cumulative.delete(key);
      if (--drop <= 0) break;
    }
  }
}
const sortedAttrs = (a: Attrs) =>
  JSON.stringify(
    Object.entries(a)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  );
/** Identity of one cumulative stream: every resource, scope and data-point attribute (order-independent) and its start. */
function cumKey(orgId: number, name: string, resource: string, scope: string, dpAttrs: Attrs, start: any) {
  return `${orgId}|${name}|${resource}|${scope}|${sortedAttrs(dpAttrs)}|${start ?? ""}`;
}

function quantileFromBuckets(bounds: number[], counts: number[], q: number, min?: number, max?: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return NaN;
  const rank = q * total;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (acc + c >= rank && c > 0) {
      const lo = i === 0 ? (min ?? Math.min(0, bounds[0] ?? 0)) : bounds[i - 1];
      const hi = i < bounds.length ? bounds[i] : (max ?? bounds[bounds.length - 1] ?? lo);
      const frac = (rank - acc) / c;
      return lo + (hi - lo) * frac;
    }
    acc += c;
  }
  return max ?? bounds[bounds.length - 1] ?? NaN;
}

/**
 * Exponential histogram -> explicit buckets in ascending order. Bucket i of a range covers (base^(offset+i),
 * base^(offset+i+1)] in absolute value; negative buckets mirror it below zero, the zero bucket sits between.
 */
export function expoToExplicit(dp: any): { bounds: number[]; counts: number[] } {
  const scale = Number(dp.scale ?? 0);
  const base = Math.pow(2, Math.pow(2, -scale));
  const bounds: number[] = [];
  const counts: number[] = [];
  const noff = Number(dp.negative?.offset ?? 0);
  const nc = (dp.negative?.bucketCounts ?? []).map(Number);
  for (let i = nc.length - 1; i >= 0; i--) {
    bounds.push(-Math.pow(base, noff + i));
    counts.push(nc[i]);
  }
  bounds.push(0);
  counts.push(Number(dp.zeroCount ?? 0));
  const off = Number(dp.positive?.offset ?? 0);
  const pc = (dp.positive?.bucketCounts ?? []).map(Number);
  pc.forEach((c: number, i: number) => {
    bounds.push(Math.pow(base, off + i + 1));
    counts.push(c);
  });
  return { bounds, counts: [...counts, 0] };
}

const CPU_STATE: Record<string, string> = {
  user: "user",
  system: "system",
  wait: "iowait",
  idle: "idle",
  steal: "stolen",
  nice: "nice",
  interrupt: "interrupt",
  softirq: "softirq",
};

/**
 * Host metric mapping (OpenTelemetry hostmetrics names → DataCat's system.* names used by the
 * Infrastructure list, host map and host dashboards). The original OTel series are stored too.
 */
function hostMappings(
  orgId: number,
  name: string,
  a: Attrs,
  host: string,
  tags: string[],
  ts: number,
  value: number,
  acc: Map<string, { sum: number; n: number; p: PointIn }>,
  extra: PointIn[],
) {
  const add = (metric: string, v: number, t: string[] = tags, mode: "avg" | "sum" = "avg") => {
    const k = `${metric}|${host}|${t.join(",")}|${ts}|${mode}`;
    let e = acc.get(k);
    if (!e) acc.set(k, (e = { sum: 0, n: 0, p: { metric, host, tags: t, type: "gauge", points: [[ts, 0]] } }));
    e.sum += v;
    e.n += mode === "avg" ? 1 : 0;
  };
  switch (name) {
    case "system.cpu.utilization": {
      const st = CPU_STATE[str(a.state)];
      if (st) add(`system.cpu.${st}`, value * 100);
      break;
    }
    case "system.cpu.load_average.1m":
      extra.push({ metric: "system.load.1", host, tags, type: "gauge", points: [[ts, value]] });
      break;
    case "system.cpu.load_average.5m":
      extra.push({ metric: "system.load.5", host, tags, type: "gauge", points: [[ts, value]] });
      break;
    case "system.cpu.load_average.15m":
      extra.push({ metric: "system.load.15", host, tags, type: "gauge", points: [[ts, value]] });
      break;
    case "system.memory.usage": {
      const st = str(a.state);
      const mb = value / 1048576;
      if (st === "used") add("system.mem.used", mb, tags, "sum");
      if (st === "free") add("system.mem.free", mb, tags, "sum");
      if (st === "cached") add("system.mem.cached", mb, tags, "sum");
      if (st === "buffered") add("system.mem.buffered", mb, tags, "sum");
      if (["free", "cached", "buffered", "slab_reclaimable"].includes(st)) add("system.mem.usable", mb, tags, "sum");
      add("system.mem.total", mb, tags, "sum");
      break;
    }
    case "system.filesystem.usage": {
      const st = str(a.state);
      const dt = [...tags, `device:${str(a.device)}`];
      if (st === "used") add("system.disk.used", value, dt, "sum");
      if (st === "free") add("system.disk.free", value, dt, "sum");
      add("system.disk.total", value, dt, "sum");
      break;
    }
    case "system.paging.utilization":
      if (str(a.state) === "used") add("system.swap.pct_free", 1 - value, tags);
      break;
    case "system.processes.count":
      add("system.proc.count", value, tags, "sum");
      break;
  }
}

/**
 * Converts an OTLP metrics request. Cumulative streams are turned into deltas against the last stored value; the new
 * reference values are applied only by commit(), which the caller runs after the points are stored, so a failed store
 * followed by a retry computes the same deltas again instead of losing them.
 */
export function otlpToMetrics(
  orgId: number,
  req: any,
): { points: PointIn[]; hosts: Map<string, { os?: string; agentVersion?: string; tags: string[] }>; commit: () => void } {
  const out: PointIn[] = [];
  const refs = new Map<string, any>();
  const refOf = (k: string) => (refs.has(k) ? refs.get(k) : cumulative.get(k));
  const hosts = new Map<string, { os?: string; agentVersion?: string; tags: string[] }>();
  const acc = new Map<string, { sum: number; n: number; p: PointIn }>();
  for (const rm of req?.resourceMetrics ?? []) {
    const r = resourceInfo(rm.resource);
    const isHostMetrics = (rm.scopeMetrics ?? []).some((sm: any) => String(sm.scope?.name ?? "").includes("hostmetrics"));
    if (r.host && isHostMetrics)
      hosts.set(r.host, {
        os: str(r.attrs["os.type"]) || undefined,
        agentVersion: str(r.attrs["datacat.agent.version"]) || undefined,
        tags: r.tags,
      });
    const baseTags = [...r.tags, ...(r.service ? [`service:${r.service}`] : [])];
    const resKey = sortedAttrs(r.attrs);
    for (const sm of rm.scopeMetrics ?? []) {
      const scopeKey = `${sm.scope?.name ?? ""}@${sm.scope?.version ?? ""}`;
      for (const m of sm.metrics ?? []) {
        const name = String(m.name ?? "");
        if (!name) continue;
        const emit = (metric: string, type: string, ts: number, v: number, tags: string[]) => {
          if (Number.isFinite(v)) out.push({ metric, host: r.host, tags, type, unit: m.unit || undefined, points: [[ts, v]] });
        };
        const numVal = (dp: any) => (dp.asDouble !== undefined ? Number(dp.asDouble) : Number(dp.asInt ?? 0));
        const tsOf = (dp: any) => Math.floor(nano(dp.timeUnixNano) / 1e9) || Math.floor(Date.now() / 1000);
        const tagsOf = (dp: any) => {
          const a = attrs(dp.attributes);
          return {
            a,
            tags: [
              ...baseTags,
              ...Object.entries(a)
                .filter(([, v]) => v !== null && typeof v !== "object")
                .map(([k, v]) => `${k}:${v}`),
            ],
          };
        };
        if (m.gauge) {
          for (const dp of m.gauge.dataPoints ?? []) {
            const { a, tags } = tagsOf(dp);
            const ts = tsOf(dp);
            const v = numVal(dp);
            emit(name, "gauge", ts, v, tags);
            if (isHostMetrics) hostMappings(orgId, name, a, r.host, r.tags, ts, v, acc, out);
          }
        } else if (m.sum) {
          const delta = Number(m.sum.aggregationTemporality) === 1;
          for (const dp of m.sum.dataPoints ?? []) {
            const { a, tags } = tagsOf(dp);
            const ts = tsOf(dp);
            let v = numVal(dp);
            if (!m.sum.isMonotonic) {
              emit(name, "gauge", ts, v, tags);
              if (isHostMetrics) hostMappings(orgId, name, a, r.host, r.tags, ts, v, acc, out);
              continue;
            }
            if (!delta) {
              const k = cumKey(orgId, name, resKey, scopeKey, a, dp.startTimeUnixNano);
              const prev = refOf(k);
              if (prev !== undefined && ts < prev.ts) continue; // late or retried older sample: already counted
              refs.set(k, { v, ts });
              if (prev === undefined || v < prev.v) continue; // first sample or reset
              const dt = Math.max(1, ts - prev.ts);
              const d = v - prev.v;
              if (isHostMetrics && name === "system.network.io") {
                const dir = str(a.direction);
                emit(dir === "receive" ? "system.net.bytes_rcvd" : "system.net.bytes_sent", "gauge", ts, d / dt, [...r.tags, `device:${str(a.device)}`]);
              }
              if (isHostMetrics && name === "system.disk.io") {
                const dir = str(a.direction);
                emit(dir === "read" ? "system.io.rkb_s" : "system.io.wkb_s", "gauge", ts, d / dt / 1024, [...r.tags, `device:${str(a.device)}`]);
              }
              v = d;
            }
            emit(name, "count", ts, v, tags);
          }
        } else if (m.histogram || m.exponentialHistogram) {
          const h = m.histogram ?? m.exponentialHistogram;
          const delta = Number(h.aggregationTemporality) === 1;
          for (const dp of h.dataPoints ?? []) {
            const { tags } = tagsOf(dp);
            const ts = tsOf(dp);
            let count = Number(dp.count ?? 0);
            let sum = Number(dp.sum ?? 0);
            let { bounds, counts } = m.histogram
              ? { bounds: (dp.explicitBounds ?? []).map(Number), counts: (dp.bucketCounts ?? []).map(Number) }
              : expoToExplicit(dp);
            if (!delta) {
              const k = cumKey(orgId, name, resKey, scopeKey, attrs(dp.attributes), dp.startTimeUnixNano);
              const prev = refOf(k);
              if (prev && ts < prev.ts) continue;
              refs.set(k, { count, sum, counts, bounds, ts });
              // buckets are subtracted range by range; a change of bucket layout starts a new reference
              const sameLayout = prev && prev.bounds.length === bounds.length && prev.bounds.every((b: number, i: number) => b === bounds[i]);
              if (!prev || !sameLayout || count < prev.count) continue;
              count -= prev.count;
              sum -= prev.sum;
              counts = counts.map((c: number, i: number) => c - (prev.counts[i] ?? 0));
            }
            if (!count) continue;
            const min = dp.min !== undefined ? Number(dp.min) : undefined,
              max = dp.max !== undefined ? Number(dp.max) : undefined;
            emit(`${name}.count`, "count", ts, count, tags);
            emit(`${name}.sum`, "count", ts, sum, tags);
            emit(`${name}.avg`, "gauge", ts, sum / count, tags);
            if (max !== undefined && delta) emit(`${name}.max`, "gauge", ts, max, tags);
            if (min !== undefined && delta) emit(`${name}.min`, "gauge", ts, min, tags);
            emit(`${name}.median`, "gauge", ts, quantileFromBuckets(bounds, counts, 0.5, min, max), tags);
            emit(`${name}.95percentile`, "gauge", ts, quantileFromBuckets(bounds, counts, 0.95, min, max), tags);
            emit(`${name}.99percentile`, "gauge", ts, quantileFromBuckets(bounds, counts, 0.99, min, max), tags);
          }
        } else if (m.summary) {
          for (const dp of m.summary.dataPoints ?? []) {
            const { tags } = tagsOf(dp);
            const ts = tsOf(dp);
            const count = Number(dp.count ?? 0),
              sum = Number(dp.sum ?? 0);
            emit(`${name}.count`, "gauge", ts, count, tags);
            emit(`${name}.sum`, "gauge", ts, sum, tags);
            if (count) emit(`${name}.avg`, "gauge", ts, sum / count, tags);
            for (const q of dp.quantileValues ?? []) emit(`${name}.${Math.round(Number(q.quantile) * 100)}percentile`, "gauge", ts, Number(q.value), tags);
          }
        }
      }
    }
  }
  for (const e of acc.values()) {
    e.p.points[0][1] = e.n ? e.sum / e.n : e.sum;
    out.push(e.p);
  }
  // derived ratios the Infrastructure list uses
  const byHostTs = new Map<string, { host: string; ts: number; device: string[]; v: Record<string, number> }>();
  for (const p of out)
    if (/^system\.(mem\.(usable|total)|disk\.(used|total))$/.test(p.metric)) {
      const device = p.tags.filter((t) => t.startsWith("device:"));
      const k = JSON.stringify([p.host, p.points[0][0], device]);
      let e = byHostTs.get(k);
      if (!e) byHostTs.set(k, (e = { host: p.host, ts: p.points[0][0], device, v: {} }));
      e.v[p.metric] = p.points[0][1];
    }
  for (const { host, ts, device, v } of byHostTs.values()) {
    const tags = hosts.get(host)?.tags ?? [];
    if (v["system.mem.total"])
      out.push({ metric: "system.mem.pct_usable", host, tags, type: "gauge", points: [[ts, (v["system.mem.usable"] ?? 0) / v["system.mem.total"]]] });
    if (v["system.disk.total"])
      out.push({
        metric: "system.disk.in_use",
        host,
        tags: [...tags, ...device],
        type: "gauge",
        points: [[ts, (v["system.disk.used"] ?? 0) / v["system.disk.total"]]],
      });
  }
  return {
    points: out,
    hosts,
    commit: () => {
      for (const [k, v] of refs) rememberCumulative(k, v);
    },
  };
}
