'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DataCatSpanExporter } = require('../lib/span-exporter');

test('a connection reset after the response headers is a failed attempt, not a crash', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    n++;
    if (n === 1) {
      res.writeHead(200, { 'content-length': '100' });
      res.write('x');
      setTimeout(() => res.socket.destroy(), 20);
    } else res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const exp = new DataCatSpanExporter({ url: `http://127.0.0.1:${server.address().port}/v1/traces` });
  const r = await exp.post(Buffer.from('a'));
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  const ok = await exp.post(Buffer.from('a'));
  assert.equal(ok.ok, true);
  await exp.shutdown();
  server.close();
});
