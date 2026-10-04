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
  {
    // Sync. sync_clock holds, per node and field, the hybrid-logical-clock
    // time of its latest change (see hlc.ts) and whether that change still has
    // to be sent (local = 1). Triggers keep it up to date on every write, so
    // the Store's methods don't have to know about sync. 'pos' is a node's
    // place: its parent and sort key (or, for roots, nodes.sort_key). Link
    // edges aren't tracked: they're rebuilt from the text. hlc_now() is
    // registered by the Store. purged marks a node emptied by "empty trash";
    // its row stays so the deletion syncs.
    version: 5,
    sql: `
      ALTER TABLE nodes ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE sync_clock (
        node   TEXT NOT NULL,
        field  TEXT NOT NULL,
        hlc    TEXT NOT NULL,
        local  INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (node, field)
      ) WITHOUT ROWID;
      CREATE INDEX sync_clock_local ON sync_clock(node) WHERE local = 1;

      -- Everything that already exists is sent on the first sync.
      INSERT INTO sync_clock (node, field, hlc, local)
        SELECT n.id, f.value, hlc_now(), 1 FROM nodes n,
          json_each('["kind","text","done","collapsed","deleted_at","numbered","task","purged","pos","created_at"]') f;

      CREATE TRIGGER sync_nodes_insert AFTER INSERT ON nodes BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local)
          SELECT new.id, value, hlc_now(), 1 FROM
            json_each('["kind","text","done","collapsed","deleted_at","numbered","task","purged","pos","created_at"]');
      END;
      CREATE TRIGGER sync_nodes_delete AFTER DELETE ON nodes BEGIN
        DELETE FROM sync_clock WHERE node = old.id;
      END;
      CREATE TRIGGER sync_nodes_kind AFTER UPDATE OF kind ON nodes WHEN old.kind IS NOT new.kind BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'kind', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_text AFTER UPDATE OF text ON nodes WHEN old.text IS NOT new.text BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'text', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_done AFTER UPDATE OF done ON nodes WHEN old.done IS NOT new.done BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'done', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_collapsed AFTER UPDATE OF collapsed ON nodes WHEN old.collapsed IS NOT new.collapsed BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'collapsed', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_deleted_at AFTER UPDATE OF deleted_at ON nodes WHEN old.deleted_at IS NOT new.deleted_at BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'deleted_at', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_numbered AFTER UPDATE OF numbered ON nodes WHEN old.numbered IS NOT new.numbered BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'numbered', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_task AFTER UPDATE OF task ON nodes WHEN old.task IS NOT new.task BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'task', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_purged AFTER UPDATE OF purged ON nodes WHEN old.purged IS NOT new.purged BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'purged', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_nodes_root_key AFTER UPDATE OF sort_key ON nodes WHEN old.sort_key IS NOT new.sort_key BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.id, 'pos', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_edges_insert AFTER INSERT ON edges WHEN new.type = 'child' BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.dst, 'pos', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_edges_update AFTER UPDATE ON edges
        WHEN new.type = 'child' AND (old.src IS NOT new.src OR old.sort_key IS NOT new.sort_key) BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local) VALUES (new.dst, 'pos', hlc_now(), 1);
      END;
      CREATE TRIGGER sync_edges_delete AFTER DELETE ON edges WHEN old.type = 'child' BEGIN
        INSERT OR REPLACE INTO sync_clock (node, field, hlc, local)
          SELECT old.dst, 'pos', hlc_now(), 1 WHERE EXISTS (SELECT 1 FROM nodes WHERE id = old.dst);
      END;
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
