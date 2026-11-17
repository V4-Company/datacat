import { pool } from "@workspace/db";

// Additive, versioned bootstrap for both a clean database and existing installations.
// Never use destructive schema push in production. Add future migrations to this array.
const migrations = [
  `
CREATE TABLE IF NOT EXISTS sessions (sid varchar PRIMARY KEY, sess jsonb NOT NULL, expire timestamp NOT NULL);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON sessions(expire);
CREATE TABLE IF NOT EXISTS users (
 id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
 profile_image_url varchar, org_id integer, role text NOT NULL DEFAULT 'member',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE TABLE IF NOT EXISTS orgs (id serial PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS invites (
 id serial PRIMARY KEY, email varchar NOT NULL, org_id integer NOT NULL, role text NOT NULL DEFAULT 'member',
 token varchar(64) UNIQUE, invited_by varchar, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys (
 id serial PRIMARY KEY, org_id integer NOT NULL, name text NOT NULL, key varchar(64) NOT NULL UNIQUE,
 kind text NOT NULL DEFAULT 'api', created_by varchar, revoked boolean NOT NULL DEFAULT false,
 last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_channels (
 id serial PRIMARY KEY, org_id integer NOT NULL, kind text NOT NULL, name text NOT NULL,
 config jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS metric_series (
 id serial PRIMARY KEY, org_id integer NOT NULL, metric text NOT NULL, host text NOT NULL DEFAULT '',
 tags text[] NOT NULL DEFAULT '{}', tags_key text NOT NULL, type text NOT NULL DEFAULT 'gauge',
 unit text, last_seen bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS metric_series_uniq ON metric_series(org_id,metric,host,tags_key);
CREATE INDEX IF NOT EXISTS metric_series_metric ON metric_series(org_id,metric);
CREATE TABLE IF NOT EXISTS metric_points (series_id integer NOT NULL, ts bigint NOT NULL, value double precision NOT NULL);
CREATE INDEX IF NOT EXISTS metric_points_series_ts ON metric_points(series_id,ts);
CREATE TABLE IF NOT EXISTS hosts (
 id serial PRIMARY KEY, org_id integer NOT NULL, name text NOT NULL, os text, platform text, agent_version text,
 tags text[] NOT NULL DEFAULT '{}', apps text[] NOT NULL DEFAULT '{}', meta jsonb NOT NULL DEFAULT '{}',
 first_seen bigint NOT NULL, last_seen bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hosts_uniq ON hosts(org_id,name);
CREATE TABLE IF NOT EXISTS logs (
 id bigserial PRIMARY KEY, org_id integer NOT NULL, ts bigint NOT NULL, status text NOT NULL DEFAULT 'info',
 service text NOT NULL DEFAULT '', host text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '',
 message text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}', attributes jsonb NOT NULL DEFAULT '{}', trace_id text
);
CREATE INDEX IF NOT EXISTS logs_org_ts ON logs(org_id,ts);
CREATE INDEX IF NOT EXISTS logs_trace ON logs(org_id,trace_id);
CREATE TABLE IF NOT EXISTS spans (
 id bigserial PRIMARY KEY, org_id integer NOT NULL, trace_id text NOT NULL, span_id text NOT NULL,
 parent_id text NOT NULL DEFAULT '0', service text NOT NULL, name text NOT NULL, resource text NOT NULL,
 type text NOT NULL DEFAULT '', env text NOT NULL DEFAULT '', host text NOT NULL DEFAULT '',
 start bigint NOT NULL, start_ms bigint NOT NULL, duration bigint NOT NULL, error integer NOT NULL DEFAULT 0,
 is_top_level integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}', metrics jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS spans_org_start ON spans(org_id,start_ms);
CREATE INDEX IF NOT EXISTS spans_trace ON spans(org_id,trace_id);
CREATE INDEX IF NOT EXISTS spans_service ON spans(org_id,service,start_ms);
CREATE TABLE IF NOT EXISTS dashboards (
 id varchar(16) PRIMARY KEY, org_id integer NOT NULL, title text NOT NULL, description text,
 layout_type text NOT NULL DEFAULT 'ordered', definition jsonb NOT NULL, author_id varchar, author_name text,
 created_at timestamptz NOT NULL DEFAULT now(), modified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS monitors (
 id serial PRIMARY KEY, org_id integer NOT NULL, name text NOT NULL, type text NOT NULL DEFAULT 'metric alert',
 query text NOT NULL, message text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}', priority integer,
 options jsonb NOT NULL DEFAULT '{}', overall_state text NOT NULL DEFAULT 'No Data', group_states jsonb NOT NULL DEFAULT '{}',
 muted_until bigint, last_triggered_at bigint, last_evaluated_at bigint, creator_id varchar, creator_name text,
 created_at timestamptz NOT NULL DEFAULT now(), modified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
 id bigserial PRIMARY KEY, org_id integer NOT NULL, ts bigint NOT NULL, title text NOT NULL,
 text text NOT NULL DEFAULT '', alert_type text NOT NULL DEFAULT 'info', source text NOT NULL DEFAULT 'datacat',
 monitor_id integer, group_key text, tags text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_org_ts ON events(org_id,ts);
CREATE INDEX IF NOT EXISTS events_monitor ON events(monitor_id);
CREATE TABLE IF NOT EXISTS notification_log (
 id bigserial PRIMARY KEY, org_id integer NOT NULL, ts bigint NOT NULL, monitor_id integer,
 channel text NOT NULL, status text NOT NULL, detail text, payload jsonb
);
`,
  // 2: persistent notification retries (status 'retrying' until delivered or given up)
  `
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS next_attempt_at bigint;
CREATE INDEX IF NOT EXISTS notification_log_retry ON notification_log(next_attempt_at) WHERE status = 'retrying';
`,
  // 3: weighted distribution points (Datadog Agent sketches store each bin as one value with its count); NULL means 1
  `
ALTER TABLE metric_points ADD COLUMN IF NOT EXISTS weight double precision;
`,
];

export async function migrateDatabase() {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(386428100)");
    await connection.query("CREATE TABLE IF NOT EXISTS datacat_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await connection.query("SELECT version FROM datacat_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (const [i, migration] of migrations.entries()) {
      if (applied.has(i + 1)) continue;
      await connection.query(migration);
      await connection.query("INSERT INTO datacat_migrations(version) VALUES ($1)", [i + 1]);
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

// Indexes on large tables are built with CREATE INDEX CONCURRENTLY after startup, so ingestion keeps flowing and
// startup is not delayed. An index left INVALID by an interrupted build is dropped and rebuilt.
const backgroundIndexes = [
  // exact @attribute:value log searches compile to JSON containment (query/search.ts)
  { name: "logs_attributes_gin", sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS logs_attributes_gin ON logs USING gin (attributes jsonb_path_ops)" },
];
export async function buildBackgroundIndexes(log: (msg: string, extra?: object) => void) {
  for (const ix of backgroundIndexes) {
    try {
      const { rows } = await pool.query("select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = $1", [ix.name]);
      if (rows[0]?.indisvalid) continue;
      if (rows.length) await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ix.name}`);
      const t = Date.now();
      log(`building index ${ix.name}`);
      await pool.query(ix.sql);
      log(`built index ${ix.name}`, { seconds: Math.round((Date.now() - t) / 1000) });
    } catch (e) {
      log(`index ${ix.name} failed`, { err: String(e) });
    }
  }
}
