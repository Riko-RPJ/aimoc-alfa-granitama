CREATE SCHEMA IF NOT EXISTS aimoc_alfa_ops;
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.operation (
 id integer PRIMARY KEY CHECK (id=1), revision bigint NOT NULL DEFAULT 1,
 document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.users (
 id text PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','stock','jetty')),
 crusher_ids text[] NOT NULL DEFAULT '{}', jetty_ids text[] NOT NULL DEFAULT '{}',
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES aimoc_alfa_ops.users(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.login_limits (
 key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, window_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.actions (
 actor_id text NOT NULL, request_id text NOT NULL, payload_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS aimoc_alfa_ops.evidence (
 id text PRIMARY KEY, actor_id text NOT NULL, content bytea NOT NULL, content_type text NOT NULL,
 filename text NOT NULL, sha256 text NOT NULL, size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON aimoc_alfa_ops.sessions(expires_at);
CREATE INDEX IF NOT EXISTS actions_date_idx ON aimoc_alfa_ops.actions(created_at);
