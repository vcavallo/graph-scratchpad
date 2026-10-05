// Sync server core. Keeps, for every node field, the newest value by hybrid
// logical clock (src/db/hlc.ts) and a sequence number of when it last
// changed here. Devices push their unsent changes and pull everything with a
// sequence number above their cursor. Plain JS on Node's built-in SQLite, so
// it runs straight from a release directory; the tests import it too.

const NODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FIELD_RE = /^[a-z_]{1,32}$/
const MAX_BATCH = 5000
const MAX_VALUE = 200_000

export class SyncError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export class SyncServer {
  #db
  #listeners = new Set()

  /** db: a node:sqlite DatabaseSync. */
  constructor(db, { uuid = () => crypto.randomUUID() } = {}) {
    this.#db = db
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS fields (
        node   TEXT NOT NULL,
        field  TEXT NOT NULL,
        value  TEXT,
        hlc    TEXT NOT NULL,
        seq    INTEGER NOT NULL,
        device TEXT NOT NULL,
        PRIMARY KEY (node, field)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS fields_seq ON fields(seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `)
    // Identifies this database. Devices that synced with a different one
    // (say, after the server's data was lost) send everything again.
    if (!this.#meta('epoch')) this.#setMeta('epoch', uuid())
  }

  #meta(key) {
    return this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  #setMeta(key, value) {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  get epoch() {
    return this.#meta('epoch')
  }

  get seq() {
    return Number(this.#meta('seq') ?? 0)
  }

  info() {
    const fields = this.#db.prepare('SELECT count(*) AS c, count(DISTINCT node) AS n FROM fields').get()
    return { epoch: this.epoch, seq: this.seq, nodes: fields.n, fields: fields.c }
  }

  /** Called with the new sequence number whenever something changes. Returns an unsubscribe function. */
  onChange(fn) {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  /**
   * One round trip: store the device's changes that are newer than what we
   * have, then return up to `limit` changes after `since` that came from
   * other devices.
   */
  sync({ device, since = 0, changes = [], limit = 2000 } = {}) {
    if (typeof device !== 'string' || !device || device.length > 64) throw new SyncError('Missing device id')
    if (!Array.isArray(changes) || changes.length > MAX_BATCH) throw new SyncError('Bad changes')
    since = Number.isSafeInteger(since) && since > 0 ? since : 0
    limit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), MAX_BATCH) : 2000

    this.write(changes, device)
    const rows = this.#db
      .prepare('SELECT node, field, value, hlc, seq, device FROM fields WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(since, limit)
    const out = []
    for (const r of rows) {
      if (r.device === device) continue // its own change: it has it
      out.push({ n: r.node, f: r.field, v: JSON.parse(r.value), h: r.hlc })
    }
    const seq = this.seq
    return {
      epoch: this.epoch,
      cursor: rows.length ? rows[rows.length - 1].seq : Math.min(since, seq),
      changes: out,
      more: rows.length === limit,
      accepted: this.#lastAccepted,
    }
  }

  #lastAccepted = 0

  /** Store changes that are newer than what we have (the server's own, too). Returns how many were. */
  write(changes, device) {
    const db = this.#db
    let accepted = 0
    let seq = this.seq
    db.exec('BEGIN IMMEDIATE')
    try {
      const get = db.prepare('SELECT hlc FROM fields WHERE node = ? AND field = ?')
      const put = db.prepare(
        'INSERT OR REPLACE INTO fields (node, field, value, hlc, seq, device) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const c of changes) {
        if (!c || typeof c.n !== 'string' || !NODE_RE.test(c.n)) continue
        if (typeof c.f !== 'string' || !FIELD_RE.test(c.f)) continue
        if (typeof c.h !== 'string' || !c.h || c.h.length > 80) continue
        const value = JSON.stringify(c.v ?? null)
        if (value.length > MAX_VALUE) continue
        const cur = get.get(c.n, c.f)
        if (cur && cur.hlc >= c.h) continue
        put.run(c.n, c.f, value, c.h, ++seq, device)
        accepted++
      }
      if (accepted) this.#setMeta('seq', String(seq))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    this.#lastAccepted = accepted
    if (accepted) for (const fn of this.#listeners) fn(seq, device)
    return accepted
  }

  /** The current value of one field, or undefined. */
  field(node, field) {
    const r = this.#db.prepare('SELECT value FROM fields WHERE node = ? AND field = ?').get(node, field)
    return r ? JSON.parse(r.value) : undefined
  }

  /** [node, value] for every node that has this field. */
  allOf(field) {
    return this.#db
      .prepare('SELECT node, value FROM fields WHERE field = ?')
      .all(field)
      .map((r) => [r.node, JSON.parse(r.value)])
  }

  /** The newest clock recorded for a field across all nodes. */
  maxHlc(field) {
    return this.#db.prepare('SELECT max(hlc) AS h FROM fields WHERE field = ?').get(field)?.h ?? null
  }

  /** Write a consistent copy of the database to `path`. */
  backup(path) {
    this.#db.prepare('VACUUM INTO ?').run(path)
  }
}
