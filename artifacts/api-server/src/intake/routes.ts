import { Router, type Request, type Response, type NextFunction } from "express";
import { decompress, parseJson, apiKeyFrom, tagValue, normalizeTraceId } from "./decode";
import { MetricPayload, SketchPayload, decodeProto } from "./proto";
import { agentPayloadToSpans, decodeAgentPayload } from "./agentTraces";
import { recordDrop, recordStored, splitPoints } from "../lib/intakeStats";
import { writeMetrics, touchHost, writeLogs, writeSpans, type PointIn, type LogIn } from "./store";
import { orgForApiKey } from "../lib/org";
import { decodeOtlp, encodeEmptyResponse, otlpToSpans, otlpToLogs, otlpToMetrics, type OtlpSignal } from "./otlp";
import { logger } from "../lib/logger";
import { isStorageError } from "../lib/http";
import { pool } from "@workspace/db";

const router: Router = Router();
// Request bodies are capped (compressed size; DATACAT_MAX_BODY_MB, default 16 MB, like the OTel Collector's 20 MiB),
// and decompressed size is capped separately in decode.ts.
const MAX_BODY_BYTES = Number(process.env.DATACAT_MAX_BODY_MB ?? 16) * 1024 * 1024;
// Read the body as-is (agents send gzip/deflate/zstd + protobuf); decompression happens in decode.ts.
export function raw(req: Request, res: Response, next: NextFunction) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      if (!res.headersSent) res.status(413).json({ errors: [`Payload too large (limit ${MAX_BODY_BYTES >> 20} MB; DATACAT_MAX_BODY_MB)`], status: "error" });
      req.removeAllListeners("data");
      req.resume();
      chunks.length = 0;
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (size > MAX_BODY_BYTES) return;
    (req as any).body = Buffer.concat(chunks);
    next();
  });
  req.on("error", next);
}

const TYPE_V2: Record<number, string> = { 0: "gauge", 1: "count", 2: "rate", 3: "gauge" };

// The Datadog Agent's sketch bins (its default configuration: relative accuracy 1/128, minimum value 1e-9). Bin key k
// covers [γ^(k-bias), γ^(k-bias+1)); negative keys mirror it below zero, key 0 is zero.
const SKETCH_GAMMA = 1 + 2 / 128;
const SKETCH_BIAS = -Math.floor(Math.log(1e-9) / Math.log1p(2 / 128)) + 1;
export function sketchBinValue(k: number): number {
  if (k === 0) return 0;
  const lo = Math.pow(SKETCH_GAMMA, Math.abs(k) - SKETCH_BIAS);
  return Math.sign(k) * lo * ((1 + SKETCH_GAMMA) / 2);
}
/** One weighted point per sketch bin (value of the bin, clamped to the sketch's min/max), so counts and percentiles hold. */
export function sketchPoints(dogsketches: any[]): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (const d of dogsketches) {
    const ts = Number(d.ts);
    const k: number[] = (d.k ?? []).map(Number);
    const n: number[] = (d.n ?? []).map(Number);
    const min = Number(d.min),
      max = Number(d.max);
    if (k.length && k.length === n.length) {
      for (let i = 0; i < k.length; i++) {
        if (!(n[i] > 0)) continue;
        let v = sketchBinValue(k[i]);
        if (Number.isFinite(min)) v = Math.max(v, min);
        if (Number.isFinite(max)) v = Math.min(v, max);
        pts.push([ts, v, n[i]]);
      }
    } else if (Number(d.cnt) > 0) pts.push([ts, Number(d.avg), Number(d.cnt)]);
  }
  return pts;
}

async function withOrg(req: Request, res: Response, next: NextFunction) {
  const orgId = await orgForApiKey(apiKeyFrom(req));
  if (!orgId) {
    res.status(403).json({ errors: ["Forbidden"], status: "error" });
    return;
  }
  req.orgId = orgId;
  next();
}

// Undecodable payloads are the sender's problem (400/413); storage failures are ours (503, retried by agents).
// Database error text is never returned to the caller.
function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      if (res.headersSent) return;
      const fromDb = isStorageError(err);
      if (req.orgId) recordDrop(req.orgId, intakePath(req.path), 1, fromDb ? "storage error" : `rejected: ${String(err?.message ?? err).slice(0, 120)}`);
      if (fromDb) {
        logger.error({ err, path: req.path }, "intake storage error");
        res.status(503).json({ errors: ["Temporarily unable to store data; retry later"] });
        return;
      }
      logger.warn({ err: String(err?.message ?? err), path: req.path }, "intake rejected payload");
      res.status(err?.status === 413 ? 413 : 400).json({ errors: [String(err?.message ?? err)] });
    });
  };
}
function intakePath(p: string) {
  if (/series|sketches|distribution/.test(p)) return "metrics";
  if (/traces/.test(p)) return "agent_traces";
  if (/logs|input/.test(p)) return "logs";
  if (/check_run/.test(p)) return "service_checks";
  return p.replace(/^\/+/, "");
}
async function storeMetrics(orgId: number, path: string, series: PointIn[]) {
  const { valid, invalid } = splitPoints(series);
  if (invalid) recordDrop(orgId, path, invalid, "points without a metric name or with a non-numeric timestamp/value");
  await writeMetrics(orgId, series);
  recordStored(orgId, path, valid);
}

router.get("/api/v1/validate", async (req, res) => {
  const orgId = await orgForApiKey(apiKeyFrom(req));
  if (!orgId) {
    res.status(403).json({ errors: ["Forbidden"] });
    return;
  }
  res.json({ valid: true });
});

// ---- Metrics ----
router.post(
  "/api/v1/series",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const body = parseJson(decompress(req));
    const series: PointIn[] = (body?.series ?? []).map((s: any) => ({
      metric: s.metric,
      host: s.host ?? "",
      tags: s.tags ?? [],
      type: s.type ?? "gauge",
      unit: s.unit,
      points: (s.points ?? []).map((p: any) => [Number(p[0]), Number(p[1])]),
    }));
    await storeMetrics(req.orgId!, "metrics", series);
    res.status(202).json({ status: "ok" });
  }),
);

router.post(
  "/api/v2/series",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const buf = decompress(req);
    const ct = String(req.headers["content-type"] ?? "");
    let list: any[];
    if (ct.includes("json")) list = parseJson(buf)?.series ?? [];
    else list = decodeProto(MetricPayload, buf).series ?? [];
    const series: PointIn[] = list.map((s: any) => {
      const host = (s.resources ?? []).find((r: any) => r.type === "host")?.name ?? "";
      const t = typeof s.type === "number" ? (TYPE_V2[s.type] ?? "gauge") : String(s.type ?? "gauge");
      return {
        metric: s.metric,
        host,
        tags: s.tags ?? [],
        type: t,
        unit: s.unit || undefined,
        points: (s.points ?? []).map((p: any) => [Number(p.timestamp), Number(p.value)] as [number, number]),
      };
    });
    await storeMetrics(req.orgId!, "metrics", series);
    res.status(202).json({ errors: [] });
  }),
);

router.post(
  "/api/beta/sketches",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const p = decodeProto(SketchPayload, decompress(req));
    const series: PointIn[] = [];
    for (const s of p.sketches ?? [])
      series.push({ metric: s.metric, host: s.host ?? "", tags: s.tags ?? [], type: "distribution", points: sketchPoints(s.dogsketches ?? []) });
    await storeMetrics(req.orgId!, "metrics", series);
    res.status(202).json({});
  }),
);

// Distribution metrics (POST /api/v1/distribution_points). Every value is kept, so percentiles and
// averages are computed over all values, not averages of averages.
router.post(
  "/api/v1/distribution_points",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const body = parseJson(decompress(req));
    if (!body || !Array.isArray(body.series)) throw new Error("Expected a JSON body with a series array");
    const series: PointIn[] = body.series.map((s: any) => {
      const pts: [number, number][] = [];
      for (const p of s?.points ?? []) {
        const ts = Number(Array.isArray(p) ? p[0] : NaN);
        const vals = Array.isArray(p) && Array.isArray(p[1]) ? p[1] : [NaN];
        for (const v of vals) pts.push([ts, Number(v)]);
      }
      return { metric: s?.metric, host: s?.host ?? "", tags: s?.tags ?? [], type: "distribution", points: pts };
    });
    await storeMetrics(req.orgId!, "distribution_points", series);
    res.status(202).json({ status: "ok" });
  }),
);

router.post(
  "/api/v1/check_run",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const body = parseJson(decompress(req));
    const list = Array.isArray(body) ? body : [];
    const series: PointIn[] = [];
    for (const c of list) {
      const host = c.host_name ?? "";
      if (host) await touchHost(req.orgId!, host, {});
      series.push({
        metric: `service_check.${c.check}`,
        host,
        tags: c.tags ?? [],
        type: "gauge",
        points: [[Number(c.timestamp) || Math.floor(Date.now() / 1000), Number(c.status ?? 0)]],
      });
    }
    await storeMetrics(req.orgId!, "service_checks", series);
    res.status(202).json({ status: "ok" });
  }),
);

// Host metadata (agent "/intake/" payload)
router.post(
  ["/intake", "/intake/", "/api/v2/host_metadata"],
  raw,
  withOrg,
  wrap(async (req, res) => {
    const body = parseJson(decompress(req)) ?? {};
    const name = body.internalHostname ?? body.hostname ?? body.meta?.hostname;
    if (name) {
      let gohai: any = {};
      try {
        gohai = typeof body.gohai === "string" ? JSON.parse(body.gohai) : (body.gohai ?? {});
      } catch {}
      const hostTags: string[] = [];
      for (const v of Object.values(body["host-tags"] ?? {})) if (Array.isArray(v)) hostTags.push(...(v as string[]));
      const apps: string[] = Array.isArray(body.apps) ? body.apps : [];
      await touchHost(
        req.orgId!,
        name,
        {
          os: body.os ?? gohai?.platform?.os ?? undefined,
          platform: gohai?.platform?.GOOS ?? body.systemStats?.platform ?? undefined,
          agentVersion: body.agentVersion ?? undefined,
          tags: hostTags,
          apps,
          meta: {
            cpuCores: gohai?.cpu?.cpu_cores,
            cpuModel: gohai?.cpu?.model_name,
            memoryTotal: gohai?.memory?.total,
            kernel: gohai?.platform?.kernel_release,
            pythonV: body.python,
            ip: gohai?.network?.ipaddress,
          },
        },
        true,
      );
    }
    res.status(202).json({});
  }),
);

// ---- Logs ----
const RESERVED = new Set(["message", "msg", "status", "level", "timestamp", "date", "hostname", "host", "service", "ddsource", "ddtags", "source"]);

function normStatus(s: any): string {
  // numeric levels (pino/bunyan: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal)
  if (typeof s === "number" || /^\d+$/.test(String(s ?? ""))) {
    const n = Number(s);
    if (n >= 60) return "critical";
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    return "debug";
  }
  const v = String(s ?? "info").toLowerCase();
  if (["err", "error", "fatal", "critical", "crit", "alert", "emergency", "emerg"].includes(v))
    return v === "critical" || v === "crit" ? "critical" : v === "emerg" || v === "emergency" ? "emergency" : v === "alert" ? "alert" : "error";
  if (["warn", "warning"].includes(v)) return "warn";
  if (["debug", "trace"].includes(v)) return "debug";
  if (["notice"].includes(v)) return "notice";
  if (["ok", "success"].includes(v)) return "ok";
  return "info";
}

export function toLog(e: any, defaults: { host?: string; service?: string; source?: string; tags?: string[] } = {}): LogIn {
  let attrs: Record<string, any> = {};
  let message = e.message ?? e.msg ?? "";
  if (typeof message === "string" && message.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(message);
      if (inner && typeof inner === "object") {
        attrs = { ...inner };
        message = inner.message ?? inner.msg ?? message;
      }
    } catch {}
  }
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) attrs[k] = v;
  const tagsStr: string = e.ddtags ?? "";
  const tags = [
    ...(defaults.tags ?? []),
    ...String(tagsStr)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ];
  const ts = Number(e.timestamp ?? attrs.timestamp ?? Date.parse(e.date ?? "")) || Date.now();
  const status = normStatus(attrs.level ?? attrs.severity ?? (e.status && e.status !== "info" ? e.status : undefined) ?? e.level ?? e.status);
  const traceId = attrs?.dd?.trace_id ?? attrs["dd.trace_id"] ?? null;
  return {
    ts: ts < 1e12 ? ts * 1000 : ts,
    status,
    service: String(e.service ?? attrs.service ?? defaults.service ?? tagValue(tags, "service") ?? ""),
    host: String(e.hostname ?? e.host ?? defaults.host ?? ""),
    source: String(e.ddsource ?? e.source ?? defaults.source ?? ""),
    message: typeof message === "string" ? message : JSON.stringify(message),
    tags,
    attributes: attrs,
    traceId: normalizeTraceId(traceId),
  };
}

router.post(
  ["/api/v2/logs", "/v1/input", "/v1/input/:key", "/api/v1/logs"],
  raw,
  async (req, res, next) => {
    if (req.params.key && !req.headers["dd-api-key"]) req.headers["dd-api-key"] = req.params.key;
    next();
  },
  withOrg,
  wrap(async (req, res) => {
    const buf = decompress(req);
    const ct = String(req.headers["content-type"] ?? "");
    let body: any;
    if (ct.includes("json") || buf[0] === 0x5b || buf[0] === 0x7b) body = parseJson(buf);
    else
      body = buf
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((m) => ({ message: m }));
    const list = Array.isArray(body) ? body : body ? [body] : [];
    const q = req.query;
    const defaults = {
      host: (q.hostname as string) || (q.host as string) || undefined,
      service: (q.service as string) || undefined,
      source: (q.ddsource as string) || undefined,
      tags: q.ddtags ? String(q.ddtags).split(",") : [],
    };
    await writeLogs(
      req.orgId!,
      list.map((e) => toLog(e, defaults)),
    );
    recordStored(req.orgId!, "logs", list.length);
    res.status(202).json({});
  }),
);

// ---- Traces (trace-agent -> intake) ----
// Reads both payload layouts (agents up to 7.6x: tracerPayloads; 7.7x+: idxTracerPayloads, intake/agentTraces.ts).
// Never answers "accepted" when spans were sent but none could be read: that is a 422, counted as dropped.
router.post(
  "/api/v0.2/traces",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const buf = decompress(req);
    const t = agentPayloadToSpans(decodeAgentPayload(buf));
    if (!t.spans.length && (t.chunks > 0 || buf.length > 64)) {
      recordDrop(req.orgId!, "agent_traces", t.chunks || 1, `no readable spans (agent ${t.agentVersion || "unknown"})`);
      res.status(422).json({ errors: [`Trace payload from agent ${t.agentVersion || "unknown"} contained no readable spans; nothing was stored`] });
      return;
    }
    if (t.hostName) await touchHost(req.orgId!, t.hostName, t.agentVersion ? { agentVersion: t.agentVersion } : {});
    await writeSpans(req.orgId!, t.spans);
    recordStored(req.orgId!, "agent_traces", t.spans.length);
    res.status(202).json({});
  }),
);

// Accept-and-acknowledge for other agent endpoints we don't model (process, orchestrator, telemetry, stats, metadata)
const ACK = [
  "/api/v0.2/stats",
  "/api/v1/metadata",
  "/api/v1/collector",
  "/api/v1/container",
  "/api/v1/connections",
  "/api/v2/proclife",
  "/api/v2/orch",
  "/api/v2/orchmanif",
  "/api/v2/apmtelemetry",
  "/api/v2/agenthealth",
  "/api/v1/discovery",
  "/api/v2/contimage",
  "/api/v2/contlcycle",
  "/api/v2/sbom",
  "/api/v2/series/sketches",
  "/api/v0.1/pipeline_stats",
  "/api/v2/profile",
  "/api/v2/events",
  "/api/v2/debugger",
  "/api/v2/citestcycle",
  "/support/flare",
];
router.post(ACK, raw, withOrg, (_req, res) => {
  res.status(202).json({});
});

// v1 events intake from agents (e.g. agent start events)
router.post(
  "/api/v1/events",
  raw,
  withOrg,
  wrap(async (req, res) => {
    const e = parseJson(decompress(req)) ?? {};
    await pool.query("insert into events (org_id, ts, title, text, alert_type, source, tags) values ($1,$2,$3,$4,$5,$6,$7)", [
      req.orgId,
      (Number(e.date_happened) || Math.floor(Date.now() / 1000)) * 1000,
      e.title ?? "event",
      e.text ?? "",
      e.alert_type ?? "info",
      e.source_type_name ?? "api",
      e.tags ?? [],
    ]);
    res.status(202).json({ status: "ok" });
  }),
);

// ---------- OpenTelemetry (OTLP/HTTP) ----------
function otlpRoute(signal: OtlpSignal) {
  return async (req: Request, res: Response) => {
    const ct = String(req.headers["content-type"] ?? "application/x-protobuf");
    let body: any;
    try {
      body = decodeOtlp(signal, decompress(req), ct);
    } catch (e) {
      const status = (e as any)?.status === 413 ? 413 : 400;
      res.status(status).json({ code: status === 413 ? 8 : 3, message: `could not decode OTLP ${signal}: ${(e as Error).message}` });
      return;
    }
    const orgId = (req as any).orgId as number;
    const path = `otlp_${signal}`;
    let n = 0;
    try {
      if (signal === "traces") {
        const spans = otlpToSpans(body);
        n = spans.length;
        await writeSpans(orgId, spans);
      } else if (signal === "logs") {
        const logs = otlpToLogs(body);
        n = logs.length;
        await writeLogs(orgId, logs);
      } else {
        const { points, hosts, commit } = otlpToMetrics(orgId, body);
        for (const [name, h] of hosts)
          await touchHost(orgId, name, { os: h.os, platform: h.os, agentVersion: h.agentVersion, tags: h.tags, apps: ["system"] }, true);
        const { valid, invalid } = splitPoints(points);
        if (invalid) recordDrop(orgId, path, invalid, "points without a numeric value");
        n = valid;
        await writeMetrics(orgId, points);
        commit();
      }
    } catch (e) {
      logger.error({ err: e, signal }, "OTLP write failed");
      recordDrop(orgId, path, Math.max(1, n), "storage error");
      res.status(503).json({ code: 14, message: "temporarily unavailable" });
      return;
    }
    recordStored(orgId, path, n);
    const r = encodeEmptyResponse(ct);
    res.status(200).type(r.type).send(r.body);
  };
}
// Standard OTLP/HTTP paths (/v1/traces, ...) and the /otlp/v1/* prefix both work.
router.post(["/otlp/v1/traces", "/v1/traces"], raw, withOrg, otlpRoute("traces"));
router.post(["/otlp/v1/metrics", "/v1/metrics"], raw, withOrg, otlpRoute("metrics"));
router.post(["/otlp/v1/logs", "/v1/logs"], raw, withOrg, otlpRoute("logs"));

export default router;
