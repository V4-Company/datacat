import { logger } from "./logger";

/**
 * Per-organization intake counters, so silent loss is visible: every intake path records how many items it stored
 * and how many it had to drop (unreadable payloads, invalid points). Read with GET /api/v1/intake/stats.
 * Counters live in process memory and reset when the server restarts.
 */
interface PathStats {
  stored: number;
  dropped: number;
  last_drop?: { at: string; reason: string; count: number };
}
const stats = new Map<number, Map<string, PathStats>>();

function entry(orgId: number, path: string): PathStats {
  let org = stats.get(orgId);
  if (!org) stats.set(orgId, (org = new Map()));
  let e = org.get(path);
  if (!e) org.set(path, (e = { stored: 0, dropped: 0 }));
  return e;
}

export function recordStored(orgId: number, path: string, n: number) {
  if (n > 0) entry(orgId, path).stored += n;
}

export function recordDrop(orgId: number, path: string, n: number, reason: string) {
  if (n <= 0) return;
  const e = entry(orgId, path);
  e.dropped += n;
  e.last_drop = { at: new Date().toISOString(), reason, count: n };
  logger.warn({ orgId, path, dropped: n, reason }, "intake dropped items");
}

export function intakeStats(orgId: number): Record<string, PathStats> {
  return Object.fromEntries(stats.get(orgId) ?? []);
}

/** Points with a metric name and finite timestamp/value are stored; the rest are dropped. */
export function splitPoints<T extends { metric?: string; points?: number[][] }>(series: T[]) {
  let valid = 0;
  let invalid = 0;
  for (const s of series) {
    for (const [ts, v] of s.points ?? []) {
      if (s.metric && Number.isFinite(ts) && Number.isFinite(v)) valid++;
      else invalid++;
    }
  }
  return { valid, invalid };
}
