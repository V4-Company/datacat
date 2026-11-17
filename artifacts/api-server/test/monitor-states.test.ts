import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMonitorQuery } from "../src/jobs/monitors";

test("monitor queries must not be empty and must end with a comparison", () => {
  assert.throws(() => validateMonitorQuery("metric alert", ""));
  assert.throws(() => validateMonitorQuery("log alert", 'logs("x").last("5m")'));
  validateMonitorQuery("log alert", 'logs("service:x").by("env").last("5m") > 5');
});
