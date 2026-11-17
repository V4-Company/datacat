import { Router, type Request, type Response } from "express";
import { h, HttpError, rangeOf, parseTime, pageLimit, encodeCursor, decodeCursor, nextLink } from "../lib/http";
import crypto from "crypto";
import { pool, db, apiKeysTable, invitesTable, usersTable, orgsTable } from "@workspace/db";
import { getOrigin } from "../lib/config";
import { and, eq } from "drizzle-orm";
import { requireOrg, requireAdmin, requireAdminOrKeys } from "../middlewares/authMiddleware";
import { checkWebhookUrl, checkWebhookHeaders } from "../lib/safeHttp";
import { newKey, invalidateKey } from "../lib/org";
import { evaluateMonitor, validateMonitorQuery } from "../jobs/monitors";
import { startSampleData, stopSampleData, sampleRunning } from "../jobs/sample";
import { intakeStats } from "../lib/intakeStats";
import { logger } from "../lib/logger";

const router: Router = Router();
router.use(
  ["/v1/dashboard", "/v1/monitor", "/v1/events", "/ui/org", "/ui/events", "/ui/channels", "/ui/monitors", "/v1/integration/webhooks", "/v1/intake"],
  requireOrg,
);

function dashId() {
  const a = "abcdefghijkmnopqrstuvwxyz23456789";
  const pick = () => Array.from({ length: 3 }, () => a[crypto.randomInt(a.length)]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}
/** Numeric route ids: anything else is a 404 (no such object), not a database error. */
function intId(v: unknown, what: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(n) || n > 2147483647) throw new HttpError(404, `${what[0].toUpperCase()}${what.slice(1)} not found`);
  return n;
}
const monitorId = (v: unknown) => intId(v, "monitor");
const userName = (req: Request) => [req.authUser?.firstName, req.authUser?.lastName].filter(Boolean).join(" ") || req.authUser?.email || "API";

/**
 * LIMIT/OFFSET for list routes that accept paging (dashboards: count/start; monitors: page_size/page, page counted from
 * 0). Without the parameters the full list is returned, as before.
 */
function listPage(q: any, sizeKey: string, posKey: string): string {
  if (q?.[sizeKey] === undefined && q?.[posKey] === undefined) return "";
  const size = pageLimit(q[sizeKey], 100, 1000);
  const pos = Math.max(0, Math.floor(Number(q[posKey] ?? 0)) || 0);
  return `limit ${size} offset ${posKey === "page" ? pos * size : pos}`;
}
function dashOut(r: any) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    layout_type: r.layout_type,
    widgets: r.definition?.widgets ?? [],
    template_variables: r.definition?.template_variables ?? [],
    reflow_type: r.definition?.reflow_type,
    author_name: r.author_name,
    author_handle: r.author_name,
    created_at: r.created_at,
    modified_at: r.modified_at,
    url: `/dashboard/${r.id}`,
  };
}

// ---------- Dashboards (v1 API) ----------
router.get(
  "/v1/dashboard",
  h(async (req, res) => {
    const rows = (
      await pool.query(
        `select id, title, description, layout_type, author_name, created_at, modified_at, jsonb_array_length(coalesce(definition->'widgets','[]'::jsonb)) as n from dashboards where org_id=$1 order by modified_at desc, id ${listPage(req.query, "count", "start")}`,
        [req.orgId],
      )
    ).rows;
    res.json({
      dashboards: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        layout_type: r.layout_type,
        author_handle: r.author_name,
        author_name: r.author_name,
        created_at: r.created_at,
        modified_at: r.modified_at,
        url: `/dashboard/${r.id}`,
        widget_count: r.n,
      })),
    });
  }),
);
router.get(
  "/v1/dashboard/:id",
  h(async (req, res) => {
    const r = (await pool.query("select * from dashboards where org_id=$1 and id=$2", [req.orgId, req.params.id])).rows[0];
    if (!r) {
      res.status(404).json({ errors: ["Dashboard not found"] });
      return;
    }
    res.json(dashOut(r));
  }),
);
/** Validates the parts of a dashboard the UI relies on: widgets and template_variables must be lists of objects. */
function checkDashboard(b: any) {
  if (b.title !== undefined && (typeof b.title !== "string" || !b.title.trim())) throw new HttpError(400, "title must be a non-empty string");
  for (const k of ["widgets", "template_variables"]) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) throw new HttpError(400, `${k} must be a list`);
    if (v.some((x: unknown) => !x || typeof x !== "object" || Array.isArray(x))) throw new HttpError(400, `each entry of ${k} must be an object`);
  }
  for (const t of b.template_variables ?? []) if (typeof t.name !== "string" || !t.name) throw new HttpError(400, "each template variable needs a name");
  for (const w of b.widgets ?? []) if (!w.definition || typeof w.definition !== "object") throw new HttpError(400, "each widget needs a definition object");
}
function assignWidgetIds(ws: any[]) {
  for (const w of ws ?? []) {
    if (!w.id) w.id = crypto.randomInt(1, 2 ** 47);
    if (w.definition?.widgets) assignWidgetIds(w.definition.widgets);
  }
  return ws;
}
router.post(
  "/v1/dashboard",
  h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title) throw new Error("title is required");
    checkDashboard(b);
    const id = dashId();
    const def = { widgets: assignWidgetIds(b.widgets ?? []), template_variables: b.template_variables ?? [], reflow_type: b.reflow_type };
    const r = (
      await pool.query(
        "insert into dashboards (id, org_id, title, description, layout_type, definition, author_id, author_name) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
        [id, req.orgId, b.title, b.description ?? null, b.layout_type ?? "ordered", def, req.authUser?.id ?? null, userName(req)],
      )
    ).rows[0];
    res.json(dashOut(r));
  }),
);
router.put(
  "/v1/dashboard/:id",
  h(async (req, res) => {
    const b = req.body ?? {};
    checkDashboard(b);
    // read-merge-write under a row lock, so two concurrent partial updates both keep their changes
    const c = await pool.connect();
    let r: any;
    try {
      await c.query("BEGIN");
      const cur = (await c.query("select definition, description from dashboards where org_id=$1 and id=$2 for update", [req.orgId, req.params.id])).rows[0];
      const prev = cur?.definition ?? {};
      const def = {
        widgets: b.widgets !== undefined ? assignWidgetIds(b.widgets ?? []) : (prev.widgets ?? []),
        template_variables: b.template_variables ?? prev.template_variables ?? [],
        reflow_type: b.reflow_type ?? prev.reflow_type,
      };
      r = (
        await c.query(
          "update dashboards set title=coalesce($3,title), description=$4, layout_type=coalesce($5,layout_type), definition=$6, modified_at=now() where org_id=$1 and id=$2 returning *",
          [req.orgId, req.params.id, b.title ?? null, b.description !== undefined ? b.description : (cur?.description ?? null), b.layout_type ?? null, def],
        )
      ).rows[0];
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    if (!r) {
      res.status(404).json({ errors: ["Dashboard not found"] });
      return;
    }
    res.json(dashOut(r));
  }),
);
router.delete(
  "/v1/dashboard/:id",
  h(async (req, res) => {
    const r = await pool.query("delete from dashboards where org_id=$1 and id=$2", [req.orgId, req.params.id]);
    if (!r.rowCount) throw new HttpError(404, "Dashboard not found");
    res.json({ deleted_dashboard_id: req.params.id });
  }),
);

// ---------- Monitors (v1 API) ----------
function monOut(r: any) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    query: r.query,
    message: r.message,
    tags: r.tags,
    priority: r.priority,
    options: r.options,
    overall_state: r.overall_state,
    group_states: r.group_states,
    muted_until: r.muted_until ? Number(r.muted_until) : null,
    last_triggered_at: r.last_triggered_at ? Number(r.last_triggered_at) : null,
    last_evaluated_at: r.last_evaluated_at ? Number(r.last_evaluated_at) : null,
    creator: { name: r.creator_name },
    created: r.created_at,
    modified: r.modified_at,
  };
}
router.get(
  "/v1/monitor",
  h(async (req, res) => {
    const rows = (await pool.query(`select * from monitors where org_id=$1 order by name, id ${listPage(req.query, "page_size", "page")}`, [req.orgId])).rows;
    res.json(rows.map(monOut));
  }),
);
router.get(
  "/v1/monitor/:id",
  h(async (req, res) => {
    const r = (await pool.query("select * from monitors where org_id=$1 and id=$2", [req.orgId, monitorId(req.params.id)])).rows[0];
    if (!r) {
      res.status(404).json({ errors: ["Monitor not found"] });
      return;
    }
    res.json(monOut(r));
  }),
);
router.post(
  "/v1/monitor/validate",
  h(async (req, res) => {
    validateMonitorQuery(req.body?.type ?? "metric alert", req.body?.query ?? "");
    res.json({});
  }),
);
router.post(
  "/v1/monitor",
  h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.query) throw new Error("name and query are required");
    const type = b.type ?? "metric alert";
    validateMonitorQuery(type, b.query);
    const r = (
      await pool.query(
        "insert into monitors (org_id, name, type, query, message, tags, priority, options, creator_id, creator_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",
        [req.orgId, b.name, type, b.query, b.message ?? "", b.tags ?? [], b.priority ?? null, b.options ?? {}, req.authUser?.id ?? null, userName(req)],
      )
    ).rows[0];
    evaluateMonitor(r.id).catch((e) => logger.warn({ err: String(e), id: r.id }, "monitor evaluation after create failed"));
    res.json(monOut(r));
  }),
);
router.put(
  "/v1/monitor/:id",
  h(async (req, res) => {
    const b = req.body ?? {};
    const cur = (await pool.query("select type, query, priority from monitors where org_id=$1 and id=$2", [req.orgId, monitorId(req.params.id)])).rows[0];
    if (!cur) {
      res.status(404).json({ errors: ["Monitor not found"] });
      return;
    }
    // the monitor as it will be saved must be valid, whichever fields the request changes
    if (b.query !== undefined && !String(b.query ?? "").trim()) throw new HttpError(400, "query cannot be empty");
    if (b.name !== undefined && !String(b.name ?? "").trim()) throw new HttpError(400, "name cannot be empty");
    validateMonitorQuery(b.type ?? cur.type, b.query ?? cur.query);
    const r = (
      await pool.query(
        `update monitors set name=coalesce($3,name), type=coalesce($4,type), query=coalesce($5,query), message=coalesce($6,message), tags=coalesce($7,tags),
     priority=$8, options=coalesce($9,options), modified_at=now() where org_id=$1 and id=$2 returning *`,
        [
          req.orgId,
          monitorId(req.params.id),
          b.name ?? null,
          b.type ?? null,
          b.query ?? null,
          b.message ?? null,
          b.tags ?? null,
          b.priority !== undefined ? b.priority : cur.priority,
          b.options ?? null,
        ],
      )
    ).rows[0];
    if (!r) {
      res.status(404).json({ errors: ["Monitor not found"] });
      return;
    }
    evaluateMonitor(r.id).catch((e) => logger.warn({ err: String(e), id: r.id }, "monitor evaluation after update failed"));
    res.json(monOut(r));
  }),
);
router.delete(
  "/v1/monitor/:id",
  h(async (req, res) => {
    const r = await pool.query("delete from monitors where org_id=$1 and id=$2", [req.orgId, monitorId(req.params.id)]);
    if (!r.rowCount) throw new HttpError(404, "Monitor not found");
    res.json({ deleted_monitor_id: Number(req.params.id) });
  }),
);
router.post(
  "/v1/monitor/:id/mute",
  h(async (req, res) => {
    const end = req.body?.end ? Number(req.body.end) : 4102444800;
    const r = (await pool.query("update monitors set muted_until=$3 where org_id=$1 and id=$2 returning *", [req.orgId, monitorId(req.params.id), end]))
      .rows[0];
    if (!r) throw new HttpError(404, "Monitor not found");
    res.json(monOut(r));
  }),
);
router.post(
  "/v1/monitor/:id/unmute",
  h(async (req, res) => {
    const r = (await pool.query("update monitors set muted_until=null where org_id=$1 and id=$2 returning *", [req.orgId, monitorId(req.params.id)])).rows[0];
    res.json(monOut(r));
  }),
);
router.post(
  "/ui/monitors/:id/evaluate",
  h(async (req, res) => {
    const own = (await pool.query("select id from monitors where org_id=$1 and id=$2", [req.orgId, monitorId(req.params.id)])).rows[0];
    if (!own) {
      res.status(404).json({ errors: ["Monitor not found"] });
      return;
    }
    await evaluateMonitor(own.id);
    const r = (await pool.query("select * from monitors where id=$1", [own.id])).rows[0];
    res.json(monOut(r));
  }),
);
router.get(
  "/ui/monitors/:id/history",
  h(async (req, res) => {
    const events = (
      await pool.query("select * from events where org_id=$1 and monitor_id=$2 order by ts desc limit 200", [req.orgId, monitorId(req.params.id)])
    ).rows;
    const notifs = (
      await pool.query("select * from notification_log where org_id=$1 and monitor_id=$2 order by ts desc limit 100", [req.orgId, monitorId(req.params.id)])
    ).rows;
    res.json({
      events: events.map((e) => ({ ...e, ts: Number(e.ts), id: String(e.id) })),
      notifications: notifs.map((n) => ({ ...n, ts: Number(n.ts), id: String(n.id) })),
    });
  }),
);

// ---------- Events ----------
router.get(
  ["/v1/events", "/ui/events"],
  h(async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const start = Number(req.query.start ?? now - 86400),
      end = Number(req.query.end ?? now);
    const q = String(req.query.q ?? "");
    const rows = (
      await pool.query(
        "select * from events where org_id=$1 and ts >= $2 and ts <= $3 and ($4 = '' or title ilike $5 or text ilike $5) order by ts desc limit 500",
        [req.orgId, start * 1000, end * 1000, q, `%${q}%`],
      )
    ).rows;
    res.json({
      events: rows.map((e) => ({
        id: String(e.id),
        date_happened: Math.floor(Number(e.ts) / 1000),
        ts: Number(e.ts),
        title: e.title,
        text: e.text,
        alert_type: e.alert_type,
        source: e.source,
        monitor_id: e.monitor_id,
        tags: e.tags,
      })),
    });
  }),
);
router.post(
  "/v1/events",
  h(async (req, res) => {
    const e = req.body ?? {};
    const r = (
      await pool.query("insert into events (org_id, ts, title, text, alert_type, source, tags) values ($1,$2,$3,$4,$5,'api',$6) returning id", [
        req.orgId,
        (Number(e.date_happened) || Math.floor(Date.now() / 1000)) * 1000,
        e.title ?? "event",
        e.text ?? "",
        e.alert_type ?? "info",
        e.tags ?? [],
      ])
    ).rows[0];
    res.json({ status: "ok", event: { id: String(r.id), title: e.title } });
  }),
);

// ---------- Org settings ----------
router.get(
  "/ui/org",
  h(async (req, res) => {
    const [org] = await db.select().from(orgsTable).where(eq(orgsTable.id, req.orgId!));
    const keys = (await db.select().from(apiKeysTable).where(eq(apiKeysTable.orgId, req.orgId!))).filter((k) => !k.revoked);
    const members = await db.select().from(usersTable).where(eq(usersTable.orgId, req.orgId!));
    const invites = await db.select().from(invitesTable).where(eq(invitesTable.orgId, req.orgId!));
    res.json({
      org,
      me: req.authUser,
      public_url: getOrigin(req),
      // Only admins see API keys in full; application keys are shown once, when created.
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        kind: k.kind,
        key: req.authUser?.role === "admin" && k.kind === "api" ? k.key : undefined,
        hint: `${k.key.slice(0, 4)}…${k.key.slice(-4)}`,
        created_at: k.createdAt,
        last_used_at: k.lastUsedAt,
      })),
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        name: [m.firstName, m.lastName].filter(Boolean).join(" "),
        role: m.role,
        created_at: m.createdAt,
      })),
      invites: invites
        .filter((i) => !i.acceptedAt)
        .map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          created_at: i.createdAt,
          link: req.authUser?.role === "admin" && i.token ? `${getOrigin(req)}/invite/${i.token}` : null,
        })),
    });
  }),
);
router.post(
  "/ui/org/keys",
  requireAdmin,
  h(async (req, res) => {
    const kind = req.body?.kind === "app" ? "app" : "api";
    const [k] = await db
      .insert(apiKeysTable)
      .values({
        orgId: req.orgId!,
        name: req.body?.name || (kind === "app" ? "Application key" : "API key"),
        key: newKey(kind === "app" ? 20 : 16),
        kind,
        createdBy: req.authUser?.id ?? null,
      })
      .returning();
    res.json({ id: k.id, name: k.name, kind: k.kind, key: k.key });
  }),
);
router.delete(
  "/ui/org/keys/:id",
  requireAdmin,
  h(async (req, res) => {
    const [k] = await db
      .update(apiKeysTable)
      .set({ revoked: true })
      .where(and(eq(apiKeysTable.id, intId(req.params.id, "key")), eq(apiKeysTable.orgId, req.orgId!)))
      .returning();
    if (!k) throw new HttpError(404, "Key not found");
    invalidateKey(k.key);
    res.json({ ok: true });
  }),
);
router.post(
  "/ui/org/invites",
  requireAdmin,
  h(async (req, res) => {
    const email = String(req.body?.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Enter a valid email");
    const [inv] = await db
      .insert(invitesTable)
      .values({ email, orgId: req.orgId!, role: req.body?.role === "admin" ? "admin" : "member", invitedBy: req.authUser?.id ?? null, token: newKey(24) })
      .returning();
    res.json({ id: inv.id, email: inv.email, link: `${getOrigin(req)}/invite/${inv.token}` });
  }),
);
router.delete(
  "/ui/org/invites/:id",
  requireAdmin,
  h(async (req, res) => {
    const gone = await db
      .delete(invitesTable)
      .where(and(eq(invitesTable.id, intId(req.params.id, "invite")), eq(invitesTable.orgId, req.orgId!)))
      .returning();
    if (!gone.length) throw new HttpError(404, "Invite not found");
    res.json({ ok: true });
  }),
);
router.patch(
  "/ui/org",
  requireAdmin,
  h(async (req, res) => {
    if (req.body?.name)
      await db
        .update(orgsTable)
        .set({ name: String(req.body.name) })
        .where(eq(orgsTable.id, req.orgId!));
    res.json({ ok: true });
  }),
);

// ---------- Sample data ----------
router.get(
  "/ui/org/sample-data",
  h(async (req, res) => res.json({ running: sampleRunning(req.orgId!) })),
);
router.post(
  "/ui/org/sample-data",
  h(async (req, res) => {
    if (req.body?.stop) {
      stopSampleData(req.orgId!);
      res.json({ running: false });
      return;
    }
    const r = await startSampleData(req.orgId!, Math.min(240, Number(req.body?.minutes ?? 60)));
    res.json({ running: true, ...r });
  }),
);

// ---------- Notification channels (webhooks / Slack incoming webhooks) ----------
router.get(
  "/ui/channels",
  h(async (req, res) => {
    const rows = (await pool.query("select * from notification_channels where org_id=$1 order by name", [req.orgId])).rows;
    // webhook URLs and headers can carry credentials: members see only the destination host
    const admin = req.authUser?.role === "admin";
    res.json({ channels: admin ? rows : rows.map((r: any) => ({ ...r, config: { url: redactUrl(r.config?.url) } })) });
  }),
);
router.post(
  "/ui/channels",
  requireAdmin,
  h(async (req, res) => {
    const { kind = "webhook", name, url, headers, payload } = req.body ?? {};
    if (!/^[A-Za-z0-9_\-]{1,100}$/.test(name ?? "")) throw new HttpError(400, "Name may contain letters, numbers, - and _ only");
    checkWebhookUrl(String(url ?? ""));
    const r = (
      await pool.query("insert into notification_channels (org_id, kind, name, config) values ($1,$2,$3,$4) returning *", [
        req.orgId,
        kind === "slack" ? "slack" : "webhook",
        name,
        { url, headers: checkWebhookHeaders(headers), payload: payload ?? null },
      ])
    ).rows[0];
    res.json(r);
  }),
);
router.delete(
  "/ui/channels/:id",
  requireAdmin,
  h(async (req, res) => {
    const r = await pool.query("delete from notification_channels where org_id=$1 and id=$2", [req.orgId, intId(req.params.id, "channel")]);
    if (!r.rowCount) throw new HttpError(404, "Channel not found");
    res.json({ ok: true });
  }),
);

// ---------- Webhooks integration (/api/v1/integration/webhooks/configuration/webhooks) ----------
// The same channels as above: a monitor message mentioning @webhook-<name> posts to it.
function redactUrl(u: unknown) {
  try {
    const x = new URL(String(u));
    return `${x.protocol}//${x.host}/…`;
  } catch {
    return "";
  }
}
function webhookOut(r: any) {
  const c = r.config ?? {};
  return {
    name: r.name,
    url: c.url,
    encode_as: c.encode_as ?? "json",
    custom_headers: c.headers ? JSON.stringify(c.headers) : null,
    payload: c.payload ?? null,
  };
}
function webhookConfig(b: any, prev: any = {}) {
  const url = b.url ?? prev.url;
  checkWebhookUrl(String(url ?? ""));
  let headers = prev.headers ?? null;
  if (b.custom_headers !== undefined) {
    if (b.custom_headers === null || b.custom_headers === "") headers = null;
    else {
      try {
        headers = typeof b.custom_headers === "string" ? JSON.parse(b.custom_headers) : b.custom_headers;
      } catch {
        throw new HttpError(400, "custom_headers must be a JSON object");
      }
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new HttpError(400, "custom_headers must be a JSON object");
      checkWebhookHeaders(headers);
    }
  }
  const encode_as = b.encode_as ?? prev.encode_as ?? "json";
  if (encode_as !== "json" && encode_as !== "form") throw new HttpError(400, "encode_as must be json or form");
  return { url, headers, payload: b.payload !== undefined ? b.payload : (prev.payload ?? null), encode_as };
}
const WEBHOOKS = "/v1/integration/webhooks/configuration/webhooks";
const webhookName = (v: unknown) => {
  const n = String(v ?? "");
  if (!/^[A-Za-z0-9_\-]{1,100}$/.test(n)) throw new HttpError(400, "name may contain letters, numbers, - and _ only");
  return n;
};
router.get(
  WEBHOOKS,
  requireAdminOrKeys,
  h(async (req, res) => {
    const rows = (await pool.query("select * from notification_channels where org_id=$1 and kind='webhook' order by name", [req.orgId])).rows;
    res.json(rows.map(webhookOut));
  }),
);
router.get(
  `${WEBHOOKS}/:name`,
  requireAdminOrKeys,
  h(async (req, res) => {
    const r = (await pool.query("select * from notification_channels where org_id=$1 and kind='webhook' and name=$2", [req.orgId, String(req.params.name)]))
      .rows[0];
    if (!r) throw new HttpError(404, "Webhook not found");
    res.json(webhookOut(r));
  }),
);
router.post(
  WEBHOOKS,
  requireAdminOrKeys,
  h(async (req, res) => {
    const name = webhookName(req.body?.name);
    const exists = (await pool.query("select 1 from notification_channels where org_id=$1 and name=$2", [req.orgId, name])).rows.length;
    if (exists) throw new HttpError(409, "A webhook with this name already exists");
    const r = (
      await pool.query("insert into notification_channels (org_id, kind, name, config) values ($1,'webhook',$2,$3) returning *", [
        req.orgId,
        name,
        webhookConfig(req.body ?? {}),
      ])
    ).rows[0];
    res.status(201).json(webhookOut(r));
  }),
);
router.put(
  `${WEBHOOKS}/:name`,
  requireAdminOrKeys,
  h(async (req, res) => {
    const cur = (await pool.query("select * from notification_channels where org_id=$1 and kind='webhook' and name=$2", [req.orgId, String(req.params.name)]))
      .rows[0];
    if (!cur) throw new HttpError(404, "Webhook not found");
    const name = req.body?.name !== undefined ? webhookName(req.body.name) : cur.name;
    const r = (
      await pool.query("update notification_channels set name=$3, config=$4 where org_id=$1 and id=$2 returning *", [
        req.orgId,
        cur.id,
        name,
        webhookConfig(req.body ?? {}, cur.config ?? {}),
      ])
    ).rows[0];
    res.json(webhookOut(r));
  }),
);
router.delete(
  `${WEBHOOKS}/:name`,
  requireAdminOrKeys,
  h(async (req, res) => {
    const r = await pool.query("delete from notification_channels where org_id=$1 and kind='webhook' and name=$2", [req.orgId, String(req.params.name)]);
    if (!r.rowCount) throw new HttpError(404, "Webhook not found");
    res.status(204).end();
  }),
);

// ---------- Intake health: items stored and dropped per intake path since the server started ----------
router.get(
  "/v1/intake/stats",
  h(async (req, res) => {
    res.json({ since_process_start: true, paths: intakeStats(req.orgId!) });
  }),
);

export default router;
