/**
 * Sensitive-data redaction at intake, applied to every log and span before it is stored (all intake paths: OTLP,
 * Datadog Agent and tracer intake, agent and agentless). Values are replaced in place with "[REDACTED:<kind>]".
 *
 * On by default (high-confidence patterns, low false-positive risk):
 *   card       payment card numbers (13–19 digits, spaces/dashes allowed) that pass the Luhn check
 *   bearer     "Bearer <token>" / "Basic <credentials>" values
 *   secret     key=value / key: value pairs whose key looks secret (password, passwd, pwd, secret, token, api_key, apikey)
 *   aws_key    AWS access key IDs (AKIA/ASIA...)
 *   private_key  PEM private key blocks
 *   jwt        JSON Web Tokens
 *   key name   attributes whose *name* looks secret (password, secret, token, api_key, authorization, cookie, ...) are
 *              masked entirely, whatever their value
 * Opt-in / configuration (environment):
 *   DATACAT_REDACTION=off             disable all redaction
 *   DATACAT_REDACT_EMAILS=true        also mask email addresses
 *   DATACAT_REDACT_PATTERNS='re1;;re2'   extra regular expressions (JavaScript syntax), replaced with [REDACTED:custom]
 *   DATACAT_REDACT_KEYS='ssn,dob'     extra attribute names to mask entirely (case-insensitive substring match)
 */
const env = process.env;
const enabled = String(env.DATACAT_REDACTION ?? "on").toLowerCase() !== "off";
const redactEmails = String(env.DATACAT_REDACT_EMAILS ?? "false").toLowerCase() === "true";
const SECRET_KEY_WORDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "cookie",
  "private_key",
  "client_secret",
  "access_key",
  ...String(env.DATACAT_REDACT_KEYS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];
const custom = String(env.DATACAT_REDACT_PATTERNS ?? "")
  .split(";;")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s, "g"));

const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const BEARER = /\b(Bearer|Basic)\s+([A-Za-z0-9\-._~+/]{4,}=*)/gi;
const SECRET_PAIR = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)([^\s"'&,;]{3,})/gi;
const AWS_KEY = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Cheap pre-check: skip strings that cannot match any rule (most log lines and span attributes).
const MAYBE = /\d[ -]?\d[ -]?\d[ -]?\d|bearer|basic|pass|pwd|secret|token|key|AKIA|ASIA|PRIVATE KEY|eyJ|@/i;

function luhn(digits: string): boolean {
  let sum = 0,
    alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export const redactionStats = { values: 0, redactions: 0 };

/**
 * Masks PEM private key blocks ("-----BEGIN ... PRIVATE KEY-----" to the next "-----END ... PRIVATE KEY-----") with
 * plain string searches, so the cost stays linear however many BEGIN markers a value contains.
 */
function maskPrivateKeys(s: string): string {
  const HEAD = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const TAIL = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
  let out = "";
  let pos = 0;
  for (;;) {
    HEAD.lastIndex = pos;
    const b = HEAD.exec(s);
    if (!b) break;
    TAIL.lastIndex = b.index + b[0].length;
    const e = TAIL.exec(s);
    if (!e) break; // no END after this BEGIN, so none after any later BEGIN either
    out += s.slice(pos, b.index) + "[REDACTED:private_key]";
    pos = e.index + e[0].length;
  }
  return pos === 0 ? s : out + s.slice(pos);
}

// "Basic <base64 of user:password>": short values count only when they decode to a user:password pair, so ordinary
// phrases such as "Basic plan" are left alone.
function isCredential(scheme: string, token: string): boolean {
  const bare = token.replace(/=+$/, "");
  if (bare.length >= 8) return true;
  if (scheme.toLowerCase() !== "basic") return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return false;
  return /^[\x20-\x7e]*:[\x20-\x7e]*$/.test(Buffer.from(token, "base64").toString("latin1"));
}

export function redactString(s: string): string {
  if (!enabled || typeof s !== "string" || s.length < 6) return s;
  if (!MAYBE.test(s) && !custom.length) return s;
  let out = s;
  const before = out;
  out = maskPrivateKeys(out);
  out = out.replace(JWT, "[REDACTED:jwt]");
  out = out.replace(BEARER, (m, scheme, token) => (isCredential(scheme, token) ? `${scheme} [REDACTED:bearer]` : m));
  out = out.replace(AWS_KEY, "[REDACTED:aws_key]");
  out = out.replace(SECRET_PAIR, (_m, k, sep) => `${k}${sep}[REDACTED:secret]`);
  out = out.replace(CARD, (m) => {
    const d = m.replace(/[ -]/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d) ? "[REDACTED:card]" : m;
  });
  if (redactEmails) out = out.replace(EMAIL, "[REDACTED:email]");
  for (const re of custom) out = out.replace(re, "[REDACTED:custom]");
  if (out !== before) redactionStats.redactions++;
  return out;
}

function secretKey(k: string): boolean {
  const l = k.toLowerCase();
  return (
    SECRET_KEY_WORDS.some((w) => l.includes(w)) && !/(_count|_length|\.count|tokens_used|token_count|prompt_tokens|completion_tokens|total_tokens)$/.test(l)
  );
}

/** Redacts string values (recursively) and masks values of secret-named keys. Mutates and returns the object. */
export function redactObject<T extends Record<string, any>>(o: T): T {
  if (!enabled || !o) return o;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string") (o as any)[k] = secretKey(k) && v.length ? "[REDACTED:key]" : redactString(v);
    else if (secretKey(k) && (typeof v === "number" || typeof v === "bigint" || (v && typeof v === "object"))) (o as any)[k] = "[REDACTED:key]";
    else if (v && typeof v === "object") redactObject(v);
  }
  return o;
}

export function redactLog<L extends { message: string; attributes: Record<string, any>; tags?: string[]; service?: string }>(l: L): L {
  if (!enabled) return l;
  l.message = redactString(l.message);
  if (typeof l.service === "string") l.service = redactString(l.service);
  redactObject(l.attributes);
  if (l.tags)
    l.tags = l.tags.map((t) => {
      const i = t.indexOf(":");
      return i > 0 && secretKey(t.slice(0, i)) ? `${t.slice(0, i)}:[REDACTED:key]` : redactString(t);
    });
  return l;
}

export function redactSpan<S extends { resource: string; meta?: Record<string, string>; name?: string; service?: string }>(s: S): S {
  if (!enabled) return s;
  s.resource = redactString(s.resource);
  if (typeof s.name === "string") s.name = redactString(s.name);
  if (typeof s.service === "string") s.service = redactString(s.service);
  if (s.meta) redactObject(s.meta);
  return s;
}

export const redactionEnabled = enabled;
