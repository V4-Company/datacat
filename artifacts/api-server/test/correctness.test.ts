import { test } from "node:test";
import assert from "node:assert/strict";
import { otlpToMetrics, expoToExplicit } from "../src/intake/otlp";
import { evalFormula, reduce, interpolatedPercentile, weightedPercentileRows, type SeriesSet } from "../src/query/metrics";
import { isStorageError } from "../src/lib/http";
import { sketchPoints } from "../src/intake/routes";
import { aggregatePasses, mergeBuckets, toBuckets, parseAggregate } from "../src/query/v2";
import { parseMonitorQuery } from "../src/jobs/monitors";

const kv = (key: string, v: string) => ({ key, value: { stringValue: v } });
const sumReq = (v: number, t: number, inst = "i1", attrs: any[] = [kv("a", "1"), kv("b", "2")]) => ({
  resourceMetrics: [
    {
      resource: { attributes: [kv("service.name", "svc"), kv("service.instance.id", inst)] },
      scopeMetrics: [
        {
          scope: { name: "s" },
          metrics: [
            {
              name: "reqs",
              sum: {
                isMonotonic: true,
                aggregationTemporality: 2,
                dataPoints: [{ startTimeUnixNano: "1", timeUnixNano: String(t * 1e9), asInt: v, attributes: attrs }],
              },
            },
          ],
        },
      ],
    },
  ],
});
const counts = (r: ReturnType<typeof otlpToMetrics>) => r.points.filter((p) => p.metric === "reqs").map((p) => p.points[0][1]);
let org = 1000;

test("cumulative counters: a failed store and retry keep the increment (reference applied on commit)", () => {
  const o = org++;
  otlpToMetrics(o, sumReq(100, 10)).commit();
  otlpToMetrics(o, sumReq(110, 20)).commit();
  otlpToMetrics(o, sumReq(140, 30)); // store failed: no commit
  const retry = otlpToMetrics(o, sumReq(140, 30));
  assert.deepEqual(counts(retry), [30]);
});

test("cumulative counters: stream key includes the instance and ignores attribute order; older samples are ignored", () => {
  const o = org++;
  otlpToMetrics(o, sumReq(100, 10, "a")).commit();
  otlpToMetrics(o, sumReq(70, 10, "b")).commit();
  assert.deepEqual(counts(otlpToMetrics(o, sumReq(130, 20, "a"))), [30]);
  const o2 = org++;
  otlpToMetrics(o2, sumReq(100, 10)).commit();
  assert.deepEqual(counts(otlpToMetrics(o2, sumReq(130, 20, "i1", [kv("b", "2"), kv("a", "1")]))), [30]);
  const o3 = org++;
  for (const [v, t] of [
    [100, 0],
    [130, 30],
    [120, 20],
    [140, 40],
  ]) {
    const r = otlpToMetrics(o3, sumReq(v, t));
    r.commit();
    if (t === 20) assert.deepEqual(counts(r), []);
  }
});

test("exponential histograms keep negative buckets in ascending order", () => {
  const { bounds, counts } = expoToExplicit({
    scale: 0,
    zeroCount: 1,
    positive: { offset: 0, bucketCounts: [2] },
    negative: { offset: 0, bucketCounts: [3, 4] },
  });
  assert.deepEqual(bounds, [-2, -1, 0, 2]);
  assert.deepEqual(counts, [4, 3, 1, 2, 0]);
});

test("disk usage keeps the device tag", () => {
  const dp = (st: string, dev: string, v: number) => ({ timeUnixNano: "60000000000", asInt: v, attributes: [kv("state", st), kv("device", dev)] });
  const r = otlpToMetrics(org++, {
    resourceMetrics: [
      {
        resource: { attributes: [kv("host.name", "h")] },
        scopeMetrics: [
          {
            scope: { name: "hostmetricsreceiver/filesystem" },
            metrics: [
              {
                name: "system.filesystem.usage",
                sum: { isMonotonic: false, dataPoints: [dp("used", "a", 2), dp("free", "a", 8), dp("used", "b", 8), dp("free", "b", 2)] },
              },
            ],
          },
        ],
      },
    ],
  });
  const inUse = r.points.filter((p) => p.metric === "system.disk.in_use").map((p) => [p.tags.find((t) => t.startsWith("device:")), p.points[0][1]]);
  assert.deepEqual(inUse.sort(), [
    ["device:a", 0.2],
    ["device:b", 0.8],
  ]);
});

test("ClickHouse insert and connection failures are storage errors (503); data errors are not", () => {
  assert.ok(isStorageError(new Error("ClickHouse: insert into logs: Code: 241")));
  assert.ok(isStorageError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })));
  assert.ok(isStorageError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })));
  assert.ok(isStorageError(Object.assign(new Error("db"), { code: "57P01" })));
  assert.ok(!isStorageError(Object.assign(new Error("bad value"), { code: "22P02" })));
  assert.ok(!isStorageError(new Error("Expected a JSON body")));
});

test("sketch bins become weighted points; counts and percentiles hold", () => {
  const pts = sketchPoints([{ ts: 60, cnt: 100, min: 0, max: 100, avg: 99, sum: 9900, k: [0, 1635], n: [1, 99] }]);
  assert.equal(
    pts.reduce((a, p) => a + p[2], 0),
    100,
  );
  const rows = pts.map(([, v, w]) => ({ g: 0, b: 60, v, w }));
  const p95 = weightedPercentileRows(rows, 0.95)[0].v;
  assert.ok(Math.abs(p95 - 100) / 100 < 0.02, String(p95));
  assert.equal(
    weightedPercentileRows(
      [10, 20, 30, 40].map((v) => ({ g: 0, b: 0, v, w: 1 })),
      0.5,
    )[0].v,
    25,
  );
});

test("formulas combine only matching groups; one-sided groups are kept for + and -", () => {
  const s = (key: string, pts: [number, number][]): SeriesSet[number] => ({ key, tags: key === "*" ? [] : [key], points: new Map(pts) });
  const env = {
    b: [
      s("host:a", [
        [0, 2],
        [60, 4],
      ]),
    ],
    c: [
      s("host:c", [
        [0, 3],
        [60, 6],
      ]),
    ],
    t: [s("*", [[0, 10]])],
  };
  const r = evalFormula("b + c", env, 60);
  assert.deepEqual(r.map((x) => [x.key, [...x.points.values()]]).sort(), [
    ["host:a", [2, 4]],
    ["host:c", [3, 6]],
  ]);
  assert.deepEqual(
    evalFormula("b * c", env, 60).map((x) => x.key),
    [],
  );
  assert.deepEqual(
    evalFormula("b + t", env, 60).map((x) => [x.key, x.points.get(0)]),
    [["host:a", 12]],
  );
});

test("monitor aggregations: percentile(N), change and pct_change", () => {
  const vals = Array.from({ length: 20 }, (_, i) => i);
  assert.equal(reduce(vals, parseMonitorQuery("metric alert", "percentile(50)(last_5m):avg:x{*} > 1").timeAgg), 9.5);
  assert.equal(reduce(vals, "p95"), interpolatedPercentile(vals, 0.95));
  assert.equal(reduce([100, 0], parseMonitorQuery("metric alert", "change(last_5m,last_5m)(last_5m):avg:x{*} > 1").timeAgg), -100);
  assert.equal(reduce([50, 75], "pct_change"), 50);
  assert.throws(() => parseMonitorQuery("metric alert", "percentile(150)(last_5m):avg:x{*} > 1"));
});

test("log aggregate: totals and timeseries are separate passes, merged per group", () => {
  const a = parseAggregate({
    filter: { from: "1000", to: "1180" },
    compute: [{ aggregation: "count" }, { aggregation: "count", type: "timeseries", interval: "60s" }],
  });
  const passes = aggregatePasses(a, () => 60);
  assert.deepEqual(
    passes.map((p) => [p.interval, p.computes.map((c) => c.name)]),
    [
      [null, ["c0"]],
      [60, ["c1"]],
    ],
  );
  const total = toBuckets({ ...a, computes: passes[0].computes }, [{ c0: 3 }]);
  const ts = toBuckets({ ...a, computes: passes[1].computes }, [
    { t: 960, c1: 2 },
    { t: 1020, c1: 1 },
  ]);
  const merged = mergeBuckets([total, ts]);
  assert.equal(merged[0].computes.c0, 3);
  assert.equal((merged[0].computes.c1 as any[]).length, 2);
});
