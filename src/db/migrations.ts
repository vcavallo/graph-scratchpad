import type { SqlDb } from './sql'

// Numbered schema migrations, keyed on meta.schema_version.
// Never edit a migration that has shipped; add a new one.

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE nodes (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'item',
        text        TEXT NOT NULL DEFAULT '',
        done        INTEGER NOT NULL DEFAULT 0,
        collapsed   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );

      CREATE TABLE edges (
        id          TEXT PRIMARY KEY,
        src         TEXT NOT NULL REFERENCES nodes(id),
        dst         TEXT NOT NULL REFERENCES nodes(id),
        type        TEXT NOT NULL,
        sort_key    TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX edges_src ON edges(src, type, sort_key);
      CREATE INDEX edges_dst ON edges(dst, type);
      CREATE UNIQUE INDEX one_parent ON edges(dst) WHERE type = 'child';

      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `,
  },
  {
    // Root nodes (pads) have no incoming child edge to carry their order, so
    // they get their own fractional sort key. NULL for everything else.
    version: 2,
    sql: `
      ALTER TABLE nodes ADD COLUMN sort_key TEXT;
      CREATE INDEX nodes_kind ON nodes(kind, deleted_at);
    `,
  },
  {
    // 1 = this node's children are a numbered (ordered) list, not bullets.
    version: 3,
    sql: `ALTER TABLE nodes ADD COLUMN numbered INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // 1 = this item is a to-do (has a checkbox); 0 = a plain bullet. Only items
    // can be to-dos, and only to-dos can be done. Existing items were all
    // checkable, so they start as to-dos.
    version: 4,
    sql: `
      ALTER TABLE nodes ADD COLUMN task INTEGER NOT NULL DEFAULT 0;
      UPDATE nodes SET task = 1 WHERE kind = 'item';
      UPDATE nodes SET done = 0 WHERE kind <> 'item';
    `,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function schemaVersion(db: SqlDb): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
  return row ? Number(row.value) : 0
}

/** Bring the database up to the latest schema. Each migration is its own transaction. */
export function migrate(db: SqlDb): number {
  let current = schemaVersion(db)
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.tx(() => {
      db.exec(m.sql)
      db.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(m.version)])
    })
    current = m.version
  }
  return current
}
