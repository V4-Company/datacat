export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(1) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "G";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e4) return (v / 1e3).toFixed(1) + "K";
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) {
    const s = v.toFixed(digits);
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  }
  if (a === 0) return "0";
  return v.toPrecision(2);
}
export function fmtDuration(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return "—";
  if (ns >= 1e9 * 60) return (ns / 6e10).toFixed(1) + " min";
  if (ns >= 1e9) return (ns / 1e9).toFixed(2) + " s";
  if (ns >= 1e6) return (ns / 1e6).toFixed(ns >= 1e8 ? 0 : 1) + " ms";
  if (ns >= 1e3) return (ns / 1e3).toFixed(0) + " µs";
  return ns.toFixed(0) + " ns";
}
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits) + "%";
}
export function fmtTime(ms: number, withDate = false): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (!withDate) return t;
  return d.toLocaleDateString([], { month: "short", day: "2-digit" }) + " " + t;
}
export function fmtAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Palette similar in spirit to classic observability palettes, tuned for DataCat
export const PALETTE = ["#7a55d0", "#f08c2e", "#3a8de0", "#2eac87", "#e2557d", "#e9b93b", "#5462d8", "#9b6a3c", "#21a2b8", "#c4479f", "#7c9a2b", "#8a8fa0"];
export const WARM = ["#f39a2e", "#e9733a", "#f2b84b", "#d9534f", "#a8442b"];
export const COOL = ["#bde0fe", "#90caf9", "#5b9bd5", "#3a6ea5", "#1f3c88"];
export function colorFor(i: number, palette = "classic") {
  const p = palette === "warm" ? WARM : palette === "cool" ? COOL : PALETTE;
  return p[i % p.length];
}
export const STATUS_COLORS: Record<string, string> = {
  error: "#d33b4c",
  critical: "#9d2235",
  alert: "#b3261e",
  emergency: "#7a0f1c",
  warn: "#e8a317",
  notice: "#2fa4e7",
  info: "#5b7be0",
  debug: "#8b8fa3",
  ok: "#2ca05a",
};
