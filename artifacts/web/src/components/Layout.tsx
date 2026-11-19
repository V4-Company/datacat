import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Server,
  Bell,
  Activity,
  ScrollText,
  LineChart,
  Settings,
  CalendarClock,
  HelpCircle,
  LogOut,
  Search,
  BookOpen,
  UserPlus,
  LifeBuoy,
  PlugZap,
  Bot,
} from "lucide-react";
import { CatMark } from "./Logo";
import { useAuthUser } from "@/lib/auth";
import { api } from "@/lib/api";

type NavItem = { label: string; icon: any; href: string; match: string[]; children?: { label: string; href: string }[] };
const NAV_GROUPS: NavItem[][] = [
  [
    {
      label: "Dashboards",
      icon: LayoutDashboard,
      href: "/dashboard/lists",
      match: ["/dashboard"],
      children: [
        { label: "Dashboard List", href: "/dashboard/lists" },
        { label: "New Dashboard", href: "/dashboard/lists?new=1" },
      ],
    },
    {
      label: "Monitors",
      icon: Bell,
      href: "/monitors/manage",
      match: ["/monitors"],
      children: [
        { label: "Manage Monitors", href: "/monitors/manage" },
        { label: "New Monitor", href: "/monitors/create" },
        { label: "Triggered Monitors", href: "/monitors/manage?status=Alert" },
      ],
    },
  ],
  [
    {
      label: "Infrastructure",
      icon: Server,
      href: "/infrastructure",
      match: ["/infrastructure"],
      children: [
        { label: "Hosts", href: "/infrastructure" },
        { label: "Host Map", href: "/infrastructure/map" },
      ],
    },
    {
      label: "APM",
      icon: Activity,
      href: "/apm/services",
      match: ["/apm"],
      children: [
        { label: "Service Catalog", href: "/apm/services" },
        { label: "Traces", href: "/apm/traces" },
      ],
    },
  ],
  [
    {
      label: "Metrics",
      icon: LineChart,
      href: "/metric/explorer",
      match: ["/metric"],
      children: [
        { label: "Explorer", href: "/metric/explorer" },
        { label: "Summary", href: "/metric/summary" },
      ],
    },
    {
      label: "Logs",
      icon: ScrollText,
      href: "/logs",
      match: ["/logs"],
      children: [
        { label: "Explorer", href: "/logs" },
        { label: "Live Tail", href: "/logs?live=1" },
        { label: "Analytics", href: "/logs?viz=timeseries" },
      ],
    },
    { label: "Events", icon: CalendarClock, href: "/event/explorer", match: ["/event"] },
  ],
];
const NAV = NAV_GROUPS.flat();

function NavLink({ n, active, onHover, hover, close }: { n: NavItem; active: boolean; onHover: (s: string) => void; hover: string | null; close: () => void }) {
  return (
    <div className="relative" onMouseEnter={() => onHover(n.label)}>
      <Link
        href={n.href}
        className={`flex items-center gap-2.5 mx-2 px-2.5 h-[30px] rounded-[3px] text-[13px] ${active ? "bg-white/[0.13] text-white font-semibold" : "text-white/75 hover:bg-white/[0.08] hover:text-white"}`}
      >
        <n.icon size={15} strokeWidth={1.9} /> {n.label}
      </Link>
      {hover === n.label && n.children && (
        <div className="absolute left-full top-0 -ml-1 w-56 bg-white text-ink shadow-xl rounded-[4px] border border-line py-2 z-50">
          <div className="px-4 pb-1.5 text-[12px] font-semibold text-ink">{n.label}</div>
          {n.children.map((c) => (
            <Link key={c.href} href={c.href} onClick={close} className="block px-4 py-1.5 text-[13px] text-ink-2 hover:bg-[#f2f4fb] hover:text-primary">
              {c.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [, nav] = useLocation();
  const [sel, setSel] = useState(0);
  const dashboards = useQuery({ queryKey: ["dashboards"], queryFn: () => api<{ dashboards: any[] }>("/v1/dashboard"), enabled: open });
  const monitors = useQuery({ queryKey: ["monitors"], queryFn: () => api<any[]>("/v1/monitor"), enabled: open });
  const items = useMemo(() => {
    const pages = NAV.flatMap((n) => [
      { kind: "Page", label: n.label, href: n.href },
      ...(n.children ?? []).map((c) => ({ kind: n.label, label: c.label, href: c.href })),
    ]);
    const ds = (dashboards.data?.dashboards ?? []).map((d) => ({ kind: "Dashboard", label: d.title, href: `/dashboard/${d.id}` }));
    const ms = (monitors.data ?? []).map((m) => ({ kind: "Monitor", label: m.name, href: `/monitors/${m.id}` }));
    const extra = [
      { kind: "Page", label: "Docs", href: "/docs" },
      { kind: "Page", label: "Organization Settings", href: "/organization-settings" },
    ];
    const all = [...pages, ...extra, ...ds, ...ms];
    const qq = q.toLowerCase();
    return (qq ? all.filter((i) => i.label.toLowerCase().includes(qq) || i.kind.toLowerCase().includes(qq)) : all).slice(0, 12);
  }, [q, dashboards.data, monitors.data]);
  useEffect(() => {
    setSel(0);
  }, [q]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  if (!open) return null;
  const go = (h: string) => {
    nav(h);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/30 flex justify-center pt-[12vh]" onClick={onClose}>
      <div className="w-[560px] bg-white rounded-md shadow-2xl overflow-hidden self-start" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line">
          <Search size={15} className="text-ink-3" />
          <input
            autoFocus
            className="flex-1 outline-none text-[14px]"
            placeholder="Search pages, dashboards and monitors"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
              if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
              if (e.key === "Enter" && items[sel]) go(items[sel].href);
            }}
          />
          <kbd className="text-[10px] text-ink-3 border border-line rounded px-1">esc</kbd>
        </div>
        <div className="max-h-[360px] overflow-auto py-1">
          {items.map((i, k) => (
            <button
              key={i.kind + i.href}
              onMouseEnter={() => setSel(k)}
              onClick={() => go(i.href)}
              className={`w-full flex items-center gap-3 px-3 h-8 text-left text-[13px] ${k === sel ? "bg-[#eef2fc] text-primary" : ""}`}
            >
              <span className="w-20 shrink-0 text-[11px] text-ink-3">{i.kind}</span>
              <span className="truncate">{i.label}</span>
            </button>
          ))}
          {items.length === 0 && <div className="px-3 py-4 text-ink-3 text-[13px]">No matches</div>}
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [hover, setHover] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const { user, logout } = useAuthUser();
  const active = (n: NavItem) => n.match.some((m) => loc.startsWith(m));
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  const initial = (user?.firstName ?? user?.email ?? "?")[0]?.toUpperCase();
  return (
    <div className="flex h-full bg-nav">
      <nav className="w-[200px] shrink-0 bg-nav text-white flex flex-col relative z-30" onMouseLeave={() => setHover(null)}>
        <Link href="/" className="flex flex-col items-center justify-center pt-4 pb-3 gap-1" aria-label="DataCat home">
          <CatMark size={54} />
          <span className="text-[15px] font-extrabold tracking-[0.12em]">DATACAT</span>
        </Link>
        <div className="flex-1 flex flex-col gap-3 pt-1">
          {NAV_GROUPS.map((g, gi) => (
            <div key={gi} className="flex flex-col gap-px">
              {g.map((n) => (
                <NavLink key={n.label} n={n} active={active(n)} hover={hover} onHover={setHover} close={() => setHover(null)} />
              ))}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-px pb-2" onMouseEnter={() => setHover(null)}>
          <Link
            href="/account/agent"
            className={`flex items-center gap-2.5 mx-2 px-2.5 h-[30px] rounded-[3px] text-[13px] ${loc.startsWith("/account/agent") ? "bg-white/[0.13] font-semibold" : "text-white/75 hover:bg-white/[0.08]"}`}
          >
            <PlugZap size={15} /> Install Agent
          </Link>
          <Link
            href="/account/mcp"
            className={`flex items-center gap-2.5 mx-2 px-2.5 h-[30px] rounded-[3px] text-[13px] ${loc.startsWith("/account/mcp") ? "bg-white/[0.13] font-semibold" : "text-white/75 hover:bg-white/[0.08]"}`}
          >
            <Bot size={15} /> MCP server
          </Link>
          <Link
            href="/docs"
            className={`flex items-center gap-2.5 mx-2 px-2.5 h-[30px] rounded-[3px] text-[13px] ${loc.startsWith("/docs") ? "bg-white/[0.13] font-semibold" : "text-white/75 hover:bg-white/[0.08]"}`}
          >
            <BookOpen size={15} /> Docs
          </Link>
          <Link
            href="/organization-settings"
            className={`flex items-center gap-2.5 mx-2 px-2.5 h-[30px] rounded-[3px] text-[13px] ${loc.startsWith("/organization-settings") ? "bg-white/[0.13] font-semibold" : "text-white/75 hover:bg-white/[0.08]"}`}
          >
            <Settings size={15} /> Organization
          </Link>
          <div className="grid grid-cols-3 mt-2 pt-2 border-t border-white/10 text-white/70 text-[10px]">
            <Link href="/organization-settings" className="flex flex-col items-center gap-0.5 py-1 hover:text-white">
              <UserPlus size={14} />
              Invite
            </Link>
            <Link href="/docs" className="flex flex-col items-center gap-0.5 py-1 hover:text-white">
              <LifeBuoy size={14} />
              Support
            </Link>
            <Link href="/docs/getting-started" className="flex flex-col items-center gap-0.5 py-1 hover:text-white">
              <HelpCircle size={14} />
              Help
            </Link>
          </div>
        </div>
      </nav>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-9 shrink-0 bg-nav flex items-center px-3 relative">
          <button
            onClick={() => setPalette(true)}
            className="absolute left-1/2 -translate-x-1/2 w-[340px] h-[26px] rounded-[3px] bg-white/[0.12] hover:bg-white/[0.17] text-white/70 text-[12px] flex items-center gap-2 px-2.5"
            data-testid="global-search"
          >
            <Search size={13} /> <span className="flex-1 text-left">Search DataCat</span>
            <kbd className="text-[10px] text-white/60">⌘ K</kbd>
          </button>
          {user && (
            <div className="ml-auto flex items-center gap-2 text-white/80 text-[12px]">
              <span className="hidden md:inline truncate max-w-[180px]" title={user.email ?? ""}>
                {user.firstName ?? user.email}
              </span>
              <div className="w-6 h-6 rounded-[4px] bg-accent text-[#23222c] flex items-center justify-center font-bold text-[11px]" title={user.email ?? ""}>
                {initial}
              </div>
              <button onClick={logout} title="Log out" className="p-1 hover:text-white">
                <LogOut size={14} />
              </button>
            </div>
          )}
        </header>
        <main className="flex-1 min-w-0 overflow-auto bg-white rounded-tl-[6px]">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

export type HeaderTab = { label: string; href: string; active?: boolean };

/** Product header: icon + product name + inline tabs on the left, actions on the right. */
export function PageHeader({
  title,
  children,
  sub,
  icon: Icon,
  tabs,
}: {
  title: ReactNode;
  children?: ReactNode;
  sub?: ReactNode;
  icon?: any;
  tabs?: HeaderTab[];
}) {
  const [loc] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  const isActive = (t: HeaderTab) =>
    t.active ??
    (t.href.includes("?") ? loc + search === t.href : loc === t.href && !(tabs ?? []).some((o) => o !== t && o.href.includes("?") && loc + search === o.href));
  return (
    <div className="flex items-stretch gap-3 px-5 h-[50px] border-b border-line bg-white sticky top-0 z-20">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && <Icon size={18} strokeWidth={1.8} className="text-ink-2 shrink-0" />}
        <h1 className="text-[17px] font-semibold truncate">{title}</h1>
        {sub && <div className="text-ink-3 text-xs truncate self-center">{sub}</div>}
      </div>
      {tabs && (
        <div className="flex items-stretch ml-3">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`px-3 flex items-center text-[13px] border-b-2 -mb-px ${isActive(t) ? "border-primary text-ink font-semibold" : "border-transparent text-ink-2 hover:text-ink"}`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

export const TABS = {
  infra: [
    { label: "Hosts", href: "/infrastructure" },
    { label: "Host Map", href: "/infrastructure/map" },
  ],
  dash: [{ label: "List", href: "/dashboard/lists" }],
  mon: [
    { label: "List", href: "/monitors/manage" },
    { label: "Triggered", href: "/monitors/manage?status=Alert" },
  ],
  apm: [
    { label: "Service Catalog", href: "/apm/services" },
    { label: "Traces", href: "/apm/traces" },
  ],
  logs: [
    { label: "Explorer", href: "/logs" },
    { label: "Live Tail", href: "/logs?live=1" },
    { label: "Analytics", href: "/logs?viz=timeseries" },
  ],
  metrics: [
    { label: "Explorer", href: "/metric/explorer" },
    { label: "Summary", href: "/metric/summary" },
  ],
};
export const ICONS = { infra: Server, dash: LayoutDashboard, mon: Bell, apm: Activity, logs: ScrollText, metrics: LineChart, events: CalendarClock };
