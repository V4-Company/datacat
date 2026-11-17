import { postWebhook } from "../lib/safeHttp";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { evalMetricExpression, logWhere } from "../routes/telemetry";
import { reduce, extractInlineQueries, parseMetricQuery } from "../query/metrics";
import { compileSearch, spanResolver, SqlBuilder } from "../query/search";
import { useClickHouse } from "../lib/storage";
import { chQuery } from "../lib/ch";
import { logWhereCh, spanWhereCh } from "../query/searchCh";

type State = "OK" | "Warn" | "Alert" | "No Data";
const RANK: Record<State, number> = { OK: 0, "No Data": 1, Warn: 2, Alert: 3 };

interface Parsed {
  kind: "metric" | "log" | "trace";
  timeAgg: string;
  window: number; // seconds
  expr: string;
  op: string;
  threshold: number;
  logQuery?: string;
  groupBy?: string[];
}

function windowSecs(s: string): number {
  const m = /^last_(\d+)([smhdw])$/.exec(s) ?? /^(\d+)([smhdw])$/.exec(s);
  if (!m) throw new Error(`Invalid evaluation window '${s}'`);
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as any)[m[2]];
}

export function parseMonitorQuery(type: string, query: string): Parsed {
  const q = query.trim();
  const cmp = /\s*(>=|<=|>|<|==)\s*(-?[\d.]+)\s*$/.exec(q);
  if (!cmp) throw new Error("Monitor query must end with a comparison, e.g. '> 90'");
  const body = q.slice(0, cmp.index);
  if (type === "log alert" || body.startsWith("logs(")) {
    const lm = /^logs\("((?:[^"\\]|\\.)*)"\)(.*)$/.exec(body);
    if (!lm) throw new Error('Log monitor query must look like logs("query").index("*").rollup("count").last("5m") > 10');
    const rest = lm[2];
    const last = /\.last\("(\d+[smhd])"\)/.exec(rest)?.[1] ?? "5m";
    const by = /\.by\("([^"]*)"\)/.exec(rest)?.[1];
    return {
      kind: "log",
      timeAgg: "count",
      window: windowSecs(last),
      expr: "",
      op: cmp[1],
      threshold: Number(cmp[2]),
      logQuery: lm[1].replace(/\\"/g, '"'),
      groupBy: by ? by.split(",").map((x) => x.trim()) : [],
    };
  }
  if (type === "trace-analytics alert" || body.startsWith("trace-analytics(") || body.startsWith("spans(")) {
    const lm = /^(?:trace-analytics|spans)\("((?:[^"\\]|\\.)*)"\)(.*)$/.exec(body);
    if (!lm) throw new Error('Trace monitor query must look like spans("service:web status:error").rollup("count").last("5m") > 10');
    const last = /\.last\("(\d+[smhd])"\)/.exec(lm[2])?.[1] ?? "5m";
    const by = /\.by\("([^"]*)"\)/.exec(lm[2])?.[1];
    return {
      kind: "trace",
      timeAgg: "count",
      window: windowSecs(last),
      expr: "",
      op: cmp[1],
      threshold: Number(cmp[2]),
      logQuery: lm[1],
      groupBy: by ? by.split(",").map((x) => x.trim()) : [],
    };
  }
  const m = /^(avg|sum|min|max|last|percentile\([^)]*\)|change\([^)]*\)|pct_change\([^)]*\))\((last_\d+[smhdw])\):(.*)$/s.exec(body.trim());
  if (!m) throw new Error("Metric monitor query must look like avg(last_5m):avg:system.cpu.user{*} by {host} > 90");
  const expr = m[3].trim();
  const { queries } = extractInlineQueries(expr);
  if (!Object.keys(queries).length) throw new Error("No metric query found in monitor expression");
  for (const raw of Object.values(queries)) parseMetricQuery(raw);
  return {
    kind: "metric",
    timeAgg: monitorTimeAgg(m[1]),
    window: windowSecs(m[2]),
    expr,
    op: cmp[1],
    threshold: Number(cmp[2]),
  };
}

/** avg|sum|min|max|last as is; percentile(95) or percentile(p95) -> "p95"; change(...) / pct_change(...) by name. */
function monitorTimeAgg(f: string): string {
  if (f.startsWith("percentile")) {
    const pm = /^percentile\(\s*p?(\d{1,2}(?:\.\d+)?)\s*\)$/.exec(f);
    if (!pm || !(Number(pm[1]) > 0 && Number(pm[1]) < 100)) throw new Error("percentile() takes a number between 0 and 100, e.g. percentile(95)");
    return `p${pm[1]}`;
  }
  return f.replace(/\(.*$/, "");
}

export function validateMonitorQuery(type: string, query: string) {
  parseMonitorQuery(type, query);
}

function cmpOp(op: string, v: number, t: number) {
  switch (op) {
    case ">":
      return v > t;
    case ">=":
      return v >= t;
    case "<":
      return v < t;
    case "<=":
      return v <= t;
    default:
      return v === t;
  }
}

function stateFor(v: number | null, op: string, opts: any, threshold: number, prev: State | undefined): State {
  if (v === null || Number.isNaN(v)) return opts?.notify_no_data ? "No Data" : prev && prev !== "No Data" ? prev : "OK";
  const crit = opts?.thresholds?.critical ?? threshold;
  const warn = opts?.thresholds?.warning;
  if (cmpOp(op, v, crit)) return "Alert";
  // recovery thresholds: stay in Alert until recovered past critical_recovery
  const critRec = opts?.thresholds?.critical_recovery;
  if (prev === "Alert" && critRec !== undefined && critRec !== null && cmpOp(op, v, critRec)) return "Alert";
  if (warn !== undefined && warn !== null && cmpOp(op, v, warn)) return "Warn";
  return "OK";
}

// For log and trace monitors, an empty window is a count of 0, or missing data when the monitor has notify_no_data set
// (the same on both storage backends). Grouped monitors report each group that matched; groups that stop matching are
// handled by the caller as disappeared groups.
type GroupValue = { value: number | null; tags: string[]; lastMs?: number };
// Group-by fields that are real columns of each data set; anything else is an attribute (logs) or a meta key (spans).
const LOG_GROUP_COLS = ["service", "host", "status", "source"];
const SPAN_GROUP_COLS = ["service", "host", "env", "resource", "name", "type"];

async function evaluateValues(orgId: number, p: Parsed, noData = false, delaySec = 0): Promise<Map<string, GroupValue>> {
  // evaluation_delay moves the whole window back, so late telemetry is complete before it is judged
  const now = Math.floor(Date.now() / 1000) - delaySec;
  const out = new Map<string, GroupValue>();
  if (p.kind === "metric") {
    const set = await evalMetricExpression(orgId, p.expr, now - p.window, now);
    for (const s of set) {
      const pts = [...s.points].sort((a, b) => a[0] - b[0]);
      const vals = pts.map((x) => x[1]);
      const lastTs = pts.at(-1)?.[0];
      out.set(s.key, {
        value: vals.length ? reduce(vals, p.timeAgg) : null,
        tags: s.tags,
        lastMs: lastTs === undefined ? undefined : Math.min(now, lastTs + (s.interval ?? 0)) * 1000,
      });
    }
    if (!set.length) out.set("*", { value: null, tags: [] });
    return out;
  }
  const isLog = p.kind === "log";
  if (useClickHouse) {
    const { where, b } = isLog ? logWhereCh(orgId, p.logQuery ?? "*", now - p.window, now) : spanWhereCh(orgId, p.logQuery ?? "*", now - p.window, now);
    const g = p.groupBy ?? [];
    const cols = g.map((k) => {
      if (k === "status" && !isLog) return "if(error = 1, 'error', 'ok')";
      if ((isLog ? LOG_GROUP_COLS : SPAN_GROUP_COLS).includes(k)) return k;
      if (isLog && k === "env") return "substring(arrayFirst(t -> startsWith(t, 'env:'), tags), 5)";
      return isLog ? `attrs[${b.p(k.replace(/^@/, ""))}]` : `meta[${b.p(k.replace(/^@/, ""))}]`;
    });
    const sel = cols.length ? cols.map((c, i) => `${c} AS g${i}`).join(", ") + "," : "";
    const rows = await chQuery(
      `SELECT ${sel} count() AS c, max(${isLog ? "ts" : "start_ms"}) AS last FROM ${isLog ? "logs" : "spans"} WHERE ${where} ${cols.length ? `GROUP BY ${cols.map((_, i) => `g${i}`).join(", ")}` : ""}`,
      b.params,
    );
    for (const r of rows as any[]) {
      if (!g.length && !Number(r.c)) continue;
      const tags = g.map((k, i) => `${k.replace(/^@/, "")}:${r[`g${i}`] || "N/A"}`);
      out.set(tags.length ? tags.join(",") : "*", { value: Number(r.c), tags, lastMs: Number(r.last) || undefined });
    }
    if (!out.size) out.set("*", { value: noData ? null : 0, tags: [] });
    return out;
  }
  let where: string, params: any[];
  if (isLog) ({ where, params } = logWhere(orgId, p.logQuery ?? "*", now - p.window, now));
  else {
    const b = new SqlBuilder([orgId, (now - p.window) * 1000, now * 1000]);
    where = `org_id=$1 AND start_ms >= $2 AND start_ms < $3 AND ${compileSearch(p.logQuery || "*", spanResolver, b, "resource")}`;
    params = b.params;
  }
  const g = p.groupBy ?? [];
  const cols = g.map((k) => {
    if (k === "status" && !isLog) return "case when error = 1 then 'error' else 'ok' end";
    if ((isLog ? LOG_GROUP_COLS : SPAN_GROUP_COLS).includes(k)) return k;
    if (isLog && k === "env") return "(select substr(t, 5) from unnest(tags) t where t like 'env:%' limit 1)";
    const key = k.replace(/^@/, "");
    if (!isLog) {
      params.push(key);
      return `meta ->> $${params.length}::text`;
    }
    // nested path or a flat dotted key, the same lookup as search
    params.push(key.split("."), key);
    return `COALESCE(attributes #>> $${params.length - 1}::text[], attributes ->> $${params.length}::text)`;
  });
  const sel = cols.length ? cols.map((c, i) => `${c} as g${i}`).join(", ") + "," : "";
  const rows = (
    await pool.query(
      `select ${sel} count(*)::int as c, max(${isLog ? "ts" : "start_ms"}) as last from ${isLog ? "logs" : "spans"} where ${where} ${cols.length ? `group by ${cols.map((_, i) => i + 1).join(",")}` : ""}`,
      params,
    )
  ).rows;
  for (const r of rows) {
    if (!g.length && !Number(r.c)) continue;
    const tags = g.map((k, i) => `${k.replace(/^@/, "")}:${r[`g${i}`] ?? "N/A"}`);
    out.set(tags.length ? tags.join(",") : "*", { value: Number(r.c), tags, lastMs: Number(r.last) || undefined });
  }
  if (!out.size) out.set("*", { value: noData ? null : 0, tags: [] });
  return out;
}

export function render(
  template: string,
  ctx: { state: State; prev: State; value: number | null; threshold: number; warn?: number; tags: string[]; name: string; id: number },
  sectionsOnly = false,
) {
  const isAlert = ctx.state === "Alert",
    isWarn = ctx.state === "Warn",
    isRecovery = ctx.state === "OK" && (ctx.prev === "Alert" || ctx.prev === "Warn" || ctx.prev === "No Data"),
    isNoData = ctx.state === "No Data";
  const flags: Record<string, boolean> = {
    is_alert: isAlert,
    is_warning: isWarn,
    is_recovery: isRecovery,
    is_no_data: isNoData,
    is_alert_recovery: isRecovery && ctx.prev === "Alert",
    is_warning_recovery: isRecovery && ctx.prev === "Warn",
  };
  let s = template.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_m, kind, flag, inner) => ((kind === "#") === !!flags[flag] ? inner : ""));
  if (sectionsOnly) return s;
  const tagVals: Record<string, string> = {};
  for (const t of ctx.tags) {
    const i = t.indexOf(":");
    if (i > 0) tagVals[t.slice(0, i)] = t.slice(i + 1);
  }
  s = s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
    if (k === "value") return ctx.value === null ? "N/A" : String(Math.round(ctx.value * 1000) / 1000);
    if (k === "threshold") return String(ctx.threshold);
    if (k === "warn_threshold") return String(ctx.warn ?? "");
    if (k.endsWith(".name") && tagVals[k.slice(0, -5)] !== undefined) return tagVals[k.slice(0, -5)];
    if (tagVals[k] !== undefined) return tagVals[k];
    return "";
  });
  return s;
}

/** Notification handles (@webhook-x, @slack-y, @someone) written in a monitor message. */
export function messageHandles(template: string): string[] {
  return [...new Set([...template.matchAll(/@([A-Za-z0-9_\-.@]+)/g)].map((m) => m[1]))];
}

// handles come from the monitor's own template (see evaluateMonitorNow), so telemetry values inserted into the
// message cannot add recipients.
async function notify(orgId: number, monitorId: number, message: string, title: string, payload: any, handles: string[]) {
  const now = Date.now();
  const channels = (await pool.query("select * from notification_channels where org_id=$1", [orgId])).rows;
  const clean = message.replace(/@(webhook|slack)-[A-Za-z0-9_\-]+/g, "").trim();
  if (!handles.length) {
    await pool.query("insert into notification_log (org_id, ts, monitor_id, channel, status, detail) values ($1,$2,$3,'in-app','sent',$4)", [
      orgId,
      now,
      monitorId,
      title,
    ]);
  }
  for (const h of handles) {
    const m = /^(webhook|slack)-(.+)$/.exec(h);
    if (!m) {
      await pool.query(
        "insert into notification_log (org_id, ts, monitor_id, channel, status, detail) values ($1,$2,$3,$4,'skipped','Email delivery is not configured; recorded in-app')",
        [orgId, now, monitorId, "@" + h],
      );
      continue;
    }
    const ch = channels.find((c) => c.name === m[2] && (c.kind === m[1] || m[1] === "webhook"));
    if (!ch) {
      await pool.query(
        "insert into notification_log (org_id, ts, monitor_id, channel, status, detail) values ($1,$2,$3,$4,'failed','No channel with this name')",
        [orgId, now, monitorId, "@" + h],
      );
      continue;
    }
    const body = ch.kind === "slack" ? { text: `*${title}*\n${clean}` } : { ...payload, title, body: clean };
    const r = await deliver(ch, body);
    // A failed delivery is kept and retried with backoff (retryNotifications); the queue lives in Postgres so it
    // survives restarts.
    await pool.query(
      "insert into notification_log (org_id, ts, monitor_id, channel, status, detail, payload, attempts, next_attempt_at) values ($1,$2,$3,$4,$5,$6,$7,1,$8)",
      [orgId, now, monitorId, "@" + h, r.ok ? "sent" : "retrying", r.detail, body, r.ok ? null : Date.now() + RETRY_BACKOFF_MS[0]],
    );
  }
}

/** Delays before attempts 2..6 (10 s, 30 s, 1 min, 2 min, 5 min); after the 6th failed attempt the notification is marked failed. */
export const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
async function deliver(ch: any, body: unknown): Promise<{ ok: boolean; detail: string }> {
  try {
    const form = ch.config?.encode_as === "form";
    const data = form
      ? new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString()
      : JSON.stringify(body);
    const r = await postWebhook(
      ch.config.url,
      { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...(ch.config.headers ?? {}) },
      data,
    );
    return { ok: r.status >= 200 && r.status < 300, detail: `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

/** Resend notifications whose delivery failed. Rows are leased (next_attempt_at pushed 60 s ahead under SKIP LOCKED)
 *  so overlapping runs or several server processes never send the same retry twice. */
export async function retryNotifications(): Promise<number> {
  const now = Date.now();
  const rows = (
    await pool.query(
      `update notification_log set next_attempt_at = $2 where id in (
       select id from notification_log where status = 'retrying' and next_attempt_at <= $1 order by next_attempt_at limit 50 for update skip locked)
     returning *`,
      [now, now + 60_000],
    )
  ).rows;
  // Retries run in parallel, so one slow destination does not hold up the rest of the batch.
  await Promise.all(rows.map((n) => retryOne(n)));
  return rows.length;
}

async function retryOne(n: any) {
  {
    const attempts = Number(n.attempts) + 1;
    const name = String(n.channel).replace(/^@(webhook|slack)-/, "");
    const ch = (await pool.query("select * from notification_channels where org_id=$1 and name=$2", [n.org_id, name])).rows[0];
    if (!ch) {
      await pool.query("update notification_log set status='failed', detail=$2, next_attempt_at=null where id=$1", [
        n.id,
        "Channel was deleted before delivery",
      ]);
      return;
    }
    const r = await deliver(ch, n.payload);
    if (r.ok)
      await pool.query("update notification_log set status='sent', attempts=$2, detail=$3, next_attempt_at=null where id=$1", [
        n.id,
        attempts,
        `${r.detail} after ${attempts} attempts`,
      ]);
    else if (attempts > RETRY_BACKOFF_MS.length)
      await pool.query("update notification_log set status='failed', attempts=$2, detail=$3, next_attempt_at=null where id=$1", [
        n.id,
        attempts,
        `${r.detail}; gave up after ${attempts} attempts`,
      ]);
    else
      await pool.query("update notification_log set attempts=$2, detail=$3, next_attempt_at=$4 where id=$1", [
        n.id,
        attempts,
        `${r.detail} (attempt ${attempts}, retrying)`,
        Date.now() + RETRY_BACKOFF_MS[attempts - 1],
      ]);
  }
}

const inFlight = new Map<number, Promise<void>>();
/** Evaluate one monitor; concurrent calls for the same monitor are serialized so a transition is recorded once. */
export function evaluateMonitor(id: number): Promise<void> {
  const prev = inFlight.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => evaluateMonitorNow(id));
  inFlight.set(id, next);
  next
    .finally(() => {
      if (inFlight.get(id) === next) inFlight.delete(id);
    })
    .catch(() => {});
  return next;
}

async function evaluateMonitorNow(id: number) {
  const mon = (await pool.query("select * from monitors where id=$1", [id])).rows[0];
  if (!mon) return;
  let parsed: Parsed;
  try {
    parsed = parseMonitorQuery(mon.type, mon.query);
  } catch (e) {
    logger.warn({ id, err: String(e) }, "invalid monitor");
    return;
  }
  const delaySec = Math.min(86_400, Math.max(0, Number(mon.options?.evaluation_delay) || 0));
  const values = await evaluateValues(mon.org_id, parsed, !!mon.options?.notify_no_data, delaySec);
  const prevStates: Record<string, { state: State; value: number | null; tags: string[]; since: number }> = mon.group_states ?? {};
  const next: typeof prevStates = {};
  const now = Date.now();
  const muted = mon.muted_until && Number(mon.muted_until) * 1000 > now;
  const transitions: { key: string; from: State; to: State; value: number | null; tags: string[] }[] = [];
  // Missing data only counts once no point has arrived for no_data_timeframe minutes (default: twice the evaluation
  // window), measured from the group's last data point, or from the monitor's creation if it never had data. A monitor
  // created a moment ago, or a single late point, must not page anyone with "No Data".
  const noDataMs = (Number(mon.options?.no_data_timeframe) || Math.max(2, (2 * parsed.window) / 60)) * 60_000;
  const createdMs = mon.created_at ? new Date(mon.created_at).getTime() : now;
  const missingLongEnough = (key: string) => now - (((prevStates[key] as any)?.seen as number | undefined) ?? createdMs) >= noDataMs;
  for (const [key, v] of values) {
    const prev = prevStates[key]?.state;
    const hasValue = v.value !== null && !Number.isNaN(v.value);
    const st: State = hasValue
      ? stateFor(v.value, parsed.op, mon.options, parsed.threshold, prev)
      : mon.options?.notify_no_data && missingLongEnough(key)
        ? "No Data"
        : (prev ?? "OK");
    next[key] = { state: st, value: v.value, tags: v.tags, since: prev === st ? prevStates[key].since : now };
    // the no-data timer runs from the newest data point, not from this evaluation
    (next[key] as any).seen = hasValue ? (v.lastMs ?? now) : (prevStates[key] as any)?.seen;
    if ((prev ?? "OK") !== st && !(prev === undefined && st === "OK")) transitions.push({ key, from: prev ?? "OK", to: st, value: v.value, tags: v.tags });
  }
  // Groups that disappeared from the result. With notify_no_data every group is kept until the no-data check resolves
  // it (OK groups included, so a host that stops reporting does alert); without it, an alerting group recovers.
  for (const [key, ps] of Object.entries(prevStates)) {
    if (next[key]) continue;
    if (mon.options?.notify_no_data) {
      const st: State = missingLongEnough(key) ? "No Data" : ps.state;
      next[key] = { ...ps, state: st, value: null, since: ps.state === st ? ps.since : now };
      if (ps.state !== st) transitions.push({ key, from: ps.state, to: st, value: null, tags: ps.tags });
    } else if (ps.state !== "OK" && now - ps.since < 3600_000) {
      next[key] = { ...ps, state: "OK", value: null, since: now };
      transitions.push({ key, from: ps.state, to: "OK", value: null, tags: ps.tags });
    }
  }
  const overall = Object.values(next).reduce<State>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), "OK") as State;
  let lastTriggered = mon.last_triggered_at;
  // renotify while still alerting
  const renotify = Number(mon.options?.renotify_interval ?? 0);
  for (const [key, s] of Object.entries(next)) {
    if (renotify > 0 && (s.state === "Alert" || s.state === "Warn") && prevStates[key]?.state === s.state) {
      const lastN = (prevStates[key] as any).notified ?? prevStates[key].since;
      if (now - lastN >= renotify * 60_000) {
        transitions.push({ key, from: s.state, to: s.state, value: s.value, tags: s.tags });
        (s as any).notified = now;
      } else (s as any).notified = lastN;
    }
  }
  for (const t of transitions) if (t.to === "Alert" || t.to === "Warn") lastTriggered = now;
  // Compare-and-set: when two processes evaluate the same monitor at once, only the one whose state write lands sends
  // the events and notifications, so a transition is announced once.
  const saved = await pool.query(
    "update monitors set overall_state=$2, group_states=$3, last_evaluated_at=$4, last_triggered_at=$5 where id=$1 and last_evaluated_at is not distinct from $6::bigint returning id",
    [id, overall, next, now, lastTriggered, mon.last_evaluated_at ?? null],
  );
  if (!saved.rowCount) return;
  for (const t of transitions) {
    const label = t.to === "OK" ? "Recovered" : t.to === "No Data" ? "No Data" : t.to === "Warn" ? "Warn" : "Triggered";
    const ctx = {
      state: t.to,
      prev: t.from,
      value: t.value,
      threshold: mon.options?.thresholds?.critical ?? parsed.threshold,
      warn: mon.options?.thresholds?.warning,
      tags: t.tags,
      name: mon.name,
      id: mon.id,
    };
    const title = `[${label}${t.tags.length ? " on " + t.tags.join(",") : ""}] ${render(mon.name, ctx)}`;
    const text = render(mon.message ?? "", ctx);
    const handles = messageHandles(render(mon.message ?? "", ctx, true));
    await pool.query(
      "insert into events (org_id, ts, title, text, alert_type, source, monitor_id, group_key, tags) values ($1,$2,$3,$4,$5,'monitor',$6,$7,$8)",
      [
        mon.org_id,
        now,
        title,
        `${text}\n\nValue: ${ctx.value ?? "N/A"} (threshold ${parsed.op} ${ctx.threshold})`,
        t.to === "Alert" ? "error" : t.to === "Warn" ? "warning" : t.to === "OK" ? "success" : "info",
        mon.id,
        t.key,
        [...t.tags, `monitor:${mon.id}`],
      ],
    );
    if (!muted) {
      await notify(
        mon.org_id,
        mon.id,
        text,
        title,
        {
          monitor_id: mon.id,
          monitor_name: mon.name,
          transition: `${t.from} -> ${t.to}`,
          state: t.to,
          value: t.value,
          threshold: ctx.threshold,
          group: t.key,
          tags: t.tags,
          query: mon.query,
          date: new Date(now).toISOString(),
        },
        handles,
      );
    }
  }
}

// Each organization's monitors run in their own chain, so a slow notification destination in one organization never
// delays monitoring for the others. A chain still running from the previous tick is not started again.
const orgRuns = new Map<number, Promise<void>>();
export function startMonitorLoop() {
  const tick = async () => {
    try {
      const rows = (await pool.query("select id, org_id from monitors order by org_id, id")).rows;
      const byOrg = new Map<number, number[]>();
      for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.id]);
      for (const [orgId, ids] of byOrg) {
        if (orgRuns.has(orgId)) continue;
        const run = (async () => {
          for (const id of ids) await evaluateMonitor(id).catch((e) => logger.warn({ err: String(e), id }, "monitor eval failed"));
        })().finally(() => orgRuns.delete(orgId));
        orgRuns.set(orgId, run);
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "monitor loop failed");
    }
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
  let retrying = false;
  setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try {
      await retryNotifications();
    } catch (e) {
      logger.warn({ err: String(e) }, "notification retry failed");
    } finally {
      retrying = false;
    }
  }, 10_000);
}

/** Drop telemetry older than the retention window so the database stays small. */
export function startRetentionLoop() {
  const days = Number(process.env.DATACAT_RETENTION_DAYS ?? process.env.RETENTION_DAYS ?? 15);
  if (!Number.isFinite(days) || days <= 0) throw new Error("DATACAT_RETENTION_DAYS must be a positive number");
  // ClickHouse enforces retention itself with table TTLs (lib/ch.ts), dropping whole expired partitions.
  if (useClickHouse) return;
  const run = async () => {
    const cutoff = Date.now() - days * 86400_000;
    try {
      await pool.query("delete from metric_points where ts < $1", [Math.floor(cutoff / 1000)]);
      await pool.query("delete from logs where ts < $1", [cutoff]);
      await pool.query("delete from spans where start_ms < $1", [cutoff]);
    } catch (e) {
      logger.warn({ err: String(e) }, "retention failed");
    }
  };
  setInterval(run, 3600_000);
}
