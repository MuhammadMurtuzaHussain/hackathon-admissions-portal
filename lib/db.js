// Database access. With DATABASE_URL set (Neon, Supabase, any Postgres) this
// uses a normal `pg` connection pool. Without it, it falls back to PGlite
// (Postgres compiled to WASM, stored in ./.data/pg) so the app still runs
// locally with zero setup. The SQL is identical in both cases.
import path from 'node:path';
import fs from 'node:fs';

const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                   int PRIMARY KEY,
  name                 text NOT NULL,
  capacity             int  NOT NULL,
  seats_taken          int  NOT NULL DEFAULT 0,
  offer_ttl_hours      int  NOT NULL DEFAULT 72,
  applications_open    boolean NOT NULL DEFAULT true,
  submissions_deadline timestamptz NOT NULL,
  -- The database itself refuses seat 201, whatever the application code does.
  CONSTRAINT seats_within_capacity CHECK (seats_taken >= 0 AND seats_taken <= capacity)
);

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,      -- normalised: one person, one row
  email_raw  text NOT NULL,             -- what they typed; used for sending
  is_admin   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash text PRIMARY KEY,          -- only the hash is stored
  email      text NOT NULL,
  email_raw  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        int  NOT NULL REFERENCES events(id),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name       text NOT NULL,
  affiliation     text NOT NULL,
  role_type       text NOT NULL,
  track           text NOT NULL,
  experience      text NOT NULL,
  team_pref       text NOT NULL,
  github          text NOT NULL DEFAULT '',
  linkedin        text NOT NULL DEFAULT '',
  portfolio       text NOT NULL DEFAULT '',
  motivation      text NOT NULL,
  status          text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','waitlisted','offered','confirmed',
                                    'checked_in','rejected','withdrawn','expired')),
  holds_seat      boolean NOT NULL DEFAULT false,
  score           int  NOT NULL DEFAULT 0,
  score_detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer_expires_at timestamptz,
  waitlisted_at   timestamptz,
  decided_at      timestamptz,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One application per person per event: double clicks and "did I already
  -- apply?" resubmissions collapse into the same row.
  CONSTRAINT one_application_per_person UNIQUE (event_id, user_id),
  -- A seat can only be held in a seat-holding status, and vice versa.
  CONSTRAINT seat_matches_status CHECK (holds_seat = (status IN ('offered','confirmed','checked_in')))
);
CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status, score DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_app_id  uuid NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  team_name     text NOT NULL,
  project_name  text NOT NULL,
  tagline       text NOT NULL,
  description   text NOT NULL,
  track         text NOT NULL,
  repo_url      text NOT NULL,
  deck_url      text NOT NULL DEFAULT '',
  demo_url      text NOT NULL DEFAULT '',
  members       text NOT NULL DEFAULT '',
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             bigserial PRIMARY KEY,
  application_id uuid,
  actor          text NOT NULL,
  action         text NOT NULL,
  detail         text NOT NULL DEFAULT '',
  at             timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: an email row commits (or rolls back) together with the
-- state change that caused it. A worker delivers them via Resend/Postmark.
CREATE TABLE IF NOT EXISTS outbox (
  id       bigserial PRIMARY KEY,
  to_email text NOT NULL,
  subject  text NOT NULL,
  body     text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS sent_at    timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts   int  NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS result     text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS outbox_unsent_idx ON outbox (id) WHERE sent_at IS NULL;
ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Teams apply together and are admitted (or waitlisted) as one unit.
CREATE TABLE IF NOT EXISTS teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  join_code  text NOT NULL UNIQUE,
  track      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS applications_team_idx ON applications (team_id);

-- Soft per-track targets used to keep the room balanced. Capacity stays the only hard limit.
CREATE TABLE IF NOT EXISTS track_targets (
  track  text PRIMARY KEY,
  target int NOT NULL CHECK (target >= 0)
);
INSERT INTO track_targets (track, target) VALUES ('Builder', 90), ('Non-Builder', 70), ('Quant', 40)
ON CONFLICT (track) DO NOTHING;

-- Judging: one score sheet per judge per project.
ALTER TABLE users  ADD COLUMN IF NOT EXISTS is_judge boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS judging_open boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS scores (
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  judge_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  technical     int NOT NULL CHECK (technical  BETWEEN 1 AND 10),
  innovation    int NOT NULL CHECK (innovation BETWEEN 1 AND 10),
  product       int NOT NULL CHECK (product    BETWEEN 1 AND 10),
  potential     int NOT NULL CHECK (potential  BETWEEN 1 AND 10),
  pitch         int NOT NULL CHECK (pitch      BETWEEN 1 AND 10),
  note          text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, judge_id)
);

INSERT INTO events (id, name, capacity, submissions_deadline)
VALUES (1, 'HackBelfast 2027', 200, now() + interval '120 days')
ON CONFLICT (id) DO NOTHING;
`;

async function init() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    // Create or upgrade the schema once per version; the advisory lock stops
    // two cold-starting instances from running the DDL at the same time.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(727001)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_meta (v int NOT NULL)');
      const { rows } = await c.query('SELECT max(v) AS v FROM schema_meta');
      if ((rows[0].v ?? 0) < SCHEMA_VERSION) {
        await c.query(SCHEMA);
        await c.query('INSERT INTO schema_meta (v) VALUES ($1)', [SCHEMA_VERSION]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    return { pool };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(process.cwd(), '.data', 'pg');
  fs.mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  await lite.exec(SCHEMA);
  return { lite };
}

function getDb() {
  if (!globalThis.__hbDb) {
    globalThis.__hbDb = init().catch((e) => {
      globalThis.__hbDb = null; // let the next request retry instead of caching the failure
      throw e;
    });
  }
  return globalThis.__hbDb;
}

/** Run one statement outside a transaction. */
export async function q(sql, params = []) {
  const db = await getDb();
  return (await (db.pool || db.lite).query(sql, params)).rows;
}

// Postgres aborts one side of a deadlock or serialization clash; retrying it is the standard remedy.
const RETRYABLE = new Set(['40P01', '40001']);

/** Run `fn` inside one transaction. `fn` receives `{ q }`; throw to roll back. */
export async function tx(fn) {
  const db = await getDb();
  if (db.lite) {
    return db.lite.transaction(async (t) => fn({ q: async (sql, params = []) => (await t.query(sql, params)).rows }));
  }
  for (let attempt = 1; ; attempt++) {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn({ q: async (sql, params = []) => (await c.query(sql, params)).rows });
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (!(RETRYABLE.has(e.code) && attempt < 4)) throw e;
    } finally {
      c.release();
    }
  }
}
