import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("a receiver that trickles bytes is cut off at the total time limit", async () => {
  process.env.DATACAT_ALLOW_PRIVATE_WEBHOOKS = "true";
  const { postWebhook } = await import("../src/lib/safeHttp");
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => res.write("x"), 100);
    res.on("close", () => clearInterval(iv));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const t = Date.now();
  await assert.rejects(postWebhook(`http://127.0.0.1:${port}/`, {}, "{}", 1000, 800), /timeout/);
  assert.ok(Date.now() - t < 2000);
  server.close();
});
