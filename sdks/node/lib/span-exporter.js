'use strict';
// Fast OTLP/HTTP protobuf span exporter.
//
// Encodes ExportTraceServiceRequest straight into one reusable buffer instead of building
// intermediate objects (what @opentelemetry/otlp-transformer does). Resource and scope encodings
// and attribute keys are cached, and hex trace/span IDs are converted natively. Nested message
// lengths use a fixed 4-byte varint (valid protobuf: decoders accept non-minimal varints), so
// encoding is a single pass. Output is wire-compatible with any OTLP receiver.
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const SUCCESS = 0;
const FAILED = 1;

class Writer {
  constructor(size = 1 << 20) { this.buf = Buffer.allocUnsafe(size); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  byte(b) { this.ensure(1); this.buf[this.pos++] = b; }
  varint(v) {
    this.ensure(10);
    const buf = this.buf;
    if (v < 0x80000000 && v >= 0) {
      while (v > 127) { buf[this.pos++] = (v & 127) | 128; v >>>= 7; }
      buf[this.pos++] = v;
      return;
    }
    // 64-bit (two's complement for negatives)
    let lo; let hi;
    if (v < 0) {
      const a = -v;
      lo = a >>> 0; hi = Math.floor(a / 4294967296) >>> 0;
      lo = (~lo + 1) >>> 0; hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0;
    } else { lo = v >>> 0; hi = Math.floor(v / 4294967296) >>> 0; }
    while (hi > 0 || lo > 127) {
      buf[this.pos++] = (lo & 127) | 128;
      lo = ((lo >>> 7) | (hi << 25)) >>> 0;
      hi >>>= 7;
    }
    buf[this.pos++] = lo;
  }
  tag(field, wire) { this.byte((field << 3) | wire); }
  bytesRaw(b) { this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
  string(field, s) {
    const n = Buffer.byteLength(s);
    this.tag(field, 2); this.varint(n); this.ensure(n);
    this.pos += this.buf.write(s, this.pos, n, 'utf8');
  }
  hexBytes(field, hex, len) {
    this.tag(field, 2); this.byte(len); this.ensure(len);
    this.buf.write(hex, this.pos, len, 'hex'); this.pos += len;
  }
  fixed64HrTime(field, t) {
    // t = [seconds, nanos]; write seconds*1e9 + nanos as exact uint64 LE
    this.tag(field, 1); this.ensure(8);
    const sec = t[0]; const ns = t[1];
    const x1 = (sec % 65536) * 1e9 + ns;
    const x2 = Math.floor(sec / 65536) * 1e9;
    const tt = (x2 % 65536) * 65536 + x1;
    const lo = tt % 4294967296;
    const hi = Math.floor(x2 / 65536) + Math.floor(tt / 4294967296);
    this.buf.writeUInt32LE(lo >>> 0, this.pos); this.buf.writeUInt32LE(hi >>> 0, this.pos + 4); this.pos += 8;
  }
  double(field, v) { this.tag(field, 1); this.ensure(8); this.buf.writeDoubleLE(v, this.pos); this.pos += 8; }
  // begin a length-delimited field with a fixed 4-byte length placeholder
  begin(field) { this.tag(field, 2); this.ensure(4); const at = this.pos; this.pos += 4; return at; }
  end(at) {
    const n = this.pos - at - 4;
    const buf = this.buf;
    buf[at] = (n & 127) | 128; buf[at + 1] = ((n >>> 7) & 127) | 128; buf[at + 2] = ((n >>> 14) & 127) | 128; buf[at + 3] = (n >>> 21) & 127;
  }
}

const keyCache = new Map();
function keyBytes(k) {
  let b = keyCache.get(k);
  if (!b) {
    const s = Buffer.from(k, 'utf8');
    const head = [0x0a]; let n = s.length;
    while (n > 127) { head.push((n & 127) | 128); n >>>= 7; } head.push(n);
    b = Buffer.concat([Buffer.from(head), s]);
    if (keyCache.size < 4096) keyCache.set(k, b);
  }
  return b;
}

function anyValue(w, field, v) {
  const at = w.begin(field);
  switch (typeof v) {
    case 'string': w.string(1, v); break;
    case 'boolean': w.tag(2, 0); w.byte(v ? 1 : 0); break;
    case 'number':
      if (Number.isInteger(v) && Number.isSafeInteger(v)) { w.tag(3, 0); w.varint(v); } else w.double(4, v);
      break;
    case 'bigint': w.tag(3, 0); w.varint(Number(v)); break;
    default:
      if (Array.isArray(v)) {
        const arr = w.begin(5);
        for (const item of v) if (item !== null && item !== undefined) anyValue(w, 1, item);
        w.end(arr);
      } else if (v instanceof Uint8Array) {
        w.tag(7, 2); w.varint(v.length); w.bytesRaw(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      } else if (v && typeof v === 'object') {
        const kv = w.begin(6);
        for (const k of Object.keys(v)) if (v[k] !== null && v[k] !== undefined) keyValue(w, 1, k, v[k]);
        w.end(kv);
      } else w.string(1, String(v));
  }
  w.end(at);
}
function keyValue(w, field, k, v) {
  const at = w.begin(field);
  w.bytesRaw(keyBytes(k));
  anyValue(w, 2, v);
  w.end(at);
}
function attributes(w, field, attrs) {
  if (!attrs) return;
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== undefined && v !== null) keyValue(w, field, k, v);
  }
}

const resourceCache = new WeakMap();
function resourceBytes(resource) {
  let b = resourceCache.get(resource);
  if (!b) {
    const w = new Writer(4096);
    const at = w.begin(1); // ResourceSpans.resource
    attributes(w, 1, resource.attributes);
    w.end(at);
    b = Buffer.from(w.buf.subarray(0, w.pos));
    resourceCache.set(resource, b);
  }
  return b;
}
const scopeCache = new Map();
function scopeBytes(scope) {
  const key = `${scope.name}\u0000${scope.version || ''}`;
  let b = scopeCache.get(key);
  if (!b) {
    const w = new Writer(256);
    const at = w.begin(1); // ScopeSpans.scope
    w.string(1, scope.name || '');
    if (scope.version) w.string(2, scope.version);
    w.end(at);
    b = Buffer.from(w.buf.subarray(0, w.pos));
    scopeCache.set(key, b);
  }
  return b;
}

function encodeSpan(w, span) {
  const at = w.begin(2); // ScopeSpans.spans
  const sc = span.spanContext();
  w.hexBytes(1, sc.traceId, 16);
  w.hexBytes(2, sc.spanId, 8);
  const ts = sc.traceState && sc.traceState.serialize();
  if (ts) w.string(3, ts);
  const parent = span.parentSpanContext ? span.parentSpanContext.spanId : span.parentSpanId;
  if (parent) w.hexBytes(4, parent, 8);
  w.string(5, span.name);
  w.tag(6, 0); w.byte(span.kind + 1);
  w.fixed64HrTime(7, span.startTime);
  w.fixed64HrTime(8, span.endTime);
  attributes(w, 9, span.attributes);
  if (span.droppedAttributesCount) { w.tag(10, 0); w.varint(span.droppedAttributesCount); }
  if (span.events) for (const e of span.events) {
    const ev = w.begin(11);
    w.fixed64HrTime(1, e.time);
    w.string(2, e.name);
    attributes(w, 3, e.attributes);
    w.end(ev);
  }
  if (span.links) for (const l of span.links) {
    const lk = w.begin(13);
    w.hexBytes(1, l.context.traceId, 16);
    w.hexBytes(2, l.context.spanId, 8);
    attributes(w, 4, l.attributes);
    w.end(lk);
  }
  const st = span.status;
  if (st && (st.code || st.message)) {
    const s = w.begin(15);
    if (st.message) w.string(2, st.message);
    if (st.code) { w.tag(3, 0); w.byte(st.code); }
    w.end(s);
  }
  w.end(at);
}

function encode(w, spans) {
  w.pos = 0;
  // group by resource, then scope (spans from one process share a resource object)
  const byResource = new Map();
  for (const span of spans) {
    let scopes = byResource.get(span.resource);
    if (!scopes) { scopes = new Map(); byResource.set(span.resource, scopes); }
    const scope = span.instrumentationScope || span.instrumentationLibrary || { name: '' };
    const key = `${scope.name}\u0000${scope.version || ''}`;
    let entry = scopes.get(key);
    if (!entry) { entry = { scope, spans: [] }; scopes.set(key, entry); }
    entry.spans.push(span);
  }
  for (const [resource, scopes] of byResource) {
    const rs = w.begin(1); // ExportTraceServiceRequest.resource_spans
    w.bytesRaw(resourceBytes(resource));
    for (const { scope, spans: list } of scopes.values()) {
      const ss = w.begin(2); // ResourceSpans.scope_spans
      w.bytesRaw(scopeBytes(scope));
      for (const span of list) encodeSpan(w, span);
      w.end(ss);
    }
    w.end(rs);
  }
  return w.buf.subarray(0, w.pos);
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

class DataCatSpanExporter {
  constructor({ url, headers = {}, timeoutMillis = 10000 }) {
    this.url = new URL(url);
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.agent = new this.transport.Agent({ keepAlive: true, maxSockets: 2 });
    this.headers = { 'content-type': 'application/x-protobuf', ...headers };
    this.timeout = timeoutMillis;
    this.writer = new Writer();
    this.pending = new Set();
    this.stopped = false;
    this.retryMs = Number(process.env.DATACAT_EXPORT_RETRY_SECONDS ?? 30) * 1000;
  }
  export(spans, resultCallback) {
    if (this.stopped) return resultCallback({ code: FAILED, error: new Error('exporter shut down') });
    let body;
    try { body = Buffer.from(encode(this.writer, spans)); } catch (error) { return resultCallback({ code: FAILED, error }); }
    // shrink an oversized scratch buffer after a burst
    if (this.writer.buf.length > (16 << 20)) this.writer = new Writer();
    const done = this.send(body);
    this.pending.add(done);
    done.then((result) => { this.pending.delete(done); resultCallback(result); });
  }
  // One POST; resolves { ok, retryable, retryAfterMs, error }.
  post(body) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const req = this.transport.request(this.url, {
        method: 'POST', agent: this.agent, timeout: this.timeout,
        headers: { ...this.headers, 'content-length': body.length },
      }, (res) => {
        // A reset after the headers must count as a failed (retryable) attempt, not crash the application.
        res.on('error', (error) => done({ ok: false, retryable: true, error }));
        res.on('aborted', () => done({ ok: false, retryable: true, error: Object.assign(new Error('OTLP export response aborted'), { code: 'ECONNRESET' }) }));
        res.resume();
        res.on('end', () => {
          const code = res.statusCode;
          if (code >= 200 && code < 300) return done({ ok: true });
          const ra = Number(res.headers['retry-after']);
          done({ ok: false, retryable: RETRYABLE_STATUS.has(code), retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 0, error: new Error(`OTLP export failed: HTTP ${code}`) });
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('OTLP export timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', (error) => done({ ok: false, retryable: true, error }));
      req.end(body);
    });
  }
  // The agent restarting or a brief network failure must not drop the batch: retry network errors and 408/429/5xx-
  // gateway responses with exponential backoff (250 ms .. 5 s, honouring Retry-After) for up to retrySeconds. New spans
  // keep queueing in the batch processor meanwhile. Retries stop once the exporter is shutting down.
  async send(body) {
    const deadline = Date.now() + this.retryMs;
    for (let attempt = 0; ; attempt++) {
      const r = await this.post(body);
      if (r.ok) return { code: SUCCESS };
      const delay = Math.max(r.retryAfterMs || 0, Math.min(5000, 250 * 2 ** attempt)) * (0.8 + Math.random() * 0.4);
      if (!r.retryable || this.stopped || Date.now() + delay > deadline) return { code: FAILED, error: r.error };
      await new Promise((res) => setTimeout(res, delay).unref?.());
    }
  }
  forceFlush() { return Promise.all([...this.pending]).then(() => undefined); }
  shutdown() { this.stopped = true; return this.forceFlush().then(() => this.agent.destroy()); }
}

module.exports = { DataCatSpanExporter, encode, Writer };
