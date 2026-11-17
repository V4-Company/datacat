import { Router, type Request, type Response } from "express";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { decompress } from "./decode";
import { raw } from "./routes";
import { writeSpans, writeMetrics, markTopLevel, type SpanIn, type PointIn } from "./store";
import { orgForApiKey } from "../lib/org";
import { isStorageError } from "../lib/http";
import { logger } from "../lib/logger";

/**
 * Agentless intake: open-source tracers (dd-trace for Node, ddtrace for Python, ...) talk to DataCat as if
 * it were the local agent. The org is identified by, in order:
 *   1. the API key in the URL path:  DD_TRACE_AGENT_URL=https://<host>/agent/<api_key>   (Python keeps paths)
 *   2. a global tag on every span/metric: DD_TAGS=datacat_api_key:<api_key>             (Node drops paths)
 *   3. a DD-API-KEY header (custom HTTP senders)
 * The key tag is stripped before anything is stored.
 */
const router: Router = Router();
const KEY_TAGS = ["datacat_api_key", "dc_api_key"];

const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : v === undefined || v === null ? "" : String(v));

function decodeV04(buf: Buffer): any[][] {
  return (msgpackDecode(buf, { useBigInt64: true }) as any[][]) ?? [];
}

/** v0.5: [string_table, traces]; span = [service, name, resource, trace_id, span_id, parent_id, start, duration, error, meta, metrics, type] (strings as indexes) */
function decodeV05(buf: Buffer): any[][] {
  const [table, traces] = msgpackDecode(buf, { useBigInt64: true }) as [string[], any[][][]];
  const str = (i: any) => table[Number(i)] ?? "";
  return (traces ?? []).map((t) =>
    t.map((a) => {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(a[9] ?? {})) meta[str(k)] = str(v);
      if (a[9] instanceof Map) for (const [k, v] of a[9]) meta[str(k)] = str(v);
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(a[10] ?? {})) metrics[str(k)] = Number(v);
      if (a[10] instanceof Map) for (const [k, v] of a[10]) metrics[str(k)] = Number(v);
      return {
        service: str(a[0]),
        name: str(a[1]),
        resource: str(a[2]),
        trace_id: a[3],
        span_id: a[4],
        parent_id: a[5],
        start: a[6],
        duration: a[7],
        error: a[8],
        meta,
        metrics,
        type: str(a[11]),
      };
    }),
  );
}

/**
 * One DogStatsD line, "metric:value|type<rest>", split without a regular expression. Returns [line, metric, value,
 * type, rest] (rest starts with "|" when present), or null. A trailing "\r" (CRLF bodies) is ignored.
 */
export function parseStatsdLine(line: string): [string, string, string, string, string] | null {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  const colon = line.indexOf(":");
  const pipe = line.indexOf("|");
  if (colon < 1 || pipe < colon + 2) return null;
  let t = pipe + 1;
  while (t < line.length && line.charCodeAt(t) >= 97 && line.charCodeAt(t) <= 122) t++;
  if (t === pipe + 1) return null;
  const rest = line.slice(t);
  if (/[\r\n\u2028\u2029]/.test(rest)) return null;
  return [line, line.slice(0, colon), line.slice(colon + 1, pipe), line.slice(pipe + 1, t), rest];
}

function keyFrom(req: Request, spans?: any[][]): string | undefined {
  if (req.params.key) return String(req.params.key);
  if (req.headers["dd-api-key"]) return String(req.headers["dd-api-key"]);
  for (const t of spans ?? []) for (const sp of t ?? []) for (const k of KEY_TAGS) if (sp?.meta?.[k]) return String(sp.meta[k]);
  return undefined;
}

async function handleTraces(req: Request, res: Response, version: "v0.4" | "v0.5") {
  try {
    const buf = decompress(req);
    const traces = version === "v0.5" ? decodeV05(buf) : decodeV04(buf);
    const orgId = await orgForApiKey(keyFrom(req, traces));
    if (!orgId) {
      res
        .status(403)
        .json({ error: "DataCat could not identify your organization. Set DD_TAGS=datacat_api_key:<API key> or put the key in DD_TRACE_AGENT_URL." });
      return;
    }
    const host = s(req.headers["datadog-meta-hostname"]) || "";
    const lang = s(req.headers["datadog-meta-lang"]);
    const spans: SpanIn[] = [];
    for (const t of traces) {
      const cs: SpanIn[] = (t ?? []).map((sp: any) => {
        const meta: Record<string, string> = { ...(sp.meta ?? {}) };
        for (const k of KEY_TAGS) delete meta[k];
        if (lang && !meta.language) meta.language = lang;
        return {
          traceId: s(sp.trace_id),
          spanId: s(sp.span_id),
          parentId: s(sp.parent_id) || "0",
          service: s(sp.service),
          name: s(sp.name),
          resource: s(sp.resource),
          type: s(sp.type),
          env: meta.env ?? "",
          host: meta["_dd.hostname"] ?? host,
          start: Number(sp.start),
          duration: Number(sp.duration),
          error: Number(sp.error ?? 0),
          meta,
          metrics: Object.fromEntries(Object.entries(sp.metrics ?? {}).map(([k, v]) => [k, Number(v)])),
        };
      });
      markTopLevel(cs);
      spans.push(...cs);
    }
    await writeSpans(orgId, spans);
    res.json({ rate_by_service: { "service:,env:": 1 } });
  } catch (err: any) {
    if (isStorageError(err)) {
      logger.error({ err }, "tracer intake storage error");
      res.status(503).json({ error: "Temporarily unable to store data; retry later" });
      return;
    }
    logger.warn({ err: String(err?.message ?? err) }, "tracer intake error");
    res.status(err?.status === 413 ? 413 : 400).json({ error: String(err?.message ?? err) });
  }
}

const PREFIXES = ["", "/agent/:key"];
for (const p of PREFIXES) {
  router.get(`${p}/info`, (_req, res) => {
    res.json({
      version: "7.56.2",
      endpoints: ["/v0.4/traces", "/v0.5/traces", "/dogstatsd/v2/proxy", "/telemetry/proxy/"],
      client_drop_p0s: false,
      span_meta_structs: false,
      long_running_spans: false,
    });
  });
  router.all([`${p}/v0.4/traces`, `${p}/v0.3/traces`], raw, (req, res) => void handleTraces(req, res, "v0.4"));
  router.all(`${p}/v0.5/traces`, raw, (req, res) => void handleTraces(req, res, "v0.5"));
  // DogStatsD over HTTP: newline-separated "metric:value|type|@rate|#tag1,tag2"
  router.post(`${p}/dogstatsd/v2/proxy`, raw, async (req, res) => {
    try {
      const headerKey = req.params.key ? String(req.params.key) : ((req.headers["dd-api-key"] as string) ?? "");
      // A key given in the path or a header is checked before the body is read.
      if (headerKey && !(await orgForApiKey(headerKey))) {
        res.status(403).json({ accepted: 0 });
        return;
      }
      const lines = decompress(req).toString("utf8").split("\n").filter(Boolean);
      const now = Math.floor(Date.now() / 1000);
      const byKey = new Map<string, PointIn[]>();
      for (const line of lines) {
        const m = parseStatsdLine(line);
        if (!m) continue;
        const parts = m[4].split("|").filter(Boolean);
        const tags = (
          parts
            .find((x) => x.startsWith("#"))
            ?.slice(1)
            .split(",") ?? []
        ).filter(Boolean);
        const rate = Number(parts.find((x) => x.startsWith("@"))?.slice(1) ?? 1) || 1;
        let key = headerKey;
        const kt = tags.find((t) => KEY_TAGS.some((k) => t.startsWith(k + ":")));
        if (!key && kt) key = kt.split(":").slice(1).join(":");
        const clean = tags.filter((t) => !KEY_TAGS.some((k) => t.startsWith(k + ":")));
        const host = clean.find((t) => t.startsWith("host:"))?.slice(5) ?? "";
        const type = m[3] === "c" ? "count" : m[3] === "d" || m[3] === "h" ? "distribution" : "gauge";
        const value = Number(m[2]) / (m[3] === "c" ? rate : 1);
        if (!Number.isFinite(value)) continue;
        const list = byKey.get(key) ?? [];
        list.push({ metric: m[1], host, tags: clean.filter((t) => !t.startsWith("host:")), type, points: [[now, value]] });
        byKey.set(key, list);
      }
      let accepted = 0;
      for (const [key, pts] of byKey) {
        const orgId = await orgForApiKey(key);
        if (!orgId) continue;
        await writeMetrics(orgId, pts);
        accepted += pts.length;
      }
      res.status(accepted || !lines.length ? 202 : 403).json({ accepted });
    } catch (err: any) {
      if (isStorageError(err)) {
        logger.error({ err }, "dogstatsd intake storage error");
        res.status(503).json({ error: "Temporarily unable to store data; retry later" });
        return;
      }
      res.status(err?.status === 413 ? 413 : 400).json({ error: String(err?.message ?? err) });
    }
  });
  // tracer housekeeping we acknowledge but don't model
  router.all(
    [
      `${p}/telemetry/proxy/*rest`,
      `${p}/v0.7/config`,
      `${p}/v0.6/stats`,
      `${p}/evp_proxy/*rest`,
      `${p}/debugger/*rest`,
      `${p}/profiling/*rest`,
      `${p}/tracer_flare/*rest`,
    ],
    raw,
    (_req, res) => {
      res.status(200).json({});
    },
  );
}

export default router;
