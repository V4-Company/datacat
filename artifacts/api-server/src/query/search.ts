// Search syntax -> SQL WHERE fragment (used by Log Explorer, Trace Explorer, log monitors)

export type FieldResolver = (
  key: string,
  isAttr: boolean,
  b: SqlBuilder,
) => {
  kind: "col" | "json" | "tags" | "num";
  sql: string;
  numSql?: string;
  transformNum?: (n: number) => number;
  valueMap?: Record<string, number>;
  contain?: { col: string; key: string };
} | null;

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push(c);
      i++;
      continue;
    }
    let j = i;
    let q = false;
    let br = 0;
    while (j < s.length) {
      const d = s[j];
      if (d === '"' && s[j - 1] !== "\\") q = !q;
      else if (!q && d === "[") br++;
      else if (!q && d === "]") br--;
      else if (!q && br === 0 && (/\s/.test(d) || d === ")" || (d === "(" && s[j - 1] !== ":"))) break;
      else if (!q && br === 0 && d === "(" && s[j - 1] === ":") {
        // key:(a OR b) -> keep as one token including group
        let depth = 0;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        break;
      }
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
function likeFor(v: string) {
  return v.includes("*") ? esc(v).replace(/\*/g, "%") : esc(v);
}

export class SqlBuilder {
  params: any[];
  constructor(startParams: any[] = []) {
    this.params = [...startParams];
  }
  p(v: any) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
}

export function compileSearch(query: string, resolve: FieldResolver, b: SqlBuilder, textCol: string): string {
  const toks = tokenize(query.trim());
  let p = 0;
  const peek = () => toks[p];
  function or(): string {
    const parts = [and()];
    while (peek() === "OR") {
      p++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  }
  function and(): string {
    const parts: string[] = [];
    while (peek() !== undefined && peek() !== ")" && peek() !== "OR") {
      if (peek() === "AND") {
        p++;
        continue;
      }
      parts.push(unary());
    }
    return parts.length ? (parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`) : "TRUE";
  }
  function unary(): string {
    let t = toks[p++];
    if (t === "NOT") return `NOT (${unary()})`;
    if (t === "(") {
      const r = or();
      if (peek() === ")") p++;
      return r;
    }
    let neg = false;
    if (t.startsWith("-") && t.length > 1) {
      neg = true;
      t = t.slice(1);
    }
    const r = term(t);
    return neg ? `NOT (${r})` : r;
  }
  function term(t: string): string {
    if (t === "*") return "TRUE";
    const m = /^(@?)([A-Za-z0-9_.\-]+):(.*)$/s.exec(t);
    if (!m || t.startsWith('"')) {
      const v = t.replace(/^"|"$/g, "");
      return `${textCol} ILIKE ${b.p("%" + likeFor(v).replace(/^%|%$/g, "") + "%")}`;
    }
    const isAttr = m[1] === "@";
    const key = m[2];
    let val = m[3];
    // grouped values key:(a OR b); each value resolves the field itself, so nothing is bound here
    if (val.startsWith("(") && val.endsWith(")")) {
      const inner = val
        .slice(1, -1)
        .split(/\s+OR\s+|\s+/)
        .filter((x) => x && x !== "OR");
      return `(${inner.map((v) => term(`${m[1]}${key}:${v}`)).join(" OR ")})`;
    }
    const f = resolve(key, isAttr, b);
    if (!f) return "FALSE";
    val = val.replace(/^"|"$/g, "");
    // numeric comparisons / ranges
    const cmp = /^(>=|<=|>|<)(-?[\d.]+)([a-z]*)$/.exec(val);
    const range = /^\[(-?[\d.]+)([a-z]*)\s+TO\s+(-?[\d.]+)([a-z]*)\]$/i.exec(val);
    if (cmp || range) {
      const num = f.numSql ?? safeNumber(f.sql);
      const conv = (n: string, unit: string) => {
        let x = Number(n);
        if (f.transformNum) x = f.transformNum(x);
        if (unit) x = (x * ({ ns: 1, us: 1e3, ms: 1e6, s: 1e9, m: 6e10 }[unit] ?? 1)) / (f.transformNum ? f.transformNum(1) : 1);
        return x;
      };
      if (cmp) return `${num} ${cmp[1]} ${b.p(conv(cmp[2], cmp[3]))}`;
      return `${num} BETWEEN ${b.p(conv(range![1], range![2]))} AND ${b.p(conv(range![3], range![4]))}`;
    }
    if (f.kind === "tags") {
      return `EXISTS (SELECT 1 FROM unnest(${f.sql}) _t WHERE _t ILIKE ${b.p(likeFor(key) + ":" + likeFor(val))})`;
    }
    if (f.kind === "num") {
      if (val === "*") return `${f.sql} IS NOT NULL`;
      const mapped = f.valueMap?.[val.toLowerCase()];
      return `${f.sql} = ${b.p(mapped ?? Number(val))}`;
    }
    if (f.kind === "json" && f.contain && val !== "*" && !val.includes("*")) {
      // Exact attribute match as JSON containment so the GIN index (logs_attributes_gin) serves it. Matches the value as
      // typed or lowercased, flat ("customer.id") or nested ({"customer":{"id":..}}) keys, and numbers.
      const { col, key: k } = f.contain;
      const nest = (v: unknown) =>
        k
          .split(".")
          .reverse()
          .reduce<unknown>((acc, part) => ({ [part]: acc }), v);
      const values: unknown[] = [...new Set([val, val.toLowerCase()])];
      if (/^-?\d+(\.\d+)?$/.test(val)) values.push(Number(val));
      const docs = values.flatMap((v) => (k.includes(".") ? [JSON.stringify({ [k]: v }), JSON.stringify(nest(v))] : [JSON.stringify({ [k]: v })]));
      return `(${docs.map((d) => `${col} @> ${b.p(d)}::jsonb`).join(" OR ")})`;
    }
    if (val === "*") return `COALESCE(${f.sql}, '') <> ''`;
    if (val.includes("*")) return `${f.sql} ILIKE ${b.p(likeFor(val))}`;
    // service and env are stored lowercase (normalized at intake), so compare exactly: this lets the
    // (org_id, service, time) indexes serve the search. Other columns stay case-insensitive.
    if (f.sql === "service" || f.sql === "env") return `${f.sql} = ${b.p(val.toLowerCase())}`;
    return `lower(${f.sql}) = lower(${b.p(val)})`;
  }
  const sql = or();
  return sql;
}

/** Nested JSON lookup with the key bound as a parameter (never spliced into SQL). */
/** A text expression as a number; values that are not numbers become NULL instead of failing the query. */
export function safeNumber(x: string) {
  return `(CASE WHEN (${x}) ~ '^\\s*-?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][-+]?[0-9]+)?\\s*$' THEN (${x})::double precision END)`;
}

export function jsonPath(col: string, key: string, b: SqlBuilder) {
  return `${col} #>> ${b.p(key.split("."))}::text[]`;
}

export const logResolver: FieldResolver = (key, isAttr, b) => {
  if (!isAttr) {
    if (["service", "host", "source", "status"].includes(key)) return { kind: "col", sql: key };
    if (key === "trace_id") return { kind: "col", sql: "trace_id", normalize: true } as any;
    return { kind: "tags", sql: "tags" };
  }
  // sql is built on first use: an exact match uses the containment form below and never reads it, and Postgres rejects
  // bound parameters that the query does not reference ("could not determine data type of parameter").
  let sql: string | undefined;
  return {
    kind: "json",
    get sql() {
      return (sql ??= `COALESCE(${jsonPath("attributes", key, b)}, attributes ->> ${b.p(key)}::text)`);
    },
    contain: { col: "attributes", key },
  };
};

export const spanResolver: FieldResolver = (key, isAttr, b) => {
  if (!isAttr) {
    if (key === "service" || key === "env" || key === "host") return { kind: "col", sql: key };
    if (key === "resource_name" || key === "resource") return { kind: "col", sql: "resource" };
    if (key === "operation_name" || key === "name") return { kind: "col", sql: "name" };
    if (key === "trace_id") return { kind: "col", sql: "trace_id" };
    if (key === "span_id") return { kind: "col", sql: "span_id" };
    // plain "error = 1" so status:error searches can use the spans_errors partial index
    if (key === "status") return { kind: "num", sql: "error", valueMap: { error: 1, ok: 0, info: 0 } };
    if (key === "type") return { kind: "col", sql: "type" };
    return { kind: "col", sql: `meta ->> ${b.p(key)}::text` };
  }
  if (key === "duration") return { kind: "num", sql: "duration", numSql: "duration::double precision" };
  const k = `${b.p(key)}::text`;
  return { kind: "json", sql: `COALESCE(meta ->> ${k}, metrics ->> ${k})`, numSql: safeNumber(`COALESCE(metrics ->> ${k}, meta ->> ${k})`) };
};
