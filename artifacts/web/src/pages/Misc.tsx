import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Search, Plus, Trash2, Copy, Eye, EyeOff, LayoutDashboard, Server, Bell, ScrollText, Activity, LineChart, LogIn } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader, ICONS } from "@/components/Layout";
import { TimePicker } from "@/components/TimePicker";
import { StatusBadge, Empty } from "@/components/Panels";
import { CatMark } from "@/components/Logo";
import { useTime } from "@/lib/time";
import { useAuthUser } from "@/lib/auth";
import { fmtAgo, fmtTime, fmtNum, fmtDuration } from "@/lib/format";

export function Events() {
  const { from, to, tick } = useTime();
  const [q, setQ] = useState("");
  const ev = useQuery({
    queryKey: ["events", q, from, to, tick],
    queryFn: () => api<{ events: any[] }>(`/ui/events?start=${from}&end=${to}&q=${encodeURIComponent(q)}`),
  });
  const color: Record<string, string> = { error: "#d33b4c", warning: "#e8a317", success: "#2ca05a", info: "#5b7be0" };
  return (
    <div>
      <PageHeader title="Events" icon={ICONS.events}>
        <TimePicker />
      </PageHeader>
      <div className="p-6">
        <div className="relative mb-3 max-w-xl">
          <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
          <input className="input w-full pl-8" placeholder="Search events" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {(ev.data?.events.length ?? 0) === 0 && !ev.isLoading ? (
          <Empty title="No events in this time range">Monitor state changes, agent events and events sent to the API appear here.</Empty>
        ) : (
          <div className="card divide-y divide-line">
            {ev.data?.events.map((e) => (
              <div key={e.id} className="flex gap-3 px-4 py-2.5">
                <span className="w-1 rounded shrink-0" style={{ background: color[e.alert_type] ?? "#5b7be0" }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{e.title}</span>
                    {e.monitor_id && (
                      <Link className="text-xs text-primary" href={`/monitors/${e.monitor_id}`}>
                        monitor →
                      </Link>
                    )}
                    <span className="ml-auto text-xs text-ink-3 whitespace-nowrap">{fmtTime(e.ts, true)}</span>
                  </div>
                  {e.text && <div className="text-xs text-ink-2 whitespace-pre-wrap mt-0.5 line-clamp-3">{e.text}</div>}
                  <div className="flex gap-1 mt-1">
                    <span className="chip">source:{e.source}</span>
                    {e.tags.slice(0, 6).map((t: string) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KeyCell({ k }: { k: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 mono text-xs">
      {show ? k : `${k.slice(0, 4)}••••••••••••${k.slice(-4)}`}
      <button onClick={() => setShow(!show)} className="text-ink-3">
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button onClick={() => navigator.clipboard.writeText(k)} className="text-ink-3" title="Copy">
        <Copy size={13} />
      </button>
    </span>
  );
}

export function OrgSettings() {
  const qc = useQueryClient();
  const params = new URLSearchParams(useSearch());
  const [tab, setTab] = useState(params.get("tab") ?? "api-keys");
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<any>("/ui/org") });
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api<{ channels: any[] }>("/ui/channels") });
  const inv = (fn: (v: any) => Promise<any>) => ({
    mutationFn: fn as (v: any) => Promise<any>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org"] });
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  const [keyName, setKeyName] = useState("");
  const [created, setCreated] = useState<{ kind: string; key: string } | null>(null);
  const addKey = useMutation(
    inv((kind: string) =>
      api("/ui/org/keys", { body: { kind, name: keyName.trim() || (kind === "app" ? "Application key" : "API key") } }).then((r) => {
        setKeyName("");
        setCreated({ kind: r.kind, key: r.key });
        return r;
      }),
    ),
  );
  const delKey = useMutation(inv((id: number) => api(`/ui/org/keys/${id}`, { method: "DELETE" })));
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const invite = useMutation({
    ...inv((e: string) => api("/ui/org/invites", { body: { email: e } })),
    onError: (e: any) => setErr(e.message),
    onSettled: () => setEmail(""),
  });
  const delInvite = useMutation(inv((id: number) => api(`/ui/org/invites/${id}`, { method: "DELETE" })));
  const [ch, setCh] = useState({ kind: "webhook", name: "", url: "" });
  const addCh = useMutation({
    ...inv(() => api("/ui/channels", { body: ch })),
    onError: (e: any) => setErr(e.message),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setErr(null);
      setCh({ kind: "webhook", name: "", url: "" });
    },
  });
  const delCh = useMutation(inv((id: number) => api(`/ui/channels/${id}`, { method: "DELETE" })));
  const isAdmin = org.data?.me?.role === "admin";
  const tabs = [
    ["api-keys", "API Keys"],
    ["app-keys", "Application Keys"],
    ["users", "Users"],
    ["integrations", "Webhooks & Slack"],
    ["sample", "Sample Data"],
  ];
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Organization Settings" sub={org.data?.org?.name} />
      <div className="flex flex-1 min-h-0">
        <aside className="w-56 border-r border-line bg-panel py-3">
          {tabs.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`block w-full text-left px-4 py-1.5 text-[13px] ${tab === k ? "bg-brand-100 text-primary font-semibold" : "hover:bg-[#eef2fc]"}`}
            >
              {l}
            </button>
          ))}
        </aside>
        <div className="flex-1 overflow-auto p-6">
          {err && (
            <div className="card bg-red-50 border-alert/30 text-alert p-2 text-xs mb-3" onClick={() => setErr(null)}>
              {err}
            </div>
          )}
          {(tab === "api-keys" || tab === "app-keys") &&
            (() => {
              const kind = tab === "api-keys" ? "api" : "app";
              const keys = (org.data?.keys ?? []).filter((k: any) => k.kind === kind);
              return (
                <div>
                  <div className="flex items-center mb-3">
                    <p className="text-ink-2 max-w-2xl">
                      {kind === "api"
                        ? "API keys identify your organization when the agent, tracers and the HTTP intake send data to DataCat."
                        : "Application keys, used together with an API key, give scripts access to the DataCat API (dashboards, monitors, queries)."}
                    </p>
                    {isAdmin && (
                      <>
                        <input
                          className="input ml-auto w-56"
                          placeholder="Key name (optional)"
                          aria-label="New key name"
                          value={keyName}
                          onChange={(e) => setKeyName(e.target.value)}
                          maxLength={100}
                        />
                        <button className="btn-primary ml-2" onClick={() => addKey.mutate(kind)} data-testid={`new-${kind}-key`}>
                          <Plus size={14} /> New Key
                        </button>
                      </>
                    )}
                  </div>
                  {!isAdmin && <p className="text-xs text-ink-3 mb-3">Only admins can create, view or revoke keys.</p>}
                  {created?.kind === kind && (
                    <div className="card bg-panel p-3 mb-3 text-xs" data-testid="new-key-banner">
                      <div className="font-semibold mb-1">
                        {kind === "app" ? "Copy your new application key now. It will not be shown again." : "New API key created."}
                      </div>
                      <KeyCell k={created.key} />
                    </div>
                  )}
                  <table className="tbl card">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Key</th>
                        <th>Created</th>
                        <th>Last used</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k: any) => (
                        <tr key={k.id}>
                          <td>{k.name}</td>
                          <td>{k.key ? <KeyCell k={k.key} /> : <span className="mono text-xs text-ink-3">{k.hint}</span>}</td>
                          <td className="text-ink-2">{fmtAgo(new Date(k.created_at).getTime())}</td>
                          <td className="text-ink-2">{k.last_used_at ? fmtAgo(new Date(k.last_used_at).getTime()) : "never"}</td>
                          <td className="text-right">
                            {isAdmin && (
                              <button
                                className="text-ink-3 hover:text-alert"
                                aria-label="Revoke key"
                                onClick={() => confirm("Revoke this key? Anything using it will stop working.") && delKey.mutate(k.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          {tab === "users" && (
            <div className="space-y-6">
              {isAdmin && (
                <div className="card p-4">
                  <div className="section-title mb-1">Invite a tester</div>
                  <p className="text-xs text-ink-2 mb-2">
                    Share an invite link so a new member can create their password and join this organization. Links expire after 30 days and can only be used
                    once.
                  </p>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      invite.mutate(email);
                    }}
                  >
                    <input
                      className="input w-80"
                      type="email"
                      placeholder="name@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      data-testid="invite-email"
                    />
                    <button className="btn-primary" disabled={!email}>
                      Send invite
                    </button>
                  </form>
                </div>
              )}
              <div>
                <div className="section-title mb-2">Users ({org.data?.members?.length ?? 0})</div>
                <table className="tbl card">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(org.data?.members ?? []).map((m: any) => (
                      <tr key={m.id}>
                        <td>{m.name || "—"}</td>
                        <td>{m.email}</td>
                        <td className="capitalize">{m.role}</td>
                        <td className="text-ink-2">{fmtAgo(new Date(m.created_at).getTime())}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(org.data?.invites ?? []).length > 0 && (
                <div>
                  <div className="section-title mb-2">Pending invites</div>
                  <table className="tbl card">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Invite link</th>
                        <th>Sent</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.data.invites.map((i: any) => (
                        <tr key={i.id}>
                          <td>{i.email}</td>
                          <td>
                            {i.link && (
                              <button
                                className="text-primary text-xs inline-flex items-center gap-1"
                                onClick={() => navigator.clipboard.writeText(new URL(i.link, location.origin).href)}
                              >
                                <Copy size={12} /> Copy link
                              </button>
                            )}
                          </td>
                          <td className="text-ink-2">{fmtAgo(new Date(i.created_at).getTime())}</td>
                          <td className="text-right">
                            {isAdmin && (
                              <button className="text-ink-3 hover:text-alert" onClick={() => delInvite.mutate(i.id)}>
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === "sample" && (
            <div className="card p-5 max-w-2xl space-y-3">
              <div className="section-title">Sample data</div>
              <p className="text-ink-2">
                Simulates four hosts and three services (storefront, checkout-api, payments) sending metrics, logs and traces through the same intake the agent
                uses, for two hours, with 30 minutes of history. Useful for exploring DataCat before installing an agent. Sample data is tagged{" "}
                <span className="mono">env:sample</span>.
              </p>
              <SampleDataButton />
            </div>
          )}
          {tab === "integrations" && (
            <div className="space-y-4">
              <p className="text-ink-2 max-w-2xl">
                Monitors notify a channel when you mention it in the monitor message, e.g. <span className="mono">@webhook-oncall</span> or{" "}
                <span className="mono">@slack-alerts</span>. Slack channels take a Slack incoming-webhook URL.
              </p>
              {!isAdmin && <p className="text-xs text-ink-3">Only admins can add or remove channels.</p>}
              <form
                hidden={!isAdmin}
                className="card p-4 flex flex-wrap gap-2 items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  addCh.mutate(undefined);
                }}
              >
                <label className="text-xs">
                  <div className="label mb-1">Type</div>
                  <select className="input" value={ch.kind} onChange={(e) => setCh({ ...ch, kind: e.target.value })}>
                    <option value="webhook">Webhook</option>
                    <option value="slack">Slack</option>
                  </select>
                </label>
                <label className="text-xs">
                  <div className="label mb-1">Name</div>
                  <input
                    className="input w-48"
                    value={ch.name}
                    onChange={(e) => setCh({ ...ch, name: e.target.value })}
                    placeholder="oncall"
                    data-testid="channel-name"
                  />
                </label>
                <label className="text-xs flex-1">
                  <div className="label mb-1">URL</div>
                  <input
                    className="input w-full"
                    value={ch.url}
                    onChange={(e) => setCh({ ...ch, url: e.target.value })}
                    placeholder="https://hooks.example.com/..."
                    data-testid="channel-url"
                  />
                </label>
                <button className="btn-primary" disabled={!ch.name || !ch.url}>
                  Add channel
                </button>
              </form>
              <table className="tbl card">
                <thead>
                  <tr>
                    <th>Handle</th>
                    <th>Type</th>
                    <th>URL</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(channels.data?.channels ?? []).map((c) => (
                    <tr key={c.id}>
                      <td className="mono text-xs">
                        @{c.kind}-{c.name}
                      </td>
                      <td className="capitalize">{c.kind}</td>
                      <td className="mono text-xs truncate max-w-[420px]">{c.config.url}</td>
                      <td className="text-right">
                        {isAdmin && (
                          <button className="text-ink-3 hover:text-alert" aria-label="Delete channel" onClick={() => delCh.mutate(c.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentSetup() {
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<any>("/ui/org") });
  const key = (org.data?.keys ?? []).find((k: any) => k.kind === "api")?.key ?? "<YOUR_API_KEY>";
  const url = org.data?.public_url ?? location.origin;
  const [tab, setTab] = useState("linux");
  const yaml = `api_key: ${key}
url: ${url}
env: prod
host_metrics:
  enabled: true
apm:
  otlp: true
  datadog_compat: true
dogstatsd:
  enabled: true
logs:
  - path: /var/log/myapp/*.log
    service: myapp`;
  const docker = `docker run -d --name datacat-agent --network host \
  -v /proc:/hostfs/proc:ro -v /var/log:/var/log:ro \
  -v /etc/datacat:/etc/datacat \
  -e DATACAT_API_KEY=${key} \
  debian:stable-slim sh -c "apt-get update -qq && apt-get install -yqq curl >/dev/null && curl -fsSL ${url}/install.sh | sh && /opt/datacat-agent/bin/datacat-agent run -c /etc/datacat/datacat.yaml"`;
  const code = (s: string) => (
    <div className="relative">
      <pre className="mono text-xs bg-[#23222c] text-white rounded p-4 overflow-auto">{s}</pre>
      <button className="absolute top-2 right-2 text-white/60 hover:text-white" onClick={() => navigator.clipboard.writeText(s)}>
        <Copy size={14} />
      </button>
    </div>
  );
  return (
    <div>
      <PageHeader title="Install the DataCat Agent" />
      <div className="p-6 max-w-4xl space-y-5">
        <p className="text-ink-2">
          The DataCat Agent is built on the OpenTelemetry Collector. It reports host metrics, tails log files, relays traces, metrics and logs from your apps,
          and accepts compatible tracer and StatsD traffic for easy migration. See the{" "}
          <a className="text-primary" href="/docs/agent">
            agent guide
          </a>{" "}
          and the{" "}
          <a className="text-primary" href="/docs/nodejs">
            Node.js
          </a>{" "}
          /{" "}
          <a className="text-primary" href="/docs/python">
            Python
          </a>{" "}
          libraries.
        </p>
        <div className="flex gap-1">
          {[
            ["linux", "Linux (one line)"],
            ["config", "Config file"],
            ["docker", "Docker"],
            ["libs", "Libraries"],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 h-8 rounded text-[13px] ${tab === k ? "bg-primary text-white" : "bg-panel hover:bg-[#eef2fc]"}`}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === "linux" && (
          <>
            {code(`curl -fsSL ${url}/install.sh | DATACAT_API_KEY=${key} sh`)}
            <p className="text-xs text-ink-2">
              Installs <span className="mono">/opt/datacat-agent/bin/datacat-agent</span>, writes <span className="mono">/etc/datacat/datacat.yaml</span> and
              starts the service on systemd hosts. Your host appears in Infrastructure within a minute.
            </p>
          </>
        )}
        {tab === "config" && (
          <>
            {code(yaml)}
            <p className="text-xs text-ink-2">
              Edit <span className="mono">/etc/datacat/datacat.yaml</span> and restart the agent.{" "}
              <span className="mono">datacat-agent config -c /etc/datacat/datacat.yaml</span> prints the generated OpenTelemetry Collector configuration.
            </p>
          </>
        )}
        {tab === "docker" && code(docker)}
        {tab === "libs" &&
          code(`# Node.js
npm install ${url}/downloads/datacat-trace-0.1.0.tgz
DATACAT_SERVICE=my-app DATACAT_ENV=prod node -r @datacat/trace/init app.js

# Python
pip install "datacat-trace[instrumentation] @ ${url}/downloads/datacat_trace-0.1.0-py3-none-any.whl"
DATACAT_SERVICE=my-app DATACAT_ENV=prod datacat-run python app.py`)}
      </div>
    </div>
  );
}

export function SampleDataButton() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["sample"], queryFn: () => api<{ running: boolean }>("/ui/org/sample-data") });
  const m = useMutation({
    mutationFn: (stop: boolean) => api<{ running: boolean }>("/ui/org/sample-data", { body: stop ? { stop: true } : { minutes: 120 } }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
  const running = st.data?.running;
  return (
    <button className="btn" disabled={m.isPending} onClick={() => m.mutate(!!running)} data-testid="sample-data">
      {m.isPending ? "Loading sample data…" : running ? "Stop sample data" : "Load sample data"}
    </button>
  );
}

export function Home() {
  const { user } = useAuthUser();
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => api<{ hosts: any[] }>("/ui/hosts") });
  const mons = useQuery({ queryKey: ["monitors"], queryFn: () => api<any[]>("/v1/monitor") });
  const dash = useQuery({ queryKey: ["dashboards"], queryFn: () => api<{ dashboards: any[] }>("/v1/dashboard") });
  const now = Math.floor(Date.now() / 1000);
  const svcs = useQuery({ queryKey: ["home-svcs"], queryFn: () => api<{ services: any[] }>(`/ui/apm/services?from=${now - 3600}&to=${now}`) });
  const logs = useQuery({
    queryKey: ["home-logs"],
    queryFn: () => api<{ total: number }>("/ui/logs/search", { body: { query: "*", from: now - 3600, to: now, limit: 1 } }),
  });
  const alerting = (mons.data ?? []).filter((m) => m.overall_state === "Alert" || m.overall_state === "Warn");
  const tiles = [
    { label: "Active hosts", value: hosts.data?.hosts.filter((h) => h.up).length, href: "/infrastructure", icon: Server },
    { label: "Services", value: svcs.data?.services.length, href: "/apm/services", icon: Activity },
    { label: "Logs (past hour)", value: logs.data?.total, href: "/logs", icon: ScrollText },
    { label: "Monitors alerting", value: alerting.length, href: "/monitors/manage?status=Alert", icon: Bell },
    { label: "Dashboards", value: dash.data?.dashboards.length, href: "/dashboard/lists", icon: LayoutDashboard },
  ];
  const empty = hosts.data && hosts.data.hosts.length === 0 && (svcs.data?.services.length ?? 0) === 0;
  return (
    <div>
      <PageHeader title={`Welcome${user?.firstName ? ", " + user.firstName : ""}`} sub={user?.orgName} />
      <div className="p-6 space-y-6">
        {empty && (
          <div className="card p-6 flex items-center gap-5 bg-[#eef2fc] border-brand-100">
            <CatMark size={48} />
            <div className="flex-1">
              <div className="section-title">Start sending data to DataCat</div>
              <div className="text-ink-2">Add DataCat to your code (Node.js or Python) or install the host agent. It takes about ten minutes.</div>
            </div>
            <SampleDataButton />
            <Link href="/docs/getting-started" className="btn-primary">
              Get started
            </Link>
          </div>
        )}
        <div className="grid grid-cols-5 gap-4">
          {tiles.map((t) => (
            <Link key={t.label} href={t.href} className="card p-4 hover:border-brand-400">
              <div className="flex items-center gap-2 text-ink-2 text-xs">
                <t.icon size={14} />
                {t.label}
              </div>
              <div className="text-[28px] font-light mt-1">{t.value === undefined ? "—" : fmtNum(t.value)}</div>
            </Link>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="card">
            <div className="px-4 py-2 border-b border-line font-semibold flex">
              Triggered monitors
              <Link href="/monitors/manage" className="ml-auto text-xs text-primary font-normal">
                All monitors →
              </Link>
            </div>
            {alerting.length === 0 ? (
              <div className="px-4 py-4 text-ink-3 text-xs">All monitors are OK.</div>
            ) : (
              alerting.map((m) => (
                <Link key={m.id} href={`/monitors/${m.id}`} className="flex items-center gap-2 px-4 py-2 border-b border-line hover:bg-[#eef2fc]">
                  <StatusBadge state={m.overall_state} />
                  <span className="truncate">{m.name}</span>
                </Link>
              ))
            )}
          </div>
          <div className="card">
            <div className="px-4 py-2 border-b border-line font-semibold flex">
              Services
              <Link href="/apm/services" className="ml-auto text-xs text-primary font-normal">
                Service Catalog →
              </Link>
            </div>
            {(svcs.data?.services ?? []).slice(0, 8).map((s) => (
              <Link
                key={s.service}
                href={`/apm/services/${encodeURIComponent(s.service)}`}
                className="flex items-center gap-2 px-4 py-2 border-b border-line hover:bg-[#eef2fc] text-xs"
              >
                <span className="flex-1 font-medium text-primary">{s.service}</span>
                <span className="text-ink-2">p95 {fmtDuration(s.p95)}</span>
                <span className={s.error_rate > 0.05 ? "text-alert" : "text-ink-2"}>{(s.error_rate * 100).toFixed(1)}% err</span>
              </Link>
            ))}
            {!svcs.data?.services.length && <div className="px-4 py-4 text-ink-3 text-xs">No services reporting in the past hour.</div>}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/metric/explorer" className="btn">
            <LineChart size={14} />
            Explore metrics
          </Link>
          <Link href="/monitors/create" className="btn">
            <Bell size={14} />
            New monitor
          </Link>
          <Link href="/dashboard/lists?new=1" className="btn">
            <LayoutDashboard size={14} />
            New dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Why single sign-on sent the browser back to /login?error=<code>. */
function oidcErrorMessage(code: string | null, label: string): string | null {
  if (!code?.startsWith("oidc_")) return null;
  switch (code) {
    case "oidc_domain_not_allowed":
      return "That account can't sign in to DataCat. Use your organization's account.";
    case "oidc_email_unverified":
      return `Your email address isn't verified with ${label}. Verify it, then try again.`;
    case "oidc_state_mismatch":
      return "Your sign-in expired or was started in another tab. Try again.";
    case "oidc_setup_required":
      return "DataCat isn't set up yet. An administrator must first create the admin account with the setup token.";
    case "oidc_cancelled":
      return "Sign-in was cancelled.";
    case "oidc_misconfigured":
      return "Single sign-on is not configured correctly. Ask your DataCat administrator to check the server log.";
    default:
      return `Couldn't sign in with ${label}. Try again.`;
  }
}

export function Login({ restricted, email }: { restricted?: boolean; email?: string | null }) {
  const { logout, data } = useAuthUser();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const token = window.location.pathname.startsWith("/invite/") ? window.location.pathname.split("/")[2] : "";
  const invite = useQuery({
    queryKey: ["invite", token],
    enabled: !!token,
    queryFn: () => api<{ email: string; role: string }>(`/auth/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const setup = !!data?.setupRequired && !token;
  const oidcLabel = data?.oidc?.label || "single sign-on";
  const oidcError = oidcErrorMessage(new URLSearchParams(window.location.search).get("error"), oidcLabel);
  const showOidc = !!data?.oidc?.enabled && !setup && !token;
  // After signing in, come back to the page that asked for it (the login page itself goes home).
  const here = window.location.pathname === "/login" ? "/" : window.location.pathname + window.location.search + window.location.hash;
  const submit = useMutation({
    mutationFn: () =>
      api(token ? `/auth/invites/${encodeURIComponent(token)}` : setup ? "/auth/setup" : "/auth/login", {
        body: { email: invite.data?.email ?? address, password, orgName, ...(setup && data?.setupTokenRequired ? { setupToken } : {}) },
      }),
    onSuccess: () => {
      window.location.href = "/";
    },
  });
  return (
    <div className="min-h-full flex items-center justify-center bg-brand-900 py-8">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-[400px] text-center">
        <div className="flex justify-center mb-3">
          <CatMark size={56} />
        </div>
        <h1 className="text-[22px] font-bold mb-1">DataCat</h1>
        <p className="text-ink-2 mb-6">Metrics, logs, traces, dashboards and alerts in one place.</p>
        {setup && <h2 className="font-semibold text-base mb-4">Create your admin account + organization</h2>}
        {token && <h2 className="font-semibold text-base mb-4">Join your organization</h2>}
        {oidcError && !restricted && (
          <p role="alert" className="text-alert mb-4 text-sm" data-testid="oidc-error">
            {oidcError}
          </p>
        )}
        {invite.isError && (
          <p role="alert" className="text-alert mb-4 text-sm">
            {invite.error.message}
          </p>
        )}
        {restricted ? (
          <>
            <div className="card bg-panel p-3 text-xs text-ink-2 mb-4 text-left">
              DataCat is invite-only right now. <b>{email}</b> doesn't have access yet. Ask a DataCat admin to invite you, then open the invite link.
            </div>
            <button className="btn w-full justify-center" onClick={logout}>
              Sign in with a different account
            </button>
          </>
        ) : (
          <>
            {showOidc && (
              <>
                <a
                  className="btn-primary w-full justify-center h-10"
                  href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(here)}`}
                  data-testid="login-oidc"
                >
                  <LogIn size={16} />
                  Continue with {oidcLabel}
                </a>
                <div className="flex items-center gap-3 my-4 text-[11px] text-ink-3">
                  <span className="flex-1 border-t border-line" />
                  or sign in with email
                  <span className="flex-1 border-t border-line" />
                </div>
              </>
            )}
            {(!token || invite.data) && (
              <form
                className="text-left space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit.mutate();
                }}
              >
                {setup && data?.setupTokenRequired && (
                  <label className="block text-xs">
                    Setup token
                    <input
                      className="input w-full mt-1 mono"
                      required
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      autoComplete="off"
                      data-testid="setup-token"
                    />
                    <span className="text-ink-3">Printed in the server log at startup, or the value of DATACAT_SETUP_TOKEN.</span>
                  </label>
                )}
                {setup && (
                  <label className="block text-xs">
                    Organization name
                    <input
                      className="input w-full mt-1"
                      required
                      maxLength={150}
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      autoComplete="organization"
                    />
                  </label>
                )}
                <label className="block text-xs">
                  Email
                  <input
                    className="input w-full mt-1"
                    type="email"
                    required
                    value={invite.data?.email ?? address}
                    readOnly={!!token}
                    onChange={(e) => setAddress(e.target.value)}
                    autoComplete="username"
                    data-testid="login-email"
                  />
                </label>
                <label className="block text-xs">
                  Password
                  <input
                    className="input w-full mt-1"
                    type="password"
                    required
                    minLength={12}
                    maxLength={256}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={setup || token ? "new-password" : "current-password"}
                    data-testid="login-password"
                  />
                </label>
                {(setup || token) && <p className="text-xs text-ink-3">Use at least 12 characters. Keep your password somewhere safe.</p>}
                {submit.isError && (
                  <p role="alert" className="text-alert text-sm">
                    {submit.error.message}
                  </p>
                )}
                <button className={`${showOidc ? "btn" : "btn-primary"} w-full justify-center h-10`} disabled={submit.isPending} data-testid="login">
                  {submit.isPending ? "Please wait…" : setup ? "Create admin account" : token ? "Set password and join" : "Log in"}
                </button>
              </form>
            )}
          </>
        )}
        <p className="text-[11px] text-ink-3 mt-4">
          {token ? (
            <a href="/login" className="text-primary">
              Already have an account? Log in
            </a>
          ) : (
            "New members: ask your admin for an invite link."
          )}
        </p>
      </div>
    </div>
  );
}
