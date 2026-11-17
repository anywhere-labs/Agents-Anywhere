import type { DatabaseSync } from 'node:sqlite'

/**
 * Schema migrations (04-connector.md §6.5). `meta.schema_version` counts them; each runs in its own
 * transaction. A store written by newer code (higher version) is opened read-only, never migrated down.
 * A migration that a previous release cannot read must say so in `breaksPrevious` and in the release notes.
 */
export interface Migration {
  readonly version: number
  readonly breaksPrevious: boolean
  readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    breaksPrevious: false,
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  runtime_type TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  external_session_id TEXT,
  cwd TEXT,
  native_title TEXT,
  status TEXT NOT NULL,
  source_availability TEXT NOT NULL,
  head_seq INTEGER NOT NULL,
  reset_seq INTEGER NOT NULL,
  active_turn_json TEXT,
  latest_turn_end_seq INTEGER,
  plan_state TEXT NOT NULL DEFAULT 'none',
  goal_state TEXT NOT NULL DEFAULT 'none',
  takeover INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  last_summary_json TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sessions_native ON sessions(runtime_id, external_session_id) WHERE external_session_id IS NOT NULL;

CREATE TABLE timeline_items (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  order_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  role TEXT,
  client_message_id TEXT,
  item_time TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE INDEX ti_order ON timeline_items(session_id, order_seq);
CREATE INDEX ti_updated ON timeline_items(session_id, updated_seq);
CREATE INDEX ti_client_message ON timeline_items(session_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- Deletions tick the clock too; the protocol has no delete event, so a range holding one needs a snapshot.
CREATE TABLE timeline_tombstones (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE INDEX tt_updated ON timeline_tombstones(session_id, updated_seq);

CREATE TABLE deliveries (
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  state TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  native_ref TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, client_message_id)
);
CREATE INDEX deliveries_state ON deliveries(state);

CREATE TABLE queues (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  paused INTEGER NOT NULL,
  items_json TEXT NOT NULL
);

CREATE TABLE interactions (
  session_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  response_id TEXT,
  resolution TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (session_id, notice_id)
);
CREATE INDEX interactions_active ON interactions(state) WHERE state IN ('open', 'responding');

CREATE TABLE plan_documents (
  session_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  source_turn_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, plan_id, revision)
);

CREATE TABLE planning_state (
  session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE goal_state (
  session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);

-- Durable command receipts by commandId (Commands/status; command.result in the outbox).
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  session_id TEXT,
  input_digest TEXT,
  outcome TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE blobs (
  blob_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Messages the Server must receive (04-connector.md §7); deleted once acknowledged.
CREATE TABLE outbox (
  oid INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  session_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE runtime_kv (
  runtime_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (runtime_id, key)
);
`,
  },
  {
    // The project a client filed a session it created through a secure channel under (SessionSummary.projectId).
    version: 2,
    breaksPrevious: false,
    sql: 'ALTER TABLE sessions ADD COLUMN project_id TEXT;',
  },
  {
    // What an accepted delivery still has to hand to the Runtime, kept until it leaves `accepted`, so a restart
    // in between can still send it (the Runtime never saw it, so this is not a resend of an unknown outcome).
    version: 3,
    breaksPrevious: false,
    sql: 'ALTER TABLE deliveries ADD COLUMN pending_json TEXT;',
  },
  {
    // `LinkWelcome.seqFloors` of sessions this store does not have yet (06-protocols.md §3.1). A session created
    // later under the same id (a native rescan after a reinstall, a deleted store or a v2 upgrade) starts its clock
    // above the floor instead of at 0, so clients never take its new items for old ones.
    version: 4,
    breaksPrevious: false,
    sql: 'CREATE TABLE IF NOT EXISTS seq_floors (session_id TEXT PRIMARY KEY, seq_floor INTEGER NOT NULL);',
  },
  {
    // Which timeline items point at which blob (the item's `blobRefs`), so a blob nothing points at any more
    // (an older version of an edited or replaced item, a deleted item) is deleted with its file. Filled from the
    // items already stored.
    version: 5,
    breaksPrevious: false,
    sql: `
CREATE TABLE IF NOT EXISTS blob_refs (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id, blob_id)
);
CREATE INDEX IF NOT EXISTS blob_refs_blob ON blob_refs(blob_id);
INSERT OR IGNORE INTO blob_refs(session_id, item_id, blob_id)
  SELECT t.session_id, t.item_id, json_extract(r.value, '$.blobId')
  FROM timeline_items t, json_each(t.payload_json, '$.blobRefs') r
  WHERE json_type(t.payload_json, '$.blobRefs') = 'array' AND json_extract(r.value, '$.blobId') IS NOT NULL;
`,
  },
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function schemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (table === undefined) return 0
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  return row === undefined ? 0 : Number(row.value)
}

/** Runs the missing migrations; returns the version the store is at afterwards. */
export function migrate(db: DatabaseSync, at: string): number {
  let current = schemaVersion(db)
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(migration.version))
      if (migration.version === 1) {
        db.prepare("INSERT INTO meta(key, value) VALUES ('created_at', ?)").run(at)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    current = migration.version
  }
  return current
}
